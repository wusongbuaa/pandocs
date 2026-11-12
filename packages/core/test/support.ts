import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import {
  createPandocsDb,
  createPandocsHandler,
  createPandocsServices,
  createLocalAssetStore,
  type PandocsPorts,
  type Principal
} from "@pandocs/core";
import { applyPandocsSchema } from "@pandocs/core/migrate";

export const USERS = {
  admin: {
    id: "admin-1",
    kind: "user",
    displayName: "管理员",
    groups: ["host-admin"],
    isAdmin: true,
    scopes: ["read", "write"],
    channel: "web"
  },
  editor: {
    id: "editor-1",
    kind: "user",
    displayName: "编辑者",
    groups: [],
    isAdmin: false,
    scopes: ["read", "write"],
    channel: "web"
  },
  commenter: {
    id: "commenter-1",
    kind: "user",
    displayName: "评论者",
    groups: [],
    isAdmin: false,
    scopes: ["read", "write"],
    channel: "web"
  },
  reader: {
    id: "reader-1",
    kind: "user",
    displayName: "读者",
    groups: [],
    isAdmin: false,
    scopes: ["read", "write"],
    channel: "web"
  },
  stranger: {
    id: "stranger-1",
    kind: "user",
    displayName: "外人",
    groups: [],
    isAdmin: false,
    scopes: ["read", "write"],
    channel: "web"
  },
  agent: {
    id: "agent-1",
    kind: "agent",
    displayName: "智能体",
    groups: [],
    isAdmin: false,
    scopes: ["read", "write"],
    channel: "agent",
    onBehalfOf: { id: "editor-1", groups: [] }
  }
} satisfies Record<string, Principal>;

export const BASE = "/api/v1";

export async function resetPandocs(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  await pool.query("DROP SCHEMA IF EXISTS pandocs CASCADE");
  await pool.end();
  await applyPandocsSchema(connectionString);
}

export function createHarness(connectionString: string, ports: Partial<PandocsPorts> = {}) {
  const pool = new pg.Pool({ connectionString, max: 4 });
  const assetRoot = mkdtempSync(join(tmpdir(), "pandocs-assets-"));
  const services = createPandocsServices({
    db: createPandocsDb(pool),
    ports: { assets: createLocalAssetStore(assetRoot), ...ports }
  });
  const errors: unknown[] = [];
  const handler = createPandocsHandler(services, { basePath: BASE, onError: error => errors.push(error) });

  const call = async (
    principal: Principal,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = body instanceof FormData || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body);
      if (!(body instanceof FormData) && !(body instanceof Uint8Array))
        (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    const response = await handler(new Request(`http://pandocs.test${BASE}/${path}`, init), principal);
    const isJson = response.headers.get("content-type")?.includes("json");
    const payload = isJson ? ((await response.json()) as { data?: any; error?: any }) : null;
    return { status: response.status, data: payload?.data, error: payload?.error, response };
  };

  const write = (principal: Principal, method: string, path: string, body: unknown) =>
    call(principal, method, path, body, { "idempotency-key": randomUUID() });

  return {
    pool,
    services,
    handler,
    call,
    write,
    errors,
    async close() {
      await pool.end();
      rmSync(assetRoot, { recursive: true, force: true });
    }
  };
}
