import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PandocsPorts } from "@pandocs/core";
import pg from "pg";
import { createApp, createRuntime, migrate, readConfig } from "../src/app.js";

export const PUBLIC_URL = "http://pandocs.test";

/** A fake build of the web app, so these tests need no bundler. */
export function fakeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pandocs-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>app</title>
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
`);
  writeFileSync(join(dir, "assets/app-abc.js"), "console.log('plain');");
  writeFileSync(join(dir, "assets/app-abc.js.br"), "brotli-bytes");
  writeFileSync(join(dir, "theme-init.js"), "// theme");
  return dir;
}

export interface Client {
  readonly cookies: Map<string, string>;
  request(path: string, init?: RequestInit): Promise<Response>;
  json(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: any; error: any; response: Response }>;
  form(path: string, fields: Record<string, string>): Promise<Response>;
}

export async function startServer(connectionString: string, env: Record<string, string> = {}, ports: Partial<PandocsPorts> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pandocs-data-"));
  const webDir = fakeWebDir();
  const config = readConfig({ DATABASE_URL: connectionString, PANDOCS_URL: PUBLIC_URL, PANDOCS_DATA_DIR: dataDir, PANDOCS_WEB_DIR: webDir, ...env });
  const pool = new pg.Pool({ connectionString, max: 4 });
  await migrate(pool);

  /** Another process behind the same load balancer: same database, nothing shared in memory. */
  const replica = () => createApp(createRuntime({ ...config, secret: "test-secret" }, pool, ports));
  const runtime = createRuntime({ ...config, secret: "test-secret" }, pool, ports);
  const app = createApp(runtime);

  const client = (target = app): Client => {
    const cookies = new Map<string, string>();
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookies.size > 0) headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await target.request(new URL(path, PUBLIC_URL).toString(), { ...init, headers });
      for (const line of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = line.split(";");
        const at = pair.indexOf("=");
        const name = pair.slice(0, at);
        const value = pair.slice(at + 1);
        if (!value || attributes.some(item => /max-age=0/iu.test(item))) cookies.delete(name);
        else cookies.set(name, value);
      }
      return response;
    };
    return {
      cookies,
      request,
      async json(method, path, body, headers = {}) {
        const response = await request(path, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const payload = await response.clone().json().catch(() => null) as { data?: unknown; error?: unknown } | null;
        return { status: response.status, data: payload?.data, error: payload?.error, response };
      },
      form: (path, fields) => request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() })
    };
  };

  return {
    app,
    runtime,
    replica,
    client,
    pool,
    config,
    async close() {
      runtime.events.stop();
      await pool.end();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(webDir, { recursive: true, force: true });
    }
  };
}

export type TestServer = Awaited<ReturnType<typeof startServer>>;

export const ADMIN = { displayName: "站长", email: "admin@example.test", password: "correct horse battery" };

export async function signInFirstAdmin(server: TestServer): Promise<Client> {
  const person = server.client();
  const response = await person.form("/setup", { ...ADMIN, next: "/" });
  if (response.status !== 303 || response.headers.get("location") !== "/") throw new Error(`setup answered ${response.status} ${response.headers.get("location")}`);
  return person;
}
