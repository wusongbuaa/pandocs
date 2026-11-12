import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@pandocs/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const PNG2 = new Uint8Array([...PNG, 0]);

describe("the change feed and spaces as files", () => {
  let h: ReturnType<typeof createHarness>;
  let spaceId: string;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    spaceId = (await h.call(USERS.admin, "POST", "spaces", { slug: "books", name: "书", defaultRole: "viewer" })).data.id;
    await h.call(USERS.admin, "PUT", "spaces/books/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    await h.call(USERS.admin, "PUT", "spaces/books/members", { subject: `user:${USERS.commenter.id}`, role: "commenter" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "closed", name: "内部", defaultRole: "none" });
  });
  afterAll(async () => {
    expect(h.errors).toEqual([]);
    await h.close();
  });

  const create = async (slug: string, markdown = "正文\n", extra: object = {}) => {
    const result = await h.call(USERS.editor, "POST", "spaces/books/documents", { title: slug, slug, markdown, ...extra });
    expect(result.status).toBe(201);
    return result.data.document as { id: string; path: string };
  };
  const feed = async (principal: Principal = USERS.reader, since = "0") => (await h.call(principal, "GET", `changes?since=${since}`)).data as { changes: any[]; next: string; reset: boolean };
  const end = async () => (await feed(USERS.admin)).next;
  /** The feed from here on, by asking until there is nothing new. */
  const after = async (position: string, principal: Principal = USERS.admin) => (await feed(principal, position)).changes;

  describe("what it records", () => {
    it("says when a page is created, changed, moved and deleted, and only then", async () => {
      const start = await end();
      const page = await create("一页");
      await h.write(USERS.editor, "PUT", `documents/${page.id}/content`, { markdown: "新的\n", expectedRevision: 1 });
      await h.call(USERS.editor, "POST", `documents/${page.id}/move`, { slug: "另一页" });
      const before = await end();
      // Saying someone is editing changes nothing a reader of the document can see.
      await h.call(USERS.editor, "PUT", `documents/${page.id}/editing`, {});
      expect(await after(before)).toEqual([]);
      await h.call(USERS.editor, "DELETE", `documents/${page.id}`);

      const rows = (await after(start)).filter(row => row.documentId === page.id);
      expect(rows.map(row => [row.kind, row.revision, row.path, row.deleted])).toEqual([
        ["document", 1, "一页", false],
        ["document", 2, "一页", false],
        ["document", 2, "另一页", false],
        ["document", 2, "另一页", true]
      ]);
      expect(rows[0].spaceSlug).toBe("books");
    });

    it("says when people talk on a page, but not when a new revision just moves their anchors along", async () => {
      const page = await create("讨论", "第一段。\n\n第二段。\n");
      const start = await end();
      const thread = (await h.call(USERS.commenter, "POST", `documents/${page.id}/threads`, { anchor: { kind: "block", ref: "b1" }, body: "这里要确认" })).data;
      expect(thread.id).toBeTruthy();
      const started = await after(start);
      expect(started.length).toBeGreaterThan(0);
      expect(started.every(row => row.kind === "discussion" && row.documentId === page.id)).toBe(true);

      const commented = await end();
      await h.call(USERS.editor, "POST", `threads/${thread.id}/comments`, { body: "确认了" });
      expect((await after(commented)).map(row => row.kind)).toEqual(["discussion"]);

      const saved = await end();
      await h.write(USERS.editor, "PUT", `documents/${page.id}/content`, { markdown: "第一段。\n\n第二段。\n\n第三段。\n", expectedRevision: 1 });
      expect((await after(saved)).map(row => row.kind)).toEqual(["document"]);

      const resolved = await end();
      await h.call(USERS.editor, "POST", `threads/${thread.id}/resolve`);
      expect((await after(resolved)).map(row => row.kind)).toEqual(["discussion"]);

      const proposed = await end();
      await h.write(USERS.commenter, "POST", `documents/${page.id}/proposals`, { baseRevision: 2, markdown: "第一段。\n\n改过。\n\n第三段。\n" });
      expect((await after(proposed)).map(row => row.kind)).toEqual(["discussion"]);
    });
  });

  describe("reading it while other transactions are open", () => {
    /** Two connections, so the test decides who gets which transaction id and who commits when. */
    const connect = async () => {
      const client = new pg.Client({ connectionString: fixture.getConnectionString() });
      await client.connect();
      return client;
    };
    const logRow = (client: pg.Client, path: string) => client.query(`INSERT INTO pandocs.change_log (space_id, kind, path) VALUES ($1, 'document', $2)`, [spaceId, path]);

    it("does not skip a row that took a lower number and committed later", async () => {
      const early = await connect();
      const late = await connect();
      try {
        await early.query("BEGIN");
        await early.query("SELECT pg_current_xact_id()");
        await late.query("BEGIN");
        await late.query("SELECT pg_current_xact_id()");
        // The later transaction writes first, so it has the lower seq.
        await logRow(late, "write-first");
        await logRow(early, "write-second");
        const start = await end();
        await early.query("COMMIT");

        const first = await feed(USERS.admin, start);
        expect(first.changes.map(row => row.path)).toEqual(["write-second"]);

        await late.query("COMMIT");
        const second = await feed(USERS.admin, first.next);
        expect(second.changes.map(row => row.path)).toEqual(["write-first"]);
      } finally {
        await early.end();
        await late.end();
      }
    });

    it("holds back what comes after a transaction still open, and hands all of it over once it ends", async () => {
      const open = await connect();
      try {
        const start = await end();
        await open.query("BEGIN");
        await logRow(open, "slow");
        const page = await create("等一等");
        expect((await feed(USERS.admin, start)).changes.map(row => row.path)).toEqual([]);
        // The watermark stays behind it too, so a reader starting now does not begin past that row.
        expect(await h.services.changes.watermark()).toBe(start);

        await open.query("COMMIT");
        const rows = (await feed(USERS.admin, start)).changes;
        expect(rows.map(row => row.path)).toEqual(["slow", page.path]);
      } finally {
        await open.end();
      }
    });
  });

  it("knows the order of transaction numbers when they get longer", async () => {
    const { rows: [low] } = await h.pool.query(`INSERT INTO pandocs.change_log (xid, space_id, kind, path) VALUES ('9'::xid8, $1, 'document', 'short-number') RETURNING seq::text`, [spaceId]);
    const page = await create("长编号之后");
    const latest = await end();
    expect(await h.services.changes.watermark()).toBe(latest);
    expect(latest).not.toBe(`9.${low.seq}`);
    expect((await feed(USERS.admin, latest)).changes).toEqual([]);
    expect(page.path).toBe("长编号之后");
    await h.pool.query(`DELETE FROM pandocs.change_log WHERE path = 'short-number'`);
  });

  describe("who sees what", () => {
    it("leaves out spaces and restricted pages a person cannot read", async () => {
      const start = await end();
      const open = await create("公开");
      const locked = (await h.call(USERS.admin, "POST", "spaces/books/documents", { title: "受限", slug: "受限", markdown: "秘密\n", restricted: true })).data.document;
      await h.call(USERS.admin, "PUT", `documents/${locked.id}/members`, { subject: `user:${USERS.commenter.id}`, role: "viewer" });
      await h.call(USERS.admin, "POST", "spaces/closed/documents", { title: "内部", slug: "内部", markdown: "内部\n" });

      const seenBy = async (principal: Principal) => (await feed(principal, start)).changes.map(row => row.path);
      expect(await seenBy(USERS.reader)).toEqual([open.path]);
      expect(await seenBy(USERS.commenter)).toEqual([open.path, locked.path]);
      expect(await seenBy(USERS.admin)).toEqual(expect.arrayContaining([open.path, locked.path, "内部"]));
      expect((await feed(USERS.stranger, start)).changes.map(row => row.path)).toEqual([open.path]);
      // Rows hidden from you still move you along, or you would ask about them forever.
      const hidden = await end();
      await h.call(USERS.admin, "POST", "spaces/books/documents", { title: "也受限", slug: "也受限", markdown: "秘密\n", restricted: true });
      const page = await feed(USERS.reader, hidden);
      expect(page.changes).toEqual([]);
      expect(page.next).not.toBe(hidden);
      expect((await h.call(USERS.reader, "GET", "changes?space=closed")).status).toBe(404);
      expect((await feed(USERS.reader, start)).changes[0]).not.toHaveProperty("restricted");
    });

    it("tells someone who could read a page that it has gone for them once it is restricted, and stops showing them where it was", async () => {
      const page = await create("将受限");
      const start = await end();
      expect((await feed(USERS.reader)).changes.some(row => row.path === page.path)).toBe(true);
      await h.call(USERS.admin, "PATCH", `documents/${page.id}`, { restricted: true });
      expect((await feed(USERS.reader, start)).changes).toEqual([expect.objectContaining({ documentId: page.id, deleted: true, path: null })]);
      expect((await feed(USERS.reader)).changes.some(row => row.documentId === page.id && row.path !== null)).toBe(false);
      // Whoever can still read it hears that it changed, and last that it is there.
      expect((await after(start)).filter(row => row.documentId === page.id).at(-1)).toMatchObject({ deleted: false, path: page.path });
      await h.call(USERS.admin, "PATCH", `documents/${page.id}`, { restricted: false });
      expect((await feed(USERS.reader)).changes.filter(row => row.documentId === page.id).at(-1)).toMatchObject({ deleted: false, path: page.path });
    });

    it("refuses a position it could not have given out", async () => {
      for (const bad of ["abc", "1", "1.2.3", "1;drop", "99999999999999999999.1"]) {
        expect((await h.call(USERS.reader, "GET", `changes?since=${encodeURIComponent(bad)}`)).error.code).toBe("PARAM_INVALID");
      }
    });
  });

  it("tells a client that fell behind what has been cleared to start over", async () => {
    const start = await end();
    expect(start).not.toBe("0");
    expect((await feed(USERS.admin, start)).reset).toBe(false);
    await create("清理前");
    await h.pool.query(`UPDATE pandocs.change_log SET created_at = now() - interval '31 days'`);
    await h.services.changes.sweep();
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM pandocs.change_log`)).rows[0].n).toBe(0);
    await create("清理后");
    const page = await feed(USERS.admin, start);
    expect(page.reset).toBe(true);
    expect((await feed(USERS.admin, page.next)).reset).toBe(false);
    expect((await feed(USERS.admin, "0")).reset).toBe(false);
  });

  describe("page paths", () => {
    it("refuses names that cannot be files on every platform", async () => {
      for (const slug of ["..", ".hidden", "a/b", "a\\b", "a b", "a:b", "a?b", "a*b", "a|b", "a<b", "a\"b", "结尾.", "x.md", "X.MD", "con", "NUL", "com1", "lpt9.txt", "\u0001x", "长".repeat(81)]) {
        const result = await h.call(USERS.editor, "POST", "spaces/books/documents", { title: "坏名字", slug, markdown: "正文\n" });
        expect(result.error?.code, slug).toBe("SLUG_INVALID");
      }
      const page = await create("可以改名");
      expect((await h.call(USERS.editor, "POST", `documents/${page.id}/move`, { slug: "../逃出去" })).error.code).toBe("SLUG_INVALID");
      expect((await h.call(USERS.editor, "POST", `documents/${page.id}/move`, { slug: "console" })).status).toBe(200);
    });

    it("refuses addresses the site could not open, or would open as another page", async () => {
      const parent = await create("上级");
      for (const [slug, parentPath] of [["discount-50%", undefined], ["a#b", undefined], ["guide.html", undefined], ["GUIDE.HTML", undefined], ["Index", undefined], ["index", parent.path], ["INDEX", parent.path]] as const) {
        const result = await h.call(USERS.editor, "POST", "spaces/books/documents", { title: "坏地址", slug, markdown: "正文\n", ...(parentPath ? { parentPath } : {}) });
        expect(result.error?.code, `${parentPath ?? ""}/${slug}`).toBe("SLUG_INVALID");
      }
      expect((await h.call(USERS.editor, "POST", `documents/${parent.id}/move`, { slug: "50%" })).error?.code).toBe("SLUG_INVALID");
      // The front page of a space is the one page called index.
      expect((await h.call(USERS.editor, "POST", "spaces/books/documents", { title: "首页", slug: "index", markdown: "正文\n" })).status).toBe(201);
    });

    it("cuts a long title down to a name that fits", async () => {
      const result = await h.call(USERS.editor, "POST", "spaces/books/documents", { title: "很长的标题".repeat(30), markdown: "正文\n" });
      expect(result.status).toBe(201);
      expect(Buffer.byteLength(result.data.document.path)).toBeLessThanOrEqual(240);
    });

    it("does not let two pages differ only by case, as some file systems could not hold both", async () => {
      const page = await create("Guide");
      expect((await h.call(USERS.editor, "POST", "spaces/books/documents", { title: "guide", slug: "guide", markdown: "x\n" })).error.code).toBe("DOCUMENT_PATH_TAKEN");
      const other = await create("Other");
      expect((await h.call(USERS.editor, "POST", `documents/${other.id}/move`, { slug: "GUIDE" })).error.code).toBe("DOCUMENT_PATH_TAKEN");
      // Changing only the case of its own name is not a clash with anything.
      expect((await h.call(USERS.editor, "POST", `documents/${page.id}/move`, { slug: "guide" })).status).toBe(200);
      await h.call(USERS.editor, "DELETE", `documents/${page.id}`);
      const replaced = await create("GUIDE");
      const restored = await h.call(USERS.editor, "POST", `documents/${page.id}/restore`);
      expect(restored.status).toBe(200);
      expect(restored.data.path.toLowerCase()).not.toBe(replaced.path.toLowerCase());
    });
  });

  describe("a space as files", () => {
    const SPACE = "files";
    let usedByOpen: string;
    let usedByLocked: string;
    let unused: string;
    let open: { id: string };
    let locked: { id: string };

    beforeAll(async () => {
      await h.call(USERS.admin, "POST", "spaces", { slug: SPACE, name: "文件", defaultRole: "viewer" });
      const upload = async (bytes: Uint8Array, filename: string) => (await h.call(USERS.admin, "POST", `spaces/${SPACE}/assets?filename=${filename}`, bytes)).data.path as string;
      usedByOpen = await upload(PNG, "a.png");
      usedByLocked = await upload(PNG2, "b.png");
      unused = await upload(new Uint8Array([...PNG, 1]), "c.png");
      open = (await h.call(USERS.admin, "POST", `spaces/${SPACE}/documents`, { title: "公开", slug: "公开", markdown: `![图](${usedByOpen})\n` })).data.document;
      await h.call(USERS.admin, "POST", `spaces/${SPACE}/documents`, { title: "子页", slug: "子页", parentPath: "公开", markdown: "子页\n" });
      locked = (await h.call(USERS.admin, "POST", `spaces/${SPACE}/documents`, { title: "受限", slug: "受限", markdown: `秘密 ![图](${usedByLocked})\n`, restricted: true })).data.document;
    });

    const paths = (manifest: { readonly files: readonly { readonly path: string }[] }) => manifest.files.map(file => file.path);

    it("lists what this person can read, with the uploads those pages use", async () => {
      const forReader = (await h.call(USERS.reader, "GET", `spaces/${SPACE}/manifest`)).data;
      expect(paths(forReader)).toEqual(["公开.md", "公开/子页.md", usedByOpen]);
      expect(forReader.files[0]).toMatchObject({ kind: "document", documentId: open.id, revision: 1, title: "公开", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(forReader.files[2]).toMatchObject({ kind: "asset", size: PNG.length });

      const forAdmin = (await h.call(USERS.admin, "GET", `spaces/${SPACE}/manifest`)).data;
      expect(paths(forAdmin)).toEqual(expect.arrayContaining(["受限.md", usedByLocked]));
      expect(paths(forAdmin)).not.toContain(unused);
      expect((await h.call(USERS.stranger, "GET", "spaces/closed/manifest")).status).toBe(404);
    });

    it("keeps restricted pages and their images out of what a shared directory gets", async () => {
      const published = await h.services.changes.publishedManifest(SPACE);
      expect(paths(published!)).toEqual(["公开.md", "公开/子页.md", usedByOpen]);
      expect(published!.files.every(file => !file.restricted)).toBe(true);
    });

    it("gives an image to the public copy once a public page uses it, and takes it back when that stops", async () => {
      await h.write(USERS.admin, "PUT", `documents/${open.id}/content`, { markdown: `![图](${usedByOpen}) ![也用](${usedByLocked})\n`, expectedRevision: 1 });
      expect(paths((await h.services.changes.publishedManifest(SPACE))!)).toContain(usedByLocked);
      await h.write(USERS.admin, "PUT", `documents/${open.id}/content`, { markdown: `![图](${usedByOpen})\n`, expectedRevision: 2 });
      expect(paths((await h.services.changes.publishedManifest(SPACE))!)).not.toContain(usedByLocked);
    });

    it("packs what this person can read so that ordinary tools can unpack it", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pandocs-snapshot-"));
      try {
        const longName = "很长的路径名".repeat(10);
        await h.call(USERS.admin, "POST", `spaces/${SPACE}/documents`, { title: "长名字", slug: longName, parentPath: "公开", markdown: "长名字的内容\n" });
        const { response } = await h.call(USERS.reader, "GET", `spaces/${SPACE}/snapshot`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/gzip");
        const bytes = new Uint8Array(await response.arrayBuffer());
        const unpacked = spawnSync("tar", ["-xzf", "-", "-C", dir], { input: bytes });
        expect(unpacked.stderr.toString()).toBe("");
        expect(unpacked.status).toBe(0);
        expect(readFileSync(join(dir, "公开/子页.md"), "utf8")).toBe("子页\n");
        expect(readFileSync(join(dir, `公开/${longName}.md`), "utf8")).toBe("长名字的内容\n");
        const manifest = JSON.parse(readFileSync(join(dir, ".pandocs/MANIFEST.json"), "utf8"));
        expect(manifest.cursor).toBe(response.headers.get("x-pandocs-cursor"));
        expect(paths(manifest)).not.toContain("受限.md");
        expect(() => readFileSync(join(dir, "受限.md"))).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("proposing from a whole text", () => {
    let page: { id: string };
    beforeEach(async () => {
      page = await create(`提案-${Date.now()}`, "# 标题\n\n第一段。\n\n第二段。\n");
    });

    it("works out what changed by block, so the reviewer can take it piece by piece", async () => {
      const edited = "# 标题\n\n第一段，改过。\n\n第二段。\n\n新的一段。\n";
      const proposal = await h.write(USERS.agent, "POST", `documents/${page.id}/proposals`, { baseRevision: 1, markdown: edited });
      expect(proposal.status).toBe(201);
      expect(proposal.data.ops.length).toBe(2);
      const accepted = await h.write(USERS.editor, "POST", `proposals/${proposal.data.id}/decide`, { decision: "accept" });
      expect(accepted.status).toBe(200);
      expect((await h.call(USERS.reader, "GET", `documents/${page.id}`)).data.markdown).toBe(edited);
    });

    it("refuses a proposal that changes nothing, or says nothing", async () => {
      const same = await h.write(USERS.agent, "POST", `documents/${page.id}/proposals`, { baseRevision: 1, markdown: "# 标题\n\n第一段。\n\n第二段。\n" });
      expect(same.error.code).toBe("PROPOSAL_EMPTY");
      const empty = await h.write(USERS.agent, "POST", `documents/${page.id}/proposals`, { baseRevision: 1 });
      expect(empty.error.code).toBe("PROPOSAL_EMPTY");
    });

    it("offers the same through the tools", async () => {
      const tool = await h.call(USERS.agent, "POST", "tools/proposal_create", { doc: page.id, baseRevision: 1, markdown: "# 标题\n\n第一段，改过。\n\n第二段。\n" });
      expect(tool.status).toBe(200);
      expect(tool.data.ops.length).toBe(1);
    });
  });
});
