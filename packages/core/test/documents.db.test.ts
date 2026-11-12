import { randomUUID } from "node:crypto";
import type { Principal } from "@pandocs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { BASE, createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const SOURCE = "# 第一章\n\n段落一\n\n## 小节\n\n段落二\n\n# 第二章\n\n段落三\n";

describe("documents, versions and access", () => {
  let h: ReturnType<typeof createHarness>;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    expect((await h.call(USERS.admin, "POST", "spaces", { slug: "handbook", name: "手册", defaultRole: "none" })).status).toBe(201);
    for (const [subject, role] of [["everyone", "viewer"], [`user:${USERS.editor.id}`, "editor"], [`user:${USERS.commenter.id}`, "commenter"]] as const) {
      expect((await h.call(USERS.admin, "PUT", "spaces/handbook/members", { subject, role })).status).toBe(200);
    }
  });
  afterAll(async () => {
    expect(h.errors).toEqual([]);
    await h.close();
  });

  const createDoc = async (title: string, markdown = SOURCE, extra: object = {}) => {
    const result = await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title, markdown, ...extra });
    expect(result.status).toBe(201);
    return result.data as { document: { id: string; path: string }; revision: { no: number } };
  };

  it("hides spaces and documents from people without access", async () => {
    await h.call(USERS.admin, "POST", "spaces", { slug: "secret", name: "内部", defaultRole: "none" });
    expect((await h.call(USERS.reader, "GET", "spaces")).data.map((space: { slug: string }) => space.slug)).toEqual(["handbook"]);
    expect((await h.call(USERS.reader, "GET", "spaces/secret")).status).toBe(404);
    expect((await h.call(USERS.reader, "POST", "spaces", { slug: "mine", name: "我的" })).status).toBe(403);
  });

  it("creates documents under a parent with readable paths", async () => {
    const parent = await createDoc("一、入门");
    expect(parent.document.path).toBe("一入门");
    const child = await createDoc("认识 Pandocs", "内容\n", { parentPath: parent.document.path });
    expect(child.document.path).toBe("一入门/认识-pandocs");
    expect((await h.call(USERS.reader, "GET", `spaces/handbook/resolve?path=${encodeURIComponent(child.document.path)}`)).data.id).toBe(child.document.id);
    expect((await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "认识 Pandocs", markdown: "", parentPath: parent.document.path })).error.code).toBe("DOCUMENT_PATH_TAKEN");
    expect((await h.call(USERS.commenter, "POST", "spaces/handbook/documents", { title: "无权", markdown: "" })).status).toBe(403);
  });

  it("reads by scope and serves the raw source", async () => {
    const { document } = await createDoc("范围读取");
    const outline = await h.call(USERS.reader, "GET", `documents/${document.id}?scope=outline`);
    expect(outline.data.outline.map((item: { text: string }) => item.text)).toEqual(["第一章", "小节", "第二章"]);
    expect(outline.data.markdown).toBeUndefined();
    const section = await h.call(USERS.reader, "GET", `documents/${document.id}?scope=section&section=${encodeURIComponent("第二章")}`);
    expect(section.data.blocks.map((block: { markdown: string }) => block.markdown)).toEqual(["# 第二章", "段落三"]);
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}?scope=section&section=x`)).error.code).toBe("SECTION_NOT_FOUND");
    // Only the blocks that match, or up to five either side of them, as the MCP tool allows.
    const exact = await h.call(USERS.reader, "GET", `documents/${document.id}?scope=keyword&keyword=${encodeURIComponent("段落二")}&context=0`);
    expect(exact.data.blocks.map((block: { markdown: string }) => block.markdown)).toEqual(["段落二"]);
    const around = await h.call(USERS.reader, "GET", `documents/${document.id}?scope=keyword&keyword=${encodeURIComponent("段落二")}&context=1`);
    expect(around.data.blocks.map((block: { markdown: string }) => block.markdown)).toEqual(["## 小节", "段落二", "# 第二章"]);
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}?scope=keyword&keyword=x&context=6`)).error.code).toBe("PARAM_INVALID");
    const raw = await h.call(USERS.reader, "GET", `documents/${document.id}/content`);
    expect(await raw.response.text()).toBe(SOURCE);
    expect(raw.response.headers.get("x-pandocs-revision")).toBe("1");
  });

  it("gives an address to one of two people asking for it at once, and tells the other it is taken", async () => {
    const both = await Promise.all([1, 2].map(() => h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "同时", slug: "at-once" })));
    expect(both.map(answer => answer.status).sort()).toEqual([201, 409]);
    expect(both.find(answer => answer.status === 409)!.error.code).toBe("DOCUMENT_PATH_TAKEN");
  });

  it("runs a write once for a key, however close together the copies of it come", async () => {
    const { document } = await createDoc("同一个键");
    const path = `documents/${document.id}/ops`;
    // Sent twice at once, as a client retrying too early would: it runs once, and the other is told it is under way.
    const body = { ops: [{ op: "str_replace", pattern: "段落二", content: "又一段" }], expectedRevision: 1 };
    const key = randomUUID();
    const both = await Promise.all([h.call(USERS.editor, "POST", path, body, { "idempotency-key": key }), h.call(USERS.editor, "POST", path, body, { "idempotency-key": key })]);
    expect(both.map(answer => (answer.status === 200 ? answer.data.revision.no : answer.error.code)).sort()).toEqual([2, "IDEMPOTENCY_KEY_IN_USE"].sort());
    expect((await h.call(USERS.editor, "POST", path, body, { "idempotency-key": key })).data.revision.no).toBe(2);
    // One that failed did not happen, and the same key may try again.
    const failing = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await h.call(USERS.editor, "POST", path, body, { "idempotency-key": failing })).error.code).toBe("REVISION_CONFLICT");
    }
  });

  it("protects writes with expected revision and idempotency keys", async () => {
    const { document } = await createDoc("并发写入");
    const path = `documents/${document.id}/ops`;
    const body = { ops: [{ op: "str_replace", pattern: "段落一", content: "新段落" }], expectedRevision: 1 };
    expect((await h.call(USERS.editor, "POST", path, body)).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const key = randomUUID();
    const first = await h.call(USERS.editor, "POST", path, body, { "idempotency-key": key });
    expect(first.data.revision.no).toBe(2);
    const replay = await h.call(USERS.editor, "POST", path, body, { "idempotency-key": key });
    expect(replay.data.revision.no).toBe(2);
    expect(replay.response.headers.get("idempotent-replay")).toBe("true");
    expect((await h.call(USERS.editor, "POST", path, { ...body, message: "别的" }, { "idempotency-key": key })).error.code).toBe("IDEMPOTENCY_KEY_REUSED");


    const stale = await h.write(USERS.editor, "POST", path, { ops: [{ op: "block_delete", ref: "b2" }], expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.error).toMatchObject({ code: "REVISION_CONFLICT", details: { currentRevision: 2 } });
    expect((await h.write(USERS.editor, "POST", path, { ops: [{ op: "block_delete", ref: "b99" }], expectedRevision: 2 })).error.code).toBe("BLOCK_NOT_FOUND");
    expect((await h.write(USERS.commenter, "POST", path, { ops: [{ op: "block_delete", ref: "b1" }], expectedRevision: 2 })).status).toBe(403);
    expect((await h.write(USERS.reader, "POST", path, { ops: [{ op: "block_delete", ref: "b1" }], expectedRevision: 2 })).status).toBe(403);
  });

  it("records who changed what and from which channel", async () => {
    const { document } = await createDoc("渠道");
    const viaCli = { ...USERS.editor, channel: "cli" as const };
    await h.write(viaCli, "POST", `documents/${document.id}/ops`, { ops: [{ op: "block_insert_after", ref: "end", content: "尾部" }], expectedRevision: 1, message: "加尾部" });
    const { data } = await h.call(USERS.reader, "GET", `documents/${document.id}/revisions`);
    expect(data[0]).toMatchObject({ no: 2, actorName: "编辑者", channel: "cli", message: "加尾部" });
    expect(data[1]).toMatchObject({ no: 1, channel: "web" });
    // A long history pages back from the oldest version shown.
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}/revisions?limit=1`)).data.map((item: { no: number }) => item.no)).toEqual([2]);
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}/revisions?limit=1&before=2`)).data.map((item: { no: number }) => item.no)).toEqual([1]);
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}/revisions?before=1`)).data).toEqual([]);
    const diff = await h.call(USERS.reader, "GET", `documents/${document.id}/diff?from=1&to=2`);
    expect(diff.data.patch).toContain("+尾部");
  });

  it("merges a stale save block by block and reports real conflicts", async () => {
    const { document } = await createDoc("合并");
    const path = `documents/${document.id}/content`;
    await h.write(USERS.editor, "PUT", path, { markdown: SOURCE.replace("段落三", "段落三改"), expectedRevision: 1 });

    const stale = await h.write(USERS.editor, "PUT", path, { markdown: SOURCE.replace("段落一", "段落一改"), expectedRevision: 1 });
    expect(stale.error.code).toBe("REVISION_CONFLICT");

    const merged = await h.write(USERS.editor, "PUT", path, { markdown: SOURCE.replace("段落一", "段落一改"), expectedRevision: 1, merge: true });
    expect(merged.data.merged).toBe(true);
    const text = await (await h.call(USERS.reader, "GET", `documents/${document.id}/content`)).response.text();
    expect(text).toContain("段落一改");
    expect(text).toContain("段落三改");

    const conflict = await h.write(USERS.editor, "PUT", path, { markdown: SOURCE.replace("段落三", "段落三又改"), expectedRevision: 1, merge: true });
    expect(conflict.status).toBe(409);
    expect(conflict.error.code).toBe("MERGE_CONFLICT");
  });

  it("saves a new title with the text, and on its own, without a version for the title", async () => {
    const { document } = await createDoc("原标题");
    const path = `documents/${document.id}/content`;
    const both = await h.write(USERS.editor, "PUT", path, { markdown: "新内容\n", expectedRevision: 1, title: "新标题" });
    expect(both.data).toMatchObject({ changed: true, document: { title: "新标题" }, revision: { no: 2 } });
    const titleOnly = await h.write(USERS.editor, "PUT", path, { markdown: "新内容\n", expectedRevision: 2, title: "再改标题" });
    expect(titleOnly.data).toMatchObject({ changed: false, document: { title: "再改标题" }, revision: { no: 2 } });
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}`)).data.document.title).toBe("再改标题");

    expect((await h.write(USERS.editor, "PUT", path, { markdown: "又变了\n", expectedRevision: 2, title: "   " })).status).toBe(422);
    // A save that fails leaves the title as it was.
    expect((await h.write(USERS.editor, "PUT", path, { markdown: "冲突\n", expectedRevision: 1, title: "不该生效" })).status).toBe(409);
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}`)).data.document.title).toBe("再改标题");
  });

  it("does not create a version when nothing changed", async () => {
    const { document } = await createDoc("无变化");
    const same = await h.write(USERS.editor, "PUT", `documents/${document.id}/content`, { markdown: SOURCE, expectedRevision: 1 });
    expect(same.data).toMatchObject({ changed: false, revision: { no: 1 } });
  });

  it("rolls back by writing a new version", async () => {
    const { document } = await createDoc("回滚");
    await h.write(USERS.editor, "PUT", `documents/${document.id}/content`, { markdown: "全部换掉\n", expectedRevision: 1 });
    const rollback = await h.write(USERS.editor, "POST", `documents/${document.id}/rollback`, { to: 1, expectedRevision: 2 });
    expect(rollback.data.revision).toMatchObject({ no: 3, message: "Restored version 1" });
    expect(await (await h.call(USERS.reader, "GET", `documents/${document.id}/content`)).response.text()).toBe(SOURCE);
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}?revision=2`)).data.markdown).toBe("全部换掉\n");
  });

  it("rejects invalid blocks only when asked to be strict", async () => {
    const { document } = await createDoc("校验");
    const bad = ':::column{width="9"}\n\n内容\n\n:::\n';
    const lenient = await h.write(USERS.editor, "PUT", `documents/${document.id}/content`, { markdown: bad, expectedRevision: 1 });
    expect(lenient.data.diagnostics[0].code).toBe("BLOCK_ATTR_INVALID");
    const strict = await h.write(USERS.editor, "PUT", `documents/${document.id}/content`, { markdown: `${bad}\n更多\n`, expectedRevision: 2, strict: true });
    expect(strict.error.code).toBe("DOCUMENT_INVALID");
  });

  it("never keeps a version nested too deeply to read, and says why", async () => {
    const { document } = await createDoc("太深");
    const deep = `${"> ".repeat(5000)}深\n`;
    const saved = await h.write(USERS.editor, "PUT", `documents/${document.id}/content`, { markdown: deep, expectedRevision: 1 });
    expect(saved.status).toBe(422);
    expect(saved.error.code).toBe("DOCUMENT_TOO_DEEP");
    expect((await h.call(USERS.reader, "GET", `documents/${document.id}`)).data.revision.no).toBe(1);
    const created = await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "也太深", markdown: `${":::note\n".repeat(400)}深\n${":::\n".repeat(400)}` });
    expect(created.error.code).toBe("DOCUMENT_TOO_DEEP");
  });

  it("restricts single pages to their own members", async () => {
    const admin = await h.call(USERS.admin, "POST", "spaces/handbook/documents", { title: "仅管理员", markdown: "敏感内容关键字\n", restricted: true });
    const id = admin.data.document.id as string;
    expect((await h.call(USERS.reader, "GET", `documents/${id}`)).status).toBe(404);
    expect((await h.call(USERS.editor, "GET", `documents/${id}`)).status).toBe(404);
    expect((await h.call(USERS.reader, "GET", "spaces/handbook/tree")).data.some((node: { id: string }) => node.id === id)).toBe(false);
    expect((await h.call(USERS.reader, "GET", `search?q=${encodeURIComponent("敏感内容关键字")}`)).data).toEqual([]);
    expect((await h.call(USERS.admin, "GET", `search?q=${encodeURIComponent("敏感内容关键字")}`)).data).toHaveLength(1);
    await h.call(USERS.admin, "PUT", `documents/${id}/members`, { subject: "group:leads", role: "viewer" });
    expect((await h.call({ ...USERS.reader, groups: ["leads"] }, "GET", `documents/${id}`)).status).toBe(200);
    expect((await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "受限", markdown: "", restricted: true })).status).toBe(403);
  });

  it("finds documents with a snippet", async () => {
    await createDoc("搜索目标", "这里提到独一无二的词语，后面还有内容。\n");
    const { data } = await h.call(USERS.reader, "GET", `search?q=${encodeURIComponent("独一无二")}&space=handbook`);
    expect(data[0]).toMatchObject({ title: "搜索目标", spaceSlug: "handbook" });
    expect(data[0].snippet).toContain("独一无二");
    expect((await h.call(USERS.reader, "GET", "search?q=%25")).data).toEqual([]);
  });

  it("warns the next editor without blocking them", async () => {
    const { document } = await createDoc("软锁");
    expect((await h.call(USERS.editor, "POST", `documents/${document.id}/editing`, { editing: true })).data.other).toBeNull();
    const other = { ...USERS.editor, id: "editor-2", displayName: "另一位" };
    await h.call(USERS.admin, "PUT", "spaces/handbook/members", { subject: "user:editor-2", role: "editor" });
    expect((await h.call(other, "POST", `documents/${document.id}/editing`, { editing: true })).data.other.name).toBe("编辑者");
    expect((await h.call(other, "GET", `documents/${document.id}`)).data.editing.name).toBe("编辑者");
    expect((await h.write(other, "PUT", `documents/${document.id}/content`, { markdown: "改了\n", expectedRevision: 1 })).status).toBe(200);
    await h.call(USERS.editor, "POST", `documents/${document.id}/editing`, { editing: false });
    expect((await h.call(other, "GET", `documents/${document.id}`)).data.editing).toBeNull();
  });

  it("removes childless documents only", async () => {
    const parent = await createDoc("父页面");
    await createDoc("子页面", "内容\n", { parentPath: parent.document.path });
    expect((await h.call(USERS.editor, "DELETE", `documents/${parent.document.id}`)).error.code).toBe("DOCUMENT_HAS_CHILDREN");
    const leaf = await createDoc("叶子");
    expect((await h.call(USERS.editor, "DELETE", `documents/${leaf.document.id}`)).status).toBe(200);
    expect((await h.call(USERS.editor, "GET", `documents/${leaf.document.id}`)).status).toBe(404);
    await createDoc("叶子");
  });

  it("says what is wrong with a blank or broken title, name or order, instead of failing", async () => {
    const page = await createDoc("会改名的页面");
    for (const title of ["   ", "\t\n", "\u00a0\u3000"]) {
      expect((await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title, markdown: "x\n" })).status, JSON.stringify(title)).toBe(422);
      expect((await h.call(USERS.editor, "PATCH", `documents/${page.document.id}`, { title })).status, JSON.stringify(title)).toBe(422);
    }
    expect((await h.call(USERS.editor, "PATCH", `documents/${page.document.id}`, { title: " 两行\n的标题 " })).data.title).toBe("两行 的标题");
    for (const sortOrder of [2147483648, -2147483649]) {
      expect((await h.call(USERS.editor, "PATCH", `documents/${page.document.id}`, { sortOrder })).status).toBe(422);
      expect((await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "顺序", markdown: "x\n", sortOrder })).status).toBe(422);
    }
    expect((await h.call(USERS.editor, "PATCH", `documents/${page.document.id}`, { sortOrder: 2147483647 })).status).toBe(200);
    // A page after it still has a place.
    expect((await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "排在最后之后", markdown: "x\n" })).status).toBe(201);
    expect((await h.call(USERS.editor, "PATCH", `documents/${page.document.id}`, { sortOrder: 10 })).status).toBe(200);
    expect((await h.call(USERS.admin, "PATCH", "spaces/handbook", { name: "  " })).status).toBe(422);
    expect((await h.call(USERS.admin, "POST", "spaces", { slug: "blank-name", name: "\n" })).status).toBe(422);
    expect((await h.call(USERS.admin, "GET", "spaces/handbook")).data.name).toBe("手册");
  });

  it("answers unknown routes and bad input without leaking internals", async () => {
    expect((await h.call(USERS.reader, "GET", "nope")).status).toBe(404);
    expect((await h.call(USERS.reader, "DELETE", "spaces")).status).toBe(405);
    expect((await h.call(USERS.editor, "POST", "spaces/handbook/documents", { markdown: "缺标题" })).error.code).toBe("INPUT_INVALID");
    expect((await h.call(USERS.reader, "GET", "documents/not-a-uuid")).status).toBe(404);
    for (const [method, path] of [["GET", "threads/abc"], ["GET", "proposals/abc"], ["POST", "threads/abc/resolve"], ["DELETE", "comments/abc"], ["POST", "comments/abc/reactions"], ["PATCH", "documents/abc/feedback/xyz"]] as const) {
      const answer = await h.call(USERS.editor, method, path, method === "POST" && path.endsWith("reactions") ? { emoji: "👍", active: true } : undefined);
      expect([path, answer.status, answer.error?.code]).toEqual([path, 404, "NOT_FOUND"]);
    }
  });
});

