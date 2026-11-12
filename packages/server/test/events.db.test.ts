import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { createChangeListener } from "../src/app.js";
import { createEventHub } from "../src/events.js";
import { listen } from "../src/listen.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const SPACE = "shop";

interface Frame { readonly id: string | null; readonly event: string; readonly data: any }

/** Reads a stream of events the way a client would, one frame at a time. */
function reader(response: Response) {
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  const source = response.body!.getReader();
  let buffer = "";
  let ended = false;
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await source.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = (name: string) => block.split("\n").find(item => item.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
          if (line("event")) frames.push({ id: line("id"), event: line("event")!, data: JSON.parse(line("data") ?? "null") });
        }
      }
    } catch {
      // The test closed it.
    }
    ended = true;
  })();
  return {
    frames,
    get ended() {
      return ended;
    },
    async close() {
      await source.cancel().catch(() => undefined);
      await done;
    },
    paths: () => frames.filter(frame => frame.event === "change").map(frame => frame.data.path as string)
  };
}

describe("live events", () => {
  let server: TestServer;
  let admin: Client;
  let adminToken = "";
  let readerToken = "";
  let readerClient: Client;
  let http: ServerType;
  let origin = "";
  let stopListener = () => undefined as void;

  const create = async (slug: string, extra: object = {}, target = SPACE) => {
    const result = await admin.json("POST", `/api/v1/spaces/${target}/documents`, { title: slug, slug, markdown: `${slug}\n`, ...extra });
    expect(result.status).toBe(201);
    return result.data.document as { id: string; path: string };
  };
  const connect = (query = "", headers: Record<string, string> = {}, token = adminToken) =>
    fetch(`${origin}/api/v1/events${query}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const stream = async (query = "", headers: Record<string, string> = {}, token = adminToken) => {
    const response = await connect(query, headers, token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    return reader(response);
  };
  const soon = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 20 });

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: SPACE, name: "书店", defaultRole: "viewer" });
    await admin.json("POST", "/api/v1/spaces", { slug: "closed", name: "内部", defaultRole: "none" });
    adminToken = (await admin.json("POST", "/api/v1/account/tokens", { name: "管理员", scopes: ["read", "write"] })).data.token;
    await admin.json("POST", "/api/v1/admin/users", { email: "reader@example.test", displayName: "读者", password: "reader-password-1" });
    readerClient = server.client();
    const signedIn = await readerClient.form("/login", { email: "reader@example.test", password: "reader-password-1", next: "/" });
    expect(signedIn.status).toBe(303);
    readerToken = (await readerClient.json("POST", "/api/v1/account/tokens", { name: "读者", scopes: ["read"] })).data.token;
    const listener = createChangeListener(postgres.getConnectionString(), server.runtime.events.wake, { fallbackMs: 3_600_000 });
    stopListener = listener.stop;
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port: 0 }, info => {
        origin = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
  });
  afterAll(async () => {
    stopListener();
    server.runtime.events.stop();
    await new Promise(done => http.close(done));
    await server.close();
  });

  it("delivers a change as it happens, over a real socket", async () => {
    const events = await stream();
    try {
      const page = await create("实时");
      await soon(() => expect(events.paths()).toContain("实时"));
      const frame = events.frames.find(item => item.data.path === "实时")!;
      expect(frame.data).toMatchObject({ kind: "document", spaceSlug: SPACE, documentId: page.id, revision: 1, deleted: false });
      expect(frame.id).toBe(frame.data.cursor);
      expect(frame.data).not.toHaveProperty("restricted");
    } finally {
      await events.close();
    }
  });

  it("starts with where it is, so a client that heard nothing yet has a place to come back to", async () => {
    const events = await stream();
    let position = "";
    try {
      await soon(() => expect(events.frames[0]?.event).toBe("ready"));
      position = events.frames[0]!.id!;
    } finally {
      await events.close();
    }
    await create("准备后");
    const again = await stream(`?since=${position}`);
    try {
      await soon(() => expect(again.paths()).toEqual(["准备后"]));
      expect(again.frames[0]).toMatchObject({ event: "ready", id: position });
    } finally {
      await again.close();
    }
  });

  it("does not repeat what a client coming back was just told, when the hub catches up with the same rows", async () => {
    // A hub with nothing waking it, so that the wake-up can come after the replay rather than racing it.
    const hub = createEventHub({ identity: server.runtime.identity, services: server.runtime.services });
    const open = async (query = "") => reader(await hub.handle(new Request(`${origin}/api/v1/events${query}`, { headers: { authorization: `Bearer ${adminToken}` } })));
    const already = await open();
    await soon(() => expect(already.frames[0]?.event).toBe("ready"));
    await create("补发一次");
    const returning = await open(`?since=${already.frames[0]!.id!}`);
    try {
      await soon(() => expect(returning.paths()).toEqual(["补发一次"]));
      hub.wake();
      await soon(() => expect(already.paths()).toEqual(["补发一次"]));
      await new Promise(done => setTimeout(done, 200));
      expect(returning.paths()).toEqual(["补发一次"]);
      // And what comes next still arrives.
      await create("补发之后");
      hub.wake();
      await soon(() => expect(returning.paths()).toEqual(["补发一次", "补发之后"]));
    } finally {
      hub.stop();
      await already.close();
      await returning.close();
    }
  });

  it("tells a page about the discussion on it", async () => {
    const page = await create("讨论");
    const events = await stream(`?document=${page.id}`);
    try {
      await admin.json("POST", `/api/v1/documents/${page.id}/threads`, { anchor: { kind: "document" }, body: "看一下" });
      await soon(() => expect(events.frames.map(frame => frame.data.kind)).toContain("discussion"));
    } finally {
      await events.close();
    }
  });

  it("forgets a client that left", async () => {
    await soon(() => expect(server.runtime.events.connected).toBe(0));
    const events = await stream();
    expect(server.runtime.events.connected).toBe(1);
    await events.close();
    await soon(() => expect(server.runtime.events.connected).toBe(0));
  });

  it("shows each person only what they can read", async () => {
    const forReader = await stream("", {}, readerToken);
    const forAdmin = await stream();
    try {
      await create("受限-事件", { restricted: true });
      await create("内部-事件", {}, "closed");
      await create("公开-事件");
      await soon(() => expect(forReader.paths()).toContain("公开-事件"));
      await soon(() => expect(forAdmin.paths()).toContain("公开-事件"));
      expect(forReader.paths()).not.toContain("受限-事件");
      expect(forReader.paths()).not.toContain("内部-事件");
      expect(forAdmin.paths()).toEqual(expect.arrayContaining(["受限-事件", "内部-事件"]));
    } finally {
      await forReader.close();
      await forAdmin.close();
    }
  });

  it("narrows to one space or one document", async () => {
    const page = await create("只看这页");
    const onePage = await stream(`?document=${page.id}`);
    const oneSpace = await stream("?space=closed");
    try {
      await create("别的页");
      await create("内部的页", {}, "closed");
      await admin.json("PATCH", `/api/v1/documents/${page.id}`, { title: "新标题" });
      await soon(() => expect(onePage.paths().length).toBeGreaterThan(0));
      await soon(() => expect(oneSpace.paths()).toEqual(["内部的页"]));
      expect(onePage.paths()).toEqual(["只看这页"]);
    } finally {
      await onePage.close();
      await oneSpace.close();
    }
  });

  it("refuses what it should, and says why", async () => {
    expect((await fetch(`${origin}/api/v1/events`)).status).toBe(401);
    expect((await connect("?space=closed", {}, readerToken)).status).toBe(404);
    const hidden = await create("受限-不可见", { restricted: true });
    expect((await connect(`?document=${hidden.id}`, {}, readerToken)).status).toBe(404);
    expect((await connect(`?document=${crypto.randomUUID()}`)).status).toBe(404);
    const invalid = await connect("?since=abc");
    expect(invalid.status).toBe(422);
  });

  describe("reconnecting", () => {
    it("catches up from the last event it saw, in the header browsers send", async () => {
      const first = await stream();
      let last = "";
      try {
        await create("断线前");
        await soon(() => expect(first.paths()).toContain("断线前"));
        last = first.frames.at(-1)!.id!;
      } finally {
        await first.close();
      }
      await create("断线时一");
      await create("断线时二");
      const again = await stream("", { "last-event-id": last });
      try {
        await soon(() => expect(again.paths()).toEqual(["断线时一", "断线时二"]));
        await create("回来后");
        await soon(() => expect(again.paths()).toEqual(["断线时一", "断线时二", "回来后"]));
      } finally {
        await again.close();
      }
    });

    it("hides restricted pages while catching up too", async () => {
      const start = await server.runtime.services.changes.watermark();
      await create("受限-补发", { restricted: true });
      await create("公开-补发");
      const events = await stream(`?since=${start}`, {}, readerToken);
      try {
        await soon(() => expect(events.paths()).toContain("公开-补发"));
        expect(events.paths()).not.toContain("受限-补发");
      } finally {
        await events.close();
      }
    });

    it("says to start over when the gap is longer than it keeps", async () => {
      const position = await server.runtime.services.changes.watermark();
      await create("清理前");
      await server.pool.query(`UPDATE pandocs.change_log SET created_at = now() - interval '31 days'`);
      await server.runtime.services.changes.sweep();
      await create("清理后");
      const events = await stream(`?since=${position}`);
      try {
        await soon(() => expect(events.frames.map(frame => frame.event)).toContain("reset"));
      } finally {
        await events.close();
      }
    });
  });

  describe("a stream outliving what opened it", () => {
    const direct = (token: string, recheckMs: number) => {
      const hub = createEventHub({ identity: server.runtime.identity, services: server.runtime.services, recheckMs });
      return { hub, request: new Request("http://pandocs.test/api/v1/events", { headers: { authorization: `Bearer ${token}` } }) };
    };

    it("ends when its token is revoked", async () => {
      const made = (await readerClient.json("POST", "/api/v1/account/tokens", { name: "要撤销", scopes: ["read"] })).data;
      const { hub, request } = direct(made.token, 0);
      await hub.wake();
      const events = reader(await hub.handle(request));
      try {
        await create("撤销前");
        hub.wake();
        await soon(() => expect(events.paths()).toContain("撤销前"));
        expect((await readerClient.json("DELETE", `/api/v1/account/tokens/${made.record.id}`)).status).toBe(200);
        await create("撤销后");
        hub.wake();
        await soon(() => expect(events.ended).toBe(true));
        expect(events.paths()).not.toContain("撤销后");
        expect(hub.connected).toBe(0);
      } finally {
        await events.close();
        hub.stop();
      }
    });

    it("stops mentioning a space once someone loses access to it", async () => {
      await admin.json("POST", "/api/v1/spaces", { slug: "shared", name: "共享", defaultRole: "viewer" });
      const { hub, request } = direct(readerToken, 0);
      await hub.wake();
      const events = reader(await hub.handle(request));
      try {
        await create("还能看", {}, "shared");
        hub.wake();
        await soon(() => expect(events.paths()).toContain("还能看"));
        expect((await admin.json("PATCH", "/api/v1/spaces/shared", { defaultRole: "none" })).status).toBe(200);
        await create("不能看了", {}, "shared");
        await create("别的还能看");
        hub.wake();
        await soon(() => expect(events.paths()).toContain("别的还能看"));
        expect(events.paths()).not.toContain("不能看了");
      } finally {
        await events.close();
        hub.stop();
      }
    });
  });

  it("limits how many one identity can hold open, and ends them all on shutdown", async () => {
    const hub = createEventHub({ identity: server.runtime.identity, services: server.runtime.services });
    const request = () => new Request("http://pandocs.test/api/v1/events", { headers: { authorization: `Bearer ${readerToken}` } });
    const open = await Promise.all(Array.from({ length: 32 }, async () => reader(await hub.handle(request()))));
    expect(hub.connected).toBe(32);
    const refused = await hub.handle(request());
    expect(refused.status).toBe(429);
    hub.stop();
    expect(hub.connected).toBe(0);
    await soon(() => expect(open.every(events => events.ended)).toBe(true));
  });
});
