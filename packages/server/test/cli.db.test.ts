import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { createChangeListener, createPublisher } from "../src/app.js";
import { extractToMarkdown } from "../src/extract/convert.js";
import { createExtractProcessor } from "../src/extract/processor.js";
import { listen } from "../src/listen.js";
import { blankPdf, docx, pdf } from "./office-files.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const ROOT = resolve(import.meta.dirname, "../../..");
const hasGo = spawnSync("go", ["version"]).status === 0;

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The real binary against the real server over a real socket. Not `spawnSync`: the server runs in this process. */
describe.skipIf(!hasGo)("the command line", () => {
  let server: TestServer;
  let admin: Client;
  let http: ServerType;
  let origin = "";
  let home = "";
  let binary = "";
  let userToken = "";
  let agentToken = "";
  let readerToken = "";
  let stopListener = () => undefined as void;
  let space = "";
  let spaceNumber = 0;
  let work = "";

  const baseEnv = () => ({ PATH: process.env.PATH ?? "", HOME: home, PANDOCS_CONFIG: join(home, "config.json") });
  const start = (
    args: readonly string[],
    options: { cwd?: string; token?: string | null; server?: string | null } = {}
  ) => {
    const token = options.token === undefined ? userToken : options.token;
    const address = options.server === undefined ? origin : options.server;
    return spawn(binary, args, {
      cwd: options.cwd ?? work,
      env: { ...baseEnv(), ...(token ? { PANDOCS_TOKEN: token } : {}), ...(address ? { PANDOCS_URL: address } : {}) }
    });
  };
  const run = (
    args: readonly string[],
    options: { cwd?: string; token?: string | null; server?: string | null; input?: string } = {}
  ) =>
    new Promise<Result>((done, fail) => {
      const child = start(args, options);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => {
        stdout += String(chunk);
      });
      child.stderr.on("data", chunk => {
        stderr += String(chunk);
      });
      child.on("error", fail);
      child.on("close", code => done({ code, stdout, stderr }));
      child.stdin.end(options.input ?? "");
    });
  const ok = async (args: readonly string[], options: Parameters<typeof run>[1] = {}) => {
    const result = await run(args, options);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return result.stdout;
  };

  const create = async (slug: string, markdown = `${slug} 的内容\n`, extra: object = {}) => {
    const result = await admin.json("POST", `/api/v1/spaces/${space}/documents`, {
      title: slug,
      slug,
      markdown,
      ...extra
    });
    expect(result.status).toBe(201);
    return result.data.document as { id: string; path: string };
  };
  const save = async (id: string, markdown: string, expectedRevision: number) => {
    const result = await admin.json(
      "PUT",
      `/api/v1/documents/${id}/content`,
      { markdown, expectedRevision },
      { "idempotency-key": crypto.randomUUID() }
    );
    expect(result.status).toBe(200);
  };
  const serverText = async (id: string) => (await admin.json("GET", `/api/v1/documents/${id}`)).data.markdown as string;
  const copy = (...parts: string[]) => join(work, space, ...parts);
  const read = (...parts: string[]) => readFileSync(copy(...parts), "utf8");
  const sync = () => ok(["sync", space]);
  const inCopy = () => ({ cwd: copy() });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "pandocs-cli-home-"));
    binary = join(home, process.platform === "win32" ? "pandocs.exe" : "pandocs");
    execFileSync("go", ["build", "-o", binary, "."], { cwd: join(ROOT, "cli"), stdio: "pipe" });
    server = await startServer(
      postgres.getConnectionString(),
      {},
      { processors: [createExtractProcessor(extractToMarkdown)] }
    );
    admin = await signInFirstAdmin(server);
    userToken = (await admin.json("POST", "/api/v1/account/tokens", { name: "命令行", scopes: ["read", "write"] })).data
      .token;
    agentToken = (
      await admin.json("POST", "/api/v1/account/tokens", { name: "智能体", kind: "agent", scopes: ["read", "write"] })
    ).data.token;
    await admin.json("POST", "/api/v1/admin/users", {
      email: "reader@example.test",
      displayName: "读者",
      password: "reader-password-1"
    });
    const reader = server.client();
    await reader.form("/login", { email: "reader@example.test", password: "reader-password-1", next: "/" });
    readerToken = (await reader.json("POST", "/api/v1/account/tokens", { name: "读者", scopes: ["read"] })).data.token;
    stopListener = createChangeListener(postgres.getConnectionString(), server.runtime.events.wake, {
      fallbackMs: 3_600_000
    }).stop;
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port: 0 }, info => {
        origin = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
  }, 180_000);
  afterAll(async () => {
    stopListener();
    server?.runtime.events.stop();
    if (http) await new Promise(done => http.close(done));
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    space = `shop${(spaceNumber += 1)}`;
    work = mkdtempSync(join(home, "work-"));
    expect(
      (await admin.json("POST", "/api/v1/spaces", { slug: space, name: "书店", defaultRole: "viewer" })).status
    ).toBe(201);
  });

  describe("logging in", () => {
    it("checks the token, keeps it private, and never shows it", async () => {
      const config = join(home, "config.json");
      const refused = await run(["login", "--server", origin, "--token-stdin"], {
        token: null,
        server: null,
        input: "pd_not_a_real_token\n"
      });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("TOKEN_INVALID");
      expect(existsSync(config)).toBe(false);

      const loggedIn = await run(["login", "--server", origin, "--token-stdin"], {
        token: null,
        server: null,
        input: `${userToken}\n`
      });
      expect(loggedIn.code).toBe(0);
      expect(loggedIn.stdout).toContain("站长");
      expect(loggedIn.stdout + loggedIn.stderr).not.toContain(userToken);
      expect(statSync(config).mode & 0o777).toBe(0o600);

      expect(await ok(["whoami"], { token: null, server: null })).toContain("站长");
      expect(await ok(["logout"], { token: null, server: null })).toContain("Logged out");
      expect(existsSync(config)).toBe(false);
      const after = await run(["whoami"], { token: null, server: null });
      expect(after.code).toBe(1);
      expect(after.stderr).toContain("not logged in");
    });

    it("explains a wrong command", async () => {
      const result = await run(["nope"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("pandocs help");
    });
  });

  describe("reading", () => {
    it("lists, prints and searches, with the same words for people and machines", async () => {
      const page = await create("退货流程", "# 退货流程\n\n七天内可以退货。\n");
      await save(page.id, "# 退货流程\n\n十四天内可以退货。\n", 1);
      expect(await ok(["spaces"])).toContain(`${space}\t书店`);
      expect(JSON.parse(await ok(["spaces", "--json"])).map((item: { slug: string }) => item.slug)).toContain(space);
      expect(await ok(["get", `${space}/退货流程`])).toBe("# 退货流程\n\n十四天内可以退货。\n");
      expect(await ok(["get", `${space}/退货流程.md`, "--revision", "1"])).toBe("# 退货流程\n\n七天内可以退货。\n");
      expect(await ok(["get", page.id])).toContain("十四天");
      expect(JSON.parse(await ok(["get", page.id, "--json"])).revision.no).toBe(2);
      const missing = await run(["get", `${space}/没有这页`]);
      expect(missing.code).toBe(1);
      expect(await ok(["search", "退货", "--space", space])).toContain(`${space}/退货流程\t退货流程`);
      expect(JSON.parse(await ok(["search", "退货", "--json"])).length).toBeGreaterThan(0);
    });

    it("can do anything the server offers, by name", async () => {
      const page = await create("工具页");
      expect(await ok(["tools"])).toContain("proposal_create");
      expect(
        JSON.parse(await ok(["tools", "--json"])).find((tool: { name: string }) => tool.name === "doc_get").inputSchema
      ).toBeTruthy();
      expect(JSON.parse(await ok(["call", "doc_get", "--arg", `doc=${page.id}`])).markdown).toContain("工具页");
      expect(JSON.parse(await ok(["call", "doc_get", JSON.stringify({ doc: page.id })])).markdown).toContain("工具页");
      expect(
        JSON.parse(await ok(["call", "doc_get", "-"], { input: JSON.stringify({ doc: page.id }) })).markdown
      ).toContain("工具页");
      expect((await run(["call", "doc_get", "{not json"])).code).toBe(2);
      expect((await run(["call", "no_such_tool"])).code).toBe(1);
    });

    it("uploads a file and says how to use it", async () => {
      const file = join(work, "图.png");
      writeFileSync(
        file,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64"
        )
      );
      const path = (await ok(["upload", space, file])).trim();
      expect(path).toMatch(/^assets\/[a-f0-9]{64}\.png$/u);
      await create("有图", `![图](${path})\n`);
      await sync();
      expect(readFileSync(copy(path)).length).toBe(statSync(file).size);
    });
  });

  describe("a copy on disk", () => {
    it("brings down a space, and says when there is nothing to do", async () => {
      await create("开始");
      await create("子页", "子页的内容\n", { parentPath: "开始" });
      expect(await sync()).toContain("updated   开始/子页.md");
      expect(read("开始.md")).toBe("开始 的内容\n");
      expect(read("开始/子页.md")).toBe("子页的内容\n");
      const again = await sync();
      expect(again).not.toContain("updated");
      expect(again).toContain("is up to date");
      expect(await ok(["status"], inCopy())).toContain("Nothing changed");
    });

    it("uses one archive for a large space instead of asking page by page", async () => {
      for (let index = 0; index < 40; index += 1) await create(`页面${index}`);
      const spy = vi.spyOn(server.runtime.services.changes, "archive");
      const report = JSON.parse(await ok(["sync", space, "--json"]));
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(report.written).toHaveLength(40);
      expect(read("页面39.md")).toBe("页面39 的内容\n");
      expect(await ok(["status"], inCopy())).toContain("Nothing changed");
    });

    it("follows the server: new text, new pages, deleted pages, and pages that moved", async () => {
      const changed = await create("会变");
      const removed = await create("会删");
      const moved = await create("会搬");
      await sync();
      await save(changed.id, "第二版\n", 1);
      await create("新来的");
      expect((await admin.json("DELETE", `/api/v1/documents/${removed.id}`)).status).toBe(200);
      expect((await admin.json("POST", `/api/v1/documents/${moved.id}/move`, { slug: "搬好了" })).status).toBe(200);
      const status = await ok(["status", "--remote"], inCopy());
      expect(status).toContain("behind    会变.md");
      expect(status).toContain("behind    新来的.md");
      expect(status).toContain("gone      会删.md");

      const output = await sync();
      expect(output).toContain("moved     会搬.md -> 搬好了.md");
      expect(read("会变.md")).toBe("第二版\n");
      expect(read("新来的.md")).toBe("新来的 的内容\n");
      expect(existsSync(copy("会删.md"))).toBe(false);
      expect(existsSync(copy("会搬.md"))).toBe(false);
      expect(read("搬好了.md")).toBe("会搬 的内容\n");
      expect(await ok(["status"], inCopy())).toContain("Nothing changed");
    });

    it("never overwrites work: not on a new version, not on a deletion, not on a move", async () => {
      const edited = await create("改了没变");
      const both = await create("两边都改");
      const removed = await create("这边改那边删");
      const moved = await create("这边改那边搬");
      await sync();
      for (const name of ["改了没变", "两边都改", "这边改那边删", "这边改那边搬"])
        writeFileSync(copy(`${name}.md`), `${name} 我的修改\n`);
      await save(both.id, "服务器上的修改\n", 1);
      await admin.json("DELETE", `/api/v1/documents/${removed.id}`);
      await admin.json("POST", `/api/v1/documents/${moved.id}/move`, { slug: "搬走了" });

      const output = await sync();
      expect(output).toContain("kept      改了没变.md");
      expect(output).toContain("both      两边都改.md");
      expect(read("改了没变.md")).toBe("改了没变 我的修改\n");
      expect(read("两边都改.md")).toBe("两边都改 我的修改\n");
      expect(read("这边改那边删.md")).toBe("这边改那边删 我的修改\n");
      expect(read("搬走了.md")).toBe("这边改那边搬 我的修改\n");
      expect(edited.id).toBeTruthy();
      expect(await serverText(edited.id)).toBe("改了没变 的内容\n");
      // A page deleted on the server, with work here, is a new page as far as this copy goes.
      expect(await ok(["status"], inCopy())).toContain("added     这边改那边删.md");
    });

    it("does not touch a file already there that never came from the server", async () => {
      await create("同名");
      mkdirSync(copy(), { recursive: true });
      writeFileSync(copy("同名.md"), "早就在这\n");
      const output = await sync();
      expect(output).toContain("both      同名.md");
      expect(read("同名.md")).toBe("早就在这\n");
      const committed = await run(["commit"], inCopy());
      expect(committed.code).toBe(1);
      expect(committed.stdout).toContain("move the file aside");
    });

    it("shows each person only what they can read, and takes away what they no longer can", async () => {
      const page = await create("后来受限");
      await create("一直受限", "秘密\n", { restricted: true });
      await ok(["sync", space], { token: readerToken });
      expect(read("后来受限.md")).toBe("后来受限 的内容\n");
      expect(existsSync(copy("一直受限.md"))).toBe(false);
      await admin.json("PATCH", `/api/v1/documents/${page.id}`, { restricted: true });
      await ok(["sync", space], { token: readerToken });
      expect(existsSync(copy("后来受限.md"))).toBe(false);
    });

    it("refuses to mix two spaces in one directory", async () => {
      await sync();
      const other = await run(["sync", "别的空间", space]);
      expect(other.code).toBe(2);
      expect(other.stderr).toContain("already holds");
    });

    it("keeps no credentials in the copy", async () => {
      await create("一页");
      await sync();
      expect(read(".pandocs/state.json")).not.toContain(userToken);
      expect(read(".pandocs/state.json")).not.toContain("pd_");
    });
  });

  describe("sending work back", () => {
    it("saves an edit as a new revision, and has nothing left to do", async () => {
      const page = await create("要改");
      await sync();
      writeFileSync(copy("要改.md"), "改好了\n");
      expect(await ok(["status"], inCopy())).toContain("modified  要改.md");
      expect(await ok(["commit", "-m", "改一下"], inCopy())).toContain("saved     要改.md (revision 2)");
      expect(await serverText(page.id)).toBe("改好了\n");
      const history = (await admin.json("GET", `/api/v1/documents/${page.id}/revisions?limit=1`)).data[0];
      expect(history).toMatchObject({ channel: "cli", message: "改一下", actorName: "站长" });
      expect(await ok(["commit"], inCopy())).toContain("Nothing to commit");
      expect(await sync()).not.toContain("kept");
    });

    it("merges with what someone else changed elsewhere on the page, and brings the result here", async () => {
      const page = await create("合并", "# 合并\n\n第一段。\n\n第二段。\n");
      await sync();
      writeFileSync(copy("合并.md"), "# 合并\n\n第一段，我改的。\n\n第二段。\n");
      await save(page.id, "# 合并\n\n第一段。\n\n第二段，别人改的。\n", 1);
      expect(await ok(["commit"], inCopy())).toContain("merged    合并.md");
      const merged = "# 合并\n\n第一段，我改的。\n\n第二段，别人改的。\n";
      expect(await serverText(page.id)).toBe(merged);
      expect(read("合并.md")).toBe(merged);
      expect(await ok(["status"], inCopy())).toContain("Nothing changed");
    });

    it("stops and says so when both changed the same place, and loses neither", async () => {
      const page = await create("冲突", "# 冲突\n\n同一段。\n");
      await sync();
      writeFileSync(copy("冲突.md"), "# 冲突\n\n我改的。\n");
      await save(page.id, "# 冲突\n\n别人改的。\n", 1);
      const result = await run(["commit"], inCopy());
      expect(result.code).toBe(3);
      expect(result.stdout).toContain("conflict  冲突.md");
      expect(read("冲突.md")).toBe("# 冲突\n\n我改的。\n");
      expect(await serverText(page.id)).toBe("# 冲突\n\n别人改的。\n");
      expect(await ok(["status", "--remote"], inCopy())).toContain("both      冲突.md");
    });

    it("creates a new page, along with any folders above it", async () => {
      mkdirSync(copy("指南/入门"), { recursive: true });
      await sync();
      writeFileSync(copy("指南/入门/第一步.md"), "# 第一步：打开\n\n正文。\n");
      writeFileSync(copy("顶层.md"), "没有标题\n");
      writeFileSync(copy("assets-不算.txt"), "不是页面\n");
      const output = await ok(["commit"], inCopy());
      expect(output).toContain("created   指南/入门/第一步.md");
      expect(output).toContain("created   顶层.md");
      expect(output).not.toContain("assets-不算");
      const titleOf = async (path: string) => {
        const { id } = (await admin.json("GET", `/api/v1/spaces/${space}/resolve?path=${encodeURIComponent(path)}`))
          .data;
        return (await admin.json("GET", `/api/v1/documents/${id}`)).data.document.title;
      };
      expect(await titleOf("指南/入门/第一步")).toBe("第一步：打开");
      expect(await titleOf("顶层")).toBe("顶层");
      await sync();
      expect(await ok(["status"], inCopy())).toContain("Nothing changed");
      expect(read("指南/入门.md")).toBe("");
    });

    it("says why a bad file name was refused, and still does the rest", async () => {
      await sync();
      writeFileSync(copy("好的.md"), "好\n");
      writeFileSync(copy("坏 名字.md"), "坏\n");
      const result = await run(["commit"], inCopy());
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("created   好的.md");
      expect(result.stdout).toContain("failed    坏 名字.md: SLUG_INVALID");
    });

    it("deletes a page only when told to", async () => {
      const page = await create("要删");
      await sync();
      rmSync(copy("要删.md"));
      expect(await ok(["status"], inCopy())).toContain("deleted   要删.md");
      expect(await ok(["commit"], inCopy())).toContain("skipped   要删.md");
      expect((await admin.json("GET", `/api/v1/documents/${page.id}`)).status).toBe(200);
      // Syncing does not bring it back while that decision is open.
      await sync();
      expect(existsSync(copy("要删.md"))).toBe(false);
      expect(await ok(["commit", "--delete"], inCopy())).toContain("deleted   要删.md");
      expect((await admin.json("GET", `/api/v1/documents/${page.id}`)).status).toBe(404);
      expect(await ok(["status"], inCopy())).toContain("Nothing changed");
    });

    it("commits only what was named, from anywhere in the copy", async () => {
      const first = await create("一", "一\n");
      const second = await create("二", "二\n", { parentPath: "一" });
      await sync();
      writeFileSync(copy("一.md"), "一改\n");
      writeFileSync(copy("一/二.md"), "二改\n");
      expect(await ok(["commit", "二.md"], { cwd: copy("一") })).toContain("saved     一/二.md");
      expect(await serverText(first.id)).toBe("一\n");
      expect(await serverText(second.id)).toBe("二改\n");
      expect((await run(["commit", "../../外面.md"], inCopy())).code).toBe(2);
    });

    it("can propose instead of save, when someone wants a review", async () => {
      const page = await create("评审");
      await sync();
      writeFileSync(copy("评审.md"), "请看看\n");
      expect(await ok(["commit", "--propose", "-m", "请看"], inCopy())).toContain("proposed  评审.md");
      expect(await serverText(page.id)).toBe("评审 的内容\n");
      const pending = (await admin.json("GET", `/api/v1/documents/${page.id}/proposals?status=pending`)).data;
      expect(pending).toHaveLength(1);
      expect(pending[0].rationale).toBe("请看");
    });
  });

  describe("importing other kinds of file", () => {
    const fileOf = (name: string, bytes: Uint8Array) => {
      const path = join(work, name);
      writeFileSync(path, bytes);
      return path;
    };

    it("makes a draft for review, or a page when asked to and allowed", async () => {
      const file = fileOf("退货流程.docx", docx());
      const draft = await run(["import", space, file]);
      expect(draft.code, draft.stderr).toBe(0);
      expect(draft.stdout).toContain("draft     退货流程.docx");

      const published = await run(["import", space, file, "--publish", "--as", "规章/退货"]);
      expect(published.stderr).toBe("");
      expect(published.stdout).toContain("published 退货流程.docx");
    }, 30_000);

    it("replaces a page when told which", async () => {
      const page = await create("季报", "旧内容\n");
      const result = await run([
        "import",
        space,
        fileOf("季报.pdf", pdf("New quarterly figures")),
        "--to",
        "季报",
        "--publish"
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(await serverText(page.id)).toContain("New quarterly figures");
    }, 30_000);

    it("says why a file cannot be done, and warns about what it could only partly do", async () => {
      const refused = await run(["import", space, fileOf("旧.doc", new TextEncoder().encode("old format"))]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("OLD_OFFICE_FORMAT");
      const scanned = await run(["import", space, fileOf("扫描.pdf", blankPdf()), "--publish", "--as", "扫描"]);
      expect(scanned.code, scanned.stderr).toBe(0);
      expect(scanned.stderr).toContain("almost no text");
    }, 30_000);

    it("cannot be asked to do two things", async () => {
      expect((await run(["import", space, "a.docx", "--as", "x", "--to", "y"])).code).toBe(2);
    });

    it("leaves an agent with a draft, however it asks", async () => {
      const result = await run(["import", space, fileOf("投稿.docx", docx()), "--publish"], { token: agentToken });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("converted, but could not publish");
    }, 30_000);
  });

  describe("an agent working on files", () => {
    const asAgent = () => ({ token: agentToken, cwd: copy() });

    it("proposes its edits, once, and a person decides", async () => {
      const page = await create("待办", "# 待办\n\n旧的。\n");
      await ok(["sync", space], { token: agentToken });
      writeFileSync(copy("待办.md"), "# 待办\n\n新的。\n");
      expect(await ok(["commit", "-m", "更新"], asAgent())).toContain("proposed  待办.md");
      expect(await serverText(page.id)).toBe("# 待办\n\n旧的。\n");
      expect(await ok(["commit"], asAgent())).toContain("already proposed");
      const pending = (await admin.json("GET", `/api/v1/documents/${page.id}/proposals?status=pending`)).data;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ authorKind: "agent" });

      const decided = await admin.json(
        "POST",
        `/api/v1/proposals/${pending[0].id}/decide`,
        { decision: "accept" },
        { "idempotency-key": crypto.randomUUID() }
      );
      expect(decided.status).toBe(200);
      await ok(["sync", space], { token: agentToken });
      expect(await ok(["status"], asAgent())).toContain("Nothing changed");
    });

    it("can send everything it changed as one change set, for a person to merge in one go", async () => {
      const first = await create("第一篇", "第一篇旧文。\n");
      const second = await create("第二篇", "第二篇旧文。\n");
      const gone = await create("要去掉", "没用了。\n");
      await ok(["sync", space], { token: agentToken });
      writeFileSync(copy("第一篇.md"), "第一篇新文。\n");
      writeFileSync(copy("第二篇.md"), "第二篇新文。\n");
      writeFileSync(copy("第三篇.md"), "# 第三篇\n\n全新的。\n");
      rmSync(copy("要去掉.md"));

      const output = await ok(["commit", "--change-set", "一起改", "-m", "因为要一起改", "--delete"], asAgent());
      for (const file of ["第一篇.md", "第二篇.md", "第三篇.md", "要去掉.md"])
        expect(output).toContain(`added     ${file}`);
      const id = /([0-9a-f]{8}-[0-9a-f-]{27})/u.exec(output)![1]!;
      expect(await serverText(first.id)).toBe("第一篇旧文。\n");

      const { data: detail } = await admin.json("GET", `/api/v1/change-sets/${id}`);
      expect(detail).toMatchObject({
        title: "一起改",
        description: "因为要一起改",
        authorKind: "agent",
        status: "open"
      });
      expect(detail.pages.map((page: { kind: string; path: string }) => `${page.kind} ${page.path}`).sort()).toEqual([
        "create 第三篇",
        "delete 要去掉",
        "edit 第一篇",
        "edit 第二篇"
      ]);

      writeFileSync(copy("第二篇.md"), "第二篇再改。\n");
      const more = await ok(["commit", "--to-change-set", id, "--delete"], asAgent());
      expect(more).toContain("added     第二篇.md");
      expect(more).toContain("already in the change set");

      expect((await admin.json("POST", `/api/v1/change-sets/${id}/merge`)).status).toBe(200);
      expect(await serverText(first.id)).toBe("第一篇新文。\n");
      expect(await serverText(second.id)).toBe("第二篇再改。\n");
      expect((await admin.json("GET", `/api/v1/documents/${gone.id}`)).status).toBe(404);
      await ok(["sync", space], { token: agentToken });
      expect(await ok(["status"], asAgent())).toContain("Nothing changed");
    });

    it("will not be told to make a change set and add to one at once", async () => {
      await ok(["sync", space], { token: agentToken });
      const refused = await run(["commit", "--change-set", "新的", "--to-change-set", "abc"], asAgent());
      expect(refused.code).toBe(2);
    });

    it("sends new pages for review, and cannot delete", async () => {
      const page = await create("不能删");
      await ok(["sync", space], { token: agentToken });
      writeFileSync(copy("新页.md"), "# 新页\n\n内容。\n");
      const output = await ok(["commit"], asAgent());
      expect(output).toContain("submitted 新页.md");
      expect(await ok(["commit"], asAgent())).toContain("already submitted");
      expect(
        (await admin.json("GET", `/api/v1/spaces/${space}/imports`)).data.filter(
          (job: { filename: string }) => job.filename === "新页.md"
        )
      ).toHaveLength(1);

      rmSync(copy("不能删.md"));
      const refused = await run(["commit", "不能删.md", "--delete"], asAgent());
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain("an agent cannot delete");
      expect((await admin.json("GET", `/api/v1/documents/${page.id}`)).status).toBe(200);
    });
  });

  describe("watching", () => {
    const stopped = (child: ReturnType<typeof start>) =>
      new Promise<number | null>(done => {
        child.on("close", code => done(code));
        child.kill("SIGTERM");
      });

    it("keeps a copy up to date as things change, and stops cleanly", async () => {
      const page = await create("跟着变");
      const child = start(["sync", space, "--watch"]);
      let stderr = "";
      child.stderr.on("data", chunk => {
        stderr += String(chunk);
      });
      try {
        await vi.waitFor(() => expect(read("跟着变.md")).toBe("跟着变 的内容\n"), { timeout: 10_000, interval: 50 });
        const saved = Date.now();
        await save(page.id, "第二版\n", 1);
        await vi.waitFor(() => expect(read("跟着变.md")).toBe("第二版\n"), { timeout: 8000, interval: 20 });
        expect(Date.now() - saved).toBeLessThan(3000);
        await create("新页面");
        await vi.waitFor(() => expect(read("新页面.md")).toBe("新页面 的内容\n"), { timeout: 8000, interval: 20 });
        // Work here survives while it runs too.
        writeFileSync(copy("跟着变.md"), "我的修改\n");
        await create("再来一页");
        await vi.waitFor(() => expect(read("再来一页.md")).toBe("再来一页 的内容\n"), { timeout: 8000, interval: 20 });
        expect(read("跟着变.md")).toBe("我的修改\n");
      } finally {
        expect(await stopped(child)).toBe(0);
      }
      expect(stderr).toBe("");
    }, 40_000);

    it("stops when its token stops working, instead of retrying forever", async () => {
      const made = (await admin.json("POST", "/api/v1/account/tokens", { name: "短命", scopes: ["read"] })).data;
      await admin.json("DELETE", `/api/v1/account/tokens/${made.record.id}`);
      const result = await run(["sync", space, "--watch"], { token: made.token });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("TOKEN_INVALID");
    }, 20_000);
  });

  describe("from a shared directory", () => {
    let shared = "";
    const publish = () =>
      createPublisher({
        services: server.runtime.services,
        dir: shared,
        spaces: "*",
        packIntervalMs: 0,
        log: () => undefined
      }).publish(space);
    beforeEach(() => {
      shared = mkdtempSync(join(home, "shared-"));
    });

    it("works with no server at all, using the pack for most of it", async () => {
      await create("甲");
      const later = await create("乙");
      await publish();
      // The pack stays at this version while the files move on, as it does between its rounds.
      const pack = readFileSync(join(shared, space, ".pandocs/pack.tar.gz"));
      await save(later.id, "乙的第二版\n", 1);
      await publish();
      writeFileSync(join(shared, space, ".pandocs/pack.tar.gz"), pack);

      const out = await ok(["sync", space, "--from", join(shared, space)], { token: null, server: null });
      expect(out).toContain("is up to date");
      expect(read("甲.md")).toBe("甲 的内容\n");
      expect(read("乙.md")).toBe("乙的第二版\n");
      expect(await ok(["status"], { ...inCopy(), token: null, server: null })).toContain("Nothing changed");
      // A later page on the server does not exist here until it is published.
      const newer = await create("丙");
      await ok(["sync", space, "--from", join(shared, space)], { token: null, server: null });
      expect(existsSync(copy("丙.md"))).toBe(false);
      await publish();
      await ok(["sync", space, "--from", join(shared, space)], { token: null, server: null });
      expect(read("丙.md")).toBe("丙 的内容\n");
      expect(newer.path).toBe("丙");
    });

    it("takes a head start from it when there is a server too, which still has the last word", async () => {
      await create("甲");
      await publish();
      await create("受限", "只有服务器有\n", { restricted: true });
      const later = await create("新的");
      const out = await ok(["sync", space, "--from", join(shared, space)]);
      expect(out).toContain("is up to date");
      expect(read("甲.md")).toBe("甲 的内容\n");
      expect(read("受限.md")).toBe("只有服务器有\n");
      expect(read("新的.md")).toBe("新的 的内容\n");
      expect(later.path).toBe("新的");
    });

    it("notices new content by polling the one small file", async () => {
      await create("甲");
      const page = await create("乙");
      await publish();
      const child = start(["sync", space, "--watch", "--from", join(shared, space)], { token: null, server: null });
      try {
        await vi.waitFor(() => expect(read("乙.md")).toBe("乙 的内容\n"), { timeout: 10_000, interval: 50 });
        await save(page.id, "乙的第二版\n", 1);
        await publish();
        await vi.waitFor(() => expect(read("乙.md")).toBe("乙的第二版\n"), { timeout: 8000, interval: 50 });
      } finally {
        child.kill("SIGTERM");
      }
    }, 30_000);

    it("says what is wrong with a directory that is not a published space", async () => {
      const result = await run(["sync", space, "--from", shared], { token: null, server: null });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("does not look like a published space");
    });
  });

  describe("as an MCP server over stdio", () => {
    /** Sends messages one at a time, the way an MCP client does, and collects the answers by id. */
    const session = (token: string) => {
      const child = start(["mcp"], { token });
      const answers = new Map<number, any>();
      let buffer = "";
      child.stdout.on("data", chunk => {
        buffer += String(chunk);
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const answer = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          answers.set(answer.id, answer);
        }
      });
      let nextId = 1;
      const request = async (method: string, params: object = {}) => {
        const id = nextId++;
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        await vi.waitFor(() => expect(answers.has(id)).toBe(true), { timeout: 8000, interval: 10 });
        return answers.get(id);
      };
      const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
      return { child, request, notify };
    };

    it("offers the server's tools and runs them, and an agent gets only what an agent may do", async () => {
      const page = await create("工具");
      const agent = session(agentToken);
      try {
        const hello = await agent.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "测试", version: "1" }
        });
        expect(hello.result.serverInfo.name).toBe("pandocs");
        agent.notify("notifications/initialized");
        const {
          result: { tools }
        } = await agent.request("tools/list");
        const names = tools.map((tool: { name: string }) => tool.name);
        expect(names).toContain("doc_get");
        expect(names).toContain("proposal_create");
        expect(names).not.toContain("doc_save");
        const called = await agent.request("tools/call", { name: "doc_get", arguments: { doc: page.id } });
        expect(called.result.isError ?? false).toBe(false);
        expect(called.result.structuredContent.data.markdown).toContain("工具 的内容");
      } finally {
        agent.child.stdin.end();
      }
      expect(await new Promise(done => agent.child.on("close", done))).toBe(0);
    }, 30_000);

    it("answers with an error when the server refuses, so the client is not left waiting", async () => {
      const refused = session("pd_not_a_real_token");
      try {
        const answer = await refused.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "测试", version: "1" }
        });
        expect(answer.error.message).toContain("TOKEN_INVALID");
      } finally {
        refused.child.stdin.end();
      }
    }, 30_000);
  });

  it("still works after its folder is moved", async () => {
    await create("一页");
    await sync();
    const moved = `${copy()}-moved`;
    renameSync(copy(), moved);
    expect(await ok(["status"], { cwd: moved })).toContain("Nothing changed");
  });
});