describe("read-only credentials", () => {
  it("cap every role to viewer", async () => {
    const h = createHarness(fixture.getConnectionString());
    const { data } = await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "只读凭据", markdown: "内容\n" });
    const readOnly = { ...USERS.editor, scopes: ["read"] as ("read" | "write")[], channel: "cli" as const };
    const id = data.document.id as string;
    expect((await h.call(readOnly, "GET", `documents/${id}`)).data.role).toBe("viewer");
    expect((await h.write(readOnly, "POST", `documents/${id}/ops`, { ops: [{ op: "block_delete", ref: "b1" }], expectedRevision: 1 })).status).toBe(403);
    expect((await h.call(readOnly, "POST", `documents/${id}/threads`, { anchor: { kind: "document" }, body: "评论" })).status).toBe(403);
    await h.close();
  });

  it("lists someone's own drafts, on pages they can still work on", async () => {
    const h = createHarness(fixture.getConnectionString());
    const { document } = (await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "草稿列表", markdown: "正文\n" })).data;
    await h.call(USERS.editor, "PUT", `documents/${document.id}/draft`, { markdown: "写到一半", baseRevision: 1, title: "草稿里的标题" });
    const mine = (await h.call(USERS.editor, "GET", "me/drafts")).data as { documentId: string; title: string; lang: string }[];
    expect(mine.find(draft => draft.documentId === document.id)).toMatchObject({ title: "草稿里的标题", lang: "", path: document.path, spaceSlug: "handbook" });
    expect((await h.call(USERS.commenter, "GET", "me/drafts")).data.find((draft: { documentId: string }) => draft.documentId === document.id)).toBeUndefined();
    await h.call(USERS.editor, "DELETE", `documents/${document.id}`);
    expect((await h.call(USERS.editor, "GET", "me/drafts")).data.find((draft: { documentId: string }) => draft.documentId === document.id)).toBeUndefined();
    await h.close();
  });

  it("keeps a draft per person, without creating a version", async () => {
    const h = createHarness(fixture.getConnectionString());
    const created = await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "草稿文档", markdown: "正文\n" });
    const id = created.data.document.id as string;
    expect((await h.call(USERS.editor, "GET", `documents/${id}/draft`)).data).toBeNull();
    expect((await h.call(USERS.reader, "PUT", `documents/${id}/draft`, { markdown: "读者写的", baseRevision: 1 })).status).toBe(403);
    expect((await h.call(USERS.editor, "PUT", `documents/${id}/draft`, { markdown: "第一稿", baseRevision: 1 })).status).toBe(200);
    expect((await h.call(USERS.editor, "PUT", `documents/${id}/draft`, { markdown: "第二稿", baseRevision: 1 })).status).toBe(200);
    expect((await h.call(USERS.editor, "GET", `documents/${id}/draft`)).data).toMatchObject({ markdown: "第二稿", baseRevision: 1 });
    expect((await h.call(USERS.admin, "GET", `documents/${id}/draft`)).data).toBeNull();
    expect((await h.call(USERS.editor, "GET", `documents/${id}`)).data.revision.no).toBe(1);
    expect((await h.call(USERS.editor, "DELETE", `documents/${id}/draft`)).status).toBe(200);
    expect((await h.call(USERS.editor, "GET", `documents/${id}/draft`)).data).toBeNull();
    await h.close();
  });

  it("keeps a translation's draft apart from the page's, with its title", async () => {
    const h = createHarness(fixture.getConnectionString());
    const created = await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "译文草稿文档", markdown: "正文\n" });
    const id = created.data.document.id as string;
    await h.call(USERS.editor, "PUT", `documents/${id}/draft`, { markdown: "原文草稿", baseRevision: 1 });
    expect((await h.call(USERS.editor, "PUT", `documents/${id}/draft?lang=en`, { markdown: "English draft", title: "Draft title", baseRevision: 1 })).status).toBe(200);
    expect((await h.call(USERS.editor, "GET", `documents/${id}/draft`)).data).toMatchObject({ markdown: "原文草稿", title: null });
    expect((await h.call(USERS.editor, "GET", `documents/${id}/draft?lang=en`)).data).toMatchObject({ markdown: "English draft", title: "Draft title", baseRevision: 1 });
    await h.call(USERS.editor, "DELETE", `documents/${id}/draft?lang=en`);
    expect((await h.call(USERS.editor, "GET", `documents/${id}/draft?lang=en`)).data).toBeNull();
    expect((await h.call(USERS.editor, "GET", `documents/${id}/draft`)).data).toMatchObject({ markdown: "原文草稿" });
    // Translating takes edit rights, whatever someone may suggest on the page itself.
    await h.call(USERS.admin, "PUT", "spaces/handbook/members", { subject: `user:${USERS.commenter.id}`, role: "commenter" });
    expect((await h.call(USERS.commenter, "PUT", `documents/${id}/draft`, { markdown: "建议", baseRevision: 1 })).status).toBe(200);
    expect((await h.call(USERS.commenter, "PUT", `documents/${id}/draft?lang=en`, { markdown: "x", baseRevision: 1 })).status).toBe(403);
    expect((await h.call(USERS.editor, "GET", `documents/${id}/draft?lang=../x`)).status).toBe(422);
    await h.close();
  });
});

