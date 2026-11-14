import { execFile, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { PandocsError, createPandocsClient, type LiveEvent } from "@pandocs/client";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { createChangeListener } from "../src/app.js";
import { listen } from "../src/listen.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const ROOT = resolve(import.meta.dirname, "../../..");
const hasGo = spawnSync("go", ["version"]).status === 0;

describe("the clients, against a real server", () => {
  let server: TestServer;
  let admin: Client;
  let http: ServerType;
  let origin = "";
  let userToken = "";
  let agentToken = "";
  let stopListener = () => undefined as void;

  const run = (command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) =>
    new Promise<void>((done, fail) => {
      execFile(
        command,
        args,
        { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: 300_000 },
        (error, stdout, stderr) => {
          if (error) fail(new Error(`${command} failed:\n${stdout}\n${stderr}`));
          else done();
        }
      );
    });

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    userToken = (await admin.json("POST", "/api/v1/account/tokens", { name: "SDK", scopes: ["read", "write"] })).data
      .token;
    agentToken = (
      await admin.json("POST", "/api/v1/account/tokens", { name: "智能体", kind: "agent", scopes: ["read", "write"] })
    ).data.token;
    stopListener = createChangeListener(postgres.getConnectionString(), server.runtime.events.wake, {
      fallbackMs: 3_600_000
    }).stop;
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

  describe("TypeScript", () => {
    it("reads, saves, merges and talks, with the server's own error codes", async () => {
      const pandocs = createPandocsClient({ server: `${origin}/`, token: userToken });
      expect((await pandocs.me()).displayName).toBe("站长");
      await pandocs.api.POST("/spaces", { body: { slug: "from-ts", name: "TS", defaultRole: "viewer" } });
      expect((await pandocs.spaces()).map(space => space.slug)).toContain("from-ts");

      const created = await pandocs.create("from-ts", {
        title: "页面",
        slug: "page",
        markdown: "# 页面\n\n第一段。\n\n第二段。\n"
      });
      const id = created.document.id;
      expect((await pandocs.resolve("from-ts", "page")).id).toBe(id);
      expect((await pandocs.tree("from-ts")).map(node => node.path)).toEqual(["page"]);
      expect((await pandocs.read(id)).markdown).toContain("第一段");

      await pandocs.save(id, { markdown: "# 页面\n\n第一段，改过。\n\n第二段。\n", expectedRevision: 1 });
      const stale = await pandocs
        .save(id, { markdown: "过期\n", expectedRevision: 1 })
        .catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(PandocsError);
      expect(stale).toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
      const merged = await pandocs.save(id, {
        markdown: "# 页面\n\n第一段。\n\n第二段，改过。\n",
        expectedRevision: 1,
        merge: true
      });
      expect(merged.merged).toBe(true);
      expect((await pandocs.read(id)).markdown).toBe("# 页面\n\n第一段，改过。\n\n第二段，改过。\n");

      const thread = await pandocs.comment(id, { anchor: { kind: "quote", quote: "第一段" }, body: "这里要确认" });
      expect((await pandocs.reply(thread.id, "确认了")).body).toBe("确认了");
      expect((await pandocs.threads(id))[0]!.comments).toHaveLength(2);
      expect((await pandocs.search("第一段", { space: "from-ts" })).map(hit => hit.path)).toEqual(["page"]);
      expect((await pandocs.manifest("from-ts")).files.map(file => file.path)).toEqual(["page.md"]);
      expect((await pandocs.tool<{ markdown: string }>("doc_get", { doc: id })).markdown).toContain("第一段");
      await expect(pandocs.read(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
    });

    it("lets an agent propose, and a person decide", async () => {
      const agent = createPandocsClient({ server: origin, token: agentToken });
      const person = createPandocsClient({ server: origin, token: userToken });
      await person.api.POST("/spaces", { body: { slug: "agent-work", name: "代理", defaultRole: "viewer" } });
      const id = (await person.create("agent-work", { title: "页面", slug: "page", markdown: "# 页面\n\n旧的。\n" }))
        .document.id;
      expect((await agent.me()).kind).toBe("agent");
      await expect(agent.save(id, { markdown: "直接改\n", expectedRevision: 1 })).rejects.toMatchObject({
        status: 403
      });
      const proposal = await agent.propose(id, { baseRevision: 1, markdown: "# 页面\n\n新的。\n", rationale: "更新" });
      expect(proposal.authorKind).toBe("agent");
      expect((await person.read(id)).markdown).toContain("旧的");
    });

    it("follows events until told to stop, and comes back after losing the connection", async () => {
      const pandocs = createPandocsClient({ server: origin, token: userToken });
      await pandocs.api.POST("/spaces", { body: { slug: "live", name: "实时", defaultRole: "viewer" } });
      const stop = new AbortController();
      const seen: LiveEvent[] = [];
      const reading = (async () => {
        for await (const event of pandocs.events({ space: "live", signal: stop.signal })) seen.push(event);
      })();
      await vi.waitFor(() => expect(server.runtime.events.connected).toBeGreaterThan(0), {
        timeout: 5000,
        interval: 10
      });
      await pandocs.create("live", { title: "一", slug: "one", markdown: "一\n" });
      await vi.waitFor(
        () => expect(seen.some(event => event.type === "change" && event.change.path === "one")).toBe(true),
        { timeout: 5000, interval: 10 }
      );

      // A restart on the server's side: the client should come back without being asked, and miss nothing.
      server.runtime.events.stop();
      await pandocs.create("live", { title: "二", slug: "two", markdown: "二\n" });
      await vi.waitFor(
        () => expect(seen.some(event => event.type === "change" && event.change.path === "two")).toBe(true),
        { timeout: 10_000, interval: 20 }
      );

      stop.abort();
      await reading;
    }, 30_000);

    it("stops following when the server refuses, since asking again would not help", async () => {
      const pandocs = createPandocsClient({ server: origin, token: "pd_not_a_real_token" });
      await expect(
        (async () => {
          for await (const event of pandocs.events()) expect(event).toBeUndefined();
        })()
      ).rejects.toMatchObject({ status: 401, code: "TOKEN_INVALID" });
    });
  });

  describe.skipIf(!hasGo)("Go", () => {
    it("works as generated", async () => {
      await admin.json("POST", "/api/v1/spaces", { slug: "from-go", name: "Go", defaultRole: "viewer" });
      await run("go", ["test", "-count=1", "./..."], {
        cwd: join(ROOT, "sdks/go"),
        env: { PANDOCS_TEST_URL: origin, PANDOCS_TEST_TOKEN: userToken, PANDOCS_TEST_SPACE: "from-go" }
      });
      const page = (await admin.json("GET", "/api/v1/spaces/from-go/resolve?path=from-go")).data;
      expect((await admin.json("GET", `/api/v1/documents/${page.id}`)).data.markdown).toContain("Changed");
    }, 200_000);
  });
});
