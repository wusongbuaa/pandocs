import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();

describe("the MCP endpoint", () => {
  let server: TestServer;
  let admin: Client;
  let visitor: Client;
  let documentId: string;
  let next = 1;

  const rpc = async (token: string, method: string, params: object = {}) => {
    const response = await visitor.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: next++, method, params })
    });
    return { status: response.status, body: (await response.json()) as { result?: any; error?: any } };
  };
  const tokenFor = async (input: object) =>
    (await admin.json("POST", "/api/v1/account/tokens", input)).data.token as string;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    visitor = server.client();
    await admin.json("POST", "/api/v1/spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
    documentId = (
      await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "入门", markdown: "第一段内容。\n" })
    ).data.document.id;
  });
  afterAll(() => server.close());

  it("asks for a token", async () => {
    const response = await visitor.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer resource_metadata=");
  });

  it("lists what the token can do", async () => {
    const names = async (token: string) =>
      ((await rpc(token, "tools/list")).body.result.tools as { name: string }[]).map(tool => tool.name);
    const full = await names(await tokenFor({ name: "全权", scopes: ["read", "write"] }));
    expect(full).toContain("doc_update");
    const readOnly = await names(await tokenFor({ name: "只读", scopes: ["read"] }));
    expect(readOnly).toContain("doc_get");
    expect(readOnly).not.toContain("doc_update");
    const agent = await names(await tokenFor({ name: "助手", kind: "agent", scopes: ["read", "write"] }));
    expect(agent).toContain("proposal_create");
    expect(agent).toContain("doc_report");
    expect(agent).not.toContain("doc_update");
    // What is one person's own, or about running the site, stays out of an agent's view, read-only as it is.
    for (const name of ["inbox", "doc_trash", "import_get", "doc_templates"]) {
      expect(full).toContain(name);
      expect(agent).not.toContain(name);
    }
  });

  it("has nothing at the address for visitors on a site with nothing public", async () => {
    const response = await visitor.request("/mcp/public", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(response.status).toBe(404);
  });

  it("runs a tool as the token's identity, and reports its errors as tool results", async () => {
    const token = await tokenFor({ name: "助手", kind: "agent", scopes: ["read", "write"] });
    const read = await rpc(token, "tools/call", { name: "doc_get", arguments: { doc: documentId } });
    expect(read.body.result.isError).toBeFalsy();
    expect(read.body.result.structuredContent.data.markdown).toBe("第一段内容。\n");
    const missing = await rpc(token, "tools/call", {
      name: "doc_get",
      arguments: { doc: "00000000-0000-4000-8000-000000000000" }
    });
    expect(missing.body.result.isError).toBe(true);
    expect(missing.body.result.structuredContent.error.code).toBe("NOT_FOUND");
  });
});