describe("full-text search", () => {
  let h: ReturnType<typeof createHarness>;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    await h.call(USERS.admin, "POST", "spaces", { slug: "open", name: "公开", defaultRole: "viewer" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "closed", name: "内部", defaultRole: "none" });
  });
  afterAll(async () => {
    expect(h.errors).toEqual([]);
    await h.close();
  });

  const create = async (space: string, title: string, markdown: string, extra: object = {}) =>
    (await h.call(USERS.admin, "POST", `spaces/${space}/documents`, { title, markdown, ...extra })).data.document as { id: string };
  const find = async (q: string, principal: Principal = USERS.reader) => ((await h.call(principal, "GET", `search?q=${encodeURIComponent(q)}`)).data as { title: string; snippet: string }[]).map(hit => hit.title);

  it("finds a phrase in the body, and only where it really appears", async () => {
    await create("open", "排班说明", "每周四发布下周的排班表。\n");
    await create("open", "零散词语", "排班。发布表格。下周再说。\n");
    expect(await find("排班表")).toEqual(["排班说明"]);
    expect((await h.call(USERS.reader, "GET", `search?q=${encodeURIComponent("排班表")}`)).data[0].snippet).toContain("排班表");
  });

  it("puts title matches first", async () => {
    await create("open", "正文提到盘点", "这里说的是月底盘点流程。\n");
    await create("open", "盘点流程", "另一篇。\n");
    expect((await find("盘点流程"))[0]).toBe("盘点流程");
  });

  it("finds Latin words by prefix, whatever their case", async () => {
    await create("open", "接口说明", "调用 OpenAPI 的地址。\n");
    expect(await find("openapi")).toEqual(["接口说明"]);
    expect(await find("opena")).toEqual(["接口说明"]);
  });

  it("sees the new text after a save, and not the old", async () => {
    const { id } = await create("open", "会改的页面", "第一版独有的词语。\n");
    expect(await find("独有的词语")).toEqual(["会改的页面"]);
    await h.write(USERS.admin, "PUT", `documents/${id}/content`, { markdown: "第二版换了说法。\n", expectedRevision: 1 });
    expect(await find("独有的词语")).toEqual([]);
    expect(await find("换了说法")).toEqual(["会改的页面"]);
  });

  it("keeps closed spaces and restricted pages to those allowed", async () => {
    await create("closed", "内部页面", "这是内部才能看到的安排。\n");
    const restricted = await create("open", "受限页面", "这是受限才能看到的安排。\n", { restricted: true });
    expect(await find("才能看到的安排")).toEqual([]);
    expect((await find("才能看到的安排", USERS.admin)).sort()).toEqual(["内部页面", "受限页面"].sort());
    await h.call(USERS.admin, "PUT", `documents/${restricted.id}/members`, { subject: `user:${USERS.reader.id}`, role: "viewer" });
    expect(await find("才能看到的安排")).toEqual(["受限页面"]);
    const agent: Principal = { ...USERS.agent, onBehalfOf: { id: USERS.reader.id, groups: [] } };
    expect(await find("才能看到的安排", agent)).toEqual(["受限页面"]);
  });

  it("leaves out pages in the trash", async () => {
    const { id } = await create("open", "要删的页面", "很快就要删除的内容。\n");
    await h.call(USERS.admin, "DELETE", `documents/${id}`);
    expect(await find("很快就要删除")).toEqual([]);
  });

  it("tells the app when a site is too large for the browser's index, and sends it titles only", async () => {
    await create("open", "短页面", "内容。\n");
    expect((await h.call(USERS.reader, "GET", "bootstrap")).data.fullTextOnServer).toBe(false);
    const { rows } = await h.pool.query(`SELECT id FROM pandocs.spaces WHERE slug = 'open'`);
    await h.pool.query(`UPDATE pandocs.documents SET visible_chars = 5000000 WHERE space_id = $1`, [rows[0].id]);
    expect((await h.call(USERS.reader, "GET", "bootstrap")).data.fullTextOnServer).toBe(true);
    const index = await h.handler(new Request(`http://pandocs.test${BASE}/static/search_index.zh.abc.json`), USERS.reader);
    const entries = await index.json() as { title: string; content: string }[];
    expect(entries.find(entry => entry.title === "短页面")?.content).toBe("");
  });
});
