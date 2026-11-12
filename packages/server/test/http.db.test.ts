import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { listen } from "../src/listen.js";
import { signInFirstAdmin, startServer, type TestServer } from "./support.js";

const postgres = usePostgresFixture();

/** Over a real socket: the other tests call the app directly, which skips what the HTTP library does to requests and responses. */
describe("the server on a real port", () => {
  let server: TestServer;
  let http: ReturnType<typeof listen>;
  let origin = "";
  let token = "";
  const auth = () => ({ authorization: `Bearer ${token}` });
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...auth(), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, payload: await response.clone().json().catch(() => null) as { data?: any; error?: any } | null };
  };

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    const admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
    token = (await admin.json("POST", "/api/v1/account/tokens", { name: "真实端口", scopes: ["read", "write"] })).data.token;
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port: 0 }, info => {
        origin = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
    expect((http.address() as AddressInfo).port).toBeGreaterThan(0);
  });
  afterAll(async () => {
    await new Promise(done => http.close(done));
    await server.close();
  });

  it("documents exactly the routes it adds to the shared API", () => {
    const spec = parse(readFileSync(join(import.meta.dirname, "../../../docs/api/openapi.yaml"), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const documented = Object.entries(spec.paths).filter(([, item]) => item["x-served-by"] === "server").flatMap(([path, item]) =>
      ["get", "post", "put", "patch", "delete"].filter(method => item[method]).map(method => `${method.toUpperCase()} ${path}`)).sort();
    const served = server.app.routes.filter(route => route.method !== "ALL" && route.path.startsWith("/api/v1/") && !route.path.includes("*"))
      .map(route => `${route.method} ${route.path.slice("/api/v1".length).replace(/:([a-z]+)/gu, "{$1}")}`);
    expect(documented).toEqual([...new Set(served)].sort());
  });

  it("keeps connections long enough that a load balancer never finds one just closed", () => {
    expect(http.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(http.headersTimeout).toBeGreaterThan(http.keepAliveTimeout);
  });

  it("while shutting down, answers but moves clients off the connection, and says it is not ready", async () => {
    const asked = async (path: string) => {
      const response = await fetch(`${origin}${path}`);
      await response.arrayBuffer();
      return response;
    };
    expect((await asked("/readyz")).status).toBe(200);
    expect((await asked("/healthz")).headers.get("connection")).not.toBe("close");
    const second = await new Promise<ReturnType<typeof listen>>(done => {
      const made = listen(server.app, { hostname: "127.0.0.1", port: 0 }, () => done(made));
    });
    const address = `http://127.0.0.1:${(second.address() as AddressInfo).port}`;
    try {
      second.drain();
      server.runtime.lifecycle.draining = true;
      const page = await fetch(`${address}/healthz`);
      expect(page.status).toBe(200);
      expect(page.headers.get("connection")).toBe("close");
      await page.arrayBuffer();
      expect((await fetch(`${address}/readyz`)).status).toBe(503);
    } finally {
      server.runtime.lifecycle.draining = false;
      second.closeAllConnections();
      await new Promise(done => second.close(done));
    }
  });

  it("answers a save with its data", async () => {
    const created = await send("POST", "/api/v1/spaces/handbook/documents", { title: "页面", slug: "page", markdown: "一\n" });
    const saved = await send("PUT", `/api/v1/documents/${created.payload!.data.document.id}/content`, { markdown: "二\n", expectedRevision: 1 }, { "idempotency-key": "real-socket-1" });
    expect(saved.response.status).toBe(200);
    expect(saved.payload!.data.revision.no).toBe(2);
  });

  it("compresses a large answer when the client accepts it", async () => {
    await send("POST", "/api/v1/spaces/handbook/documents", { title: "长页面", slug: "long", markdown: "很长的一段内容。\n\n".repeat(4000) });
    const response = await fetch(`${origin}/api/v1/bootstrap`, { headers: { ...auth(), "accept-encoding": "gzip" } });
    expect(response.status).toBe(200);
    const read = await fetch(`${origin}/api/v1/spaces/handbook/resolve?path=long`, { headers: auth() });
    const { data } = await read.json() as { data: { id: string } };
    const page = await fetch(`${origin}/api/v1/documents/${data.id}`, { headers: { ...auth(), "accept-encoding": "gzip" } });
    expect(page.headers.get("content-encoding")).toBe("gzip");
    expect(((await page.json()) as { data: { markdown: string } }).data.markdown).toContain("很长的一段内容");
  });

  it("takes an upload and serves it back", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(7);
    const uploaded = await fetch(`${origin}/api/v1/spaces/handbook/assets?filename=big.png`, { method: "POST", headers: { ...auth(), "content-type": "image/png" }, body: bytes });
    expect(uploaded.status).toBe(201);
    const { path } = (await uploaded.json() as { data: { path: string } }).data;
    const back = await fetch(`${origin}/api/v1/spaces/handbook/${path.replace(/\.[a-z0-9]+$/iu, "")}`, { headers: auth() });
    expect(back.status).toBe(200);
    expect((await back.arrayBuffer()).byteLength).toBe(bytes.length);
  });

  it("speaks MCP", async () => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { tools: unknown[] } };
    expect(body.result.tools.length).toBeGreaterThan(10);
  });
});
