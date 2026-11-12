import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const SOURCE =
  [
    "# 第一步",
    "浇水系统会按你登记的地块号定时放水，所以每户在每块地上各办一次。",
    "检查一遍：水管接头没有滴水。",
    "# 第二步",
    "地块牌和登记表的号码要一致，牌子丢了就去工具棚找管理员补一块新的地块牌。",
    "检查一遍：棚门已经锁好。",
    "```mermaid\nflowchart LR\n  A --> B\n```"
  ].join("\n\n") + "\n";
const QUOTE = "浇水系统会按你登记的地块号定时放水";

describe("threads, proposals and agents", () => {
  let h: ReturnType<typeof createHarness>;
  const prompts: string[] = [];
  const assistCalls: { action: string; content: string; context: string }[] = [];

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    const people = Object.values(USERS);
    h = createHarness(fixture.getConnectionString(), {
      // Who works here, as a host's directory says: an id is someone only if it says so, and by the name it gives.
      directory: {
        search: async query =>
          people
            .filter(person => person.displayName.includes(query))
            .map(person => ({ id: person.id, name: person.displayName })),
        names: async ids =>
          people.filter(person => ids.includes(person.id)).map(person => ({ id: person.id, name: person.displayName }))
      },
      llm: {
        complete: async ({ prompt }) => {
          prompts.push(prompt);
          return "总结：需要确认地块范围。";
        },
        assist: async ({ action, content, context }) => {
          assistCalls.push({ action, content, context });
          return "结果";
        }
      }
    });
    await h.call(USERS.admin, "POST", "spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", "spaces/handbook/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    await h.call(USERS.admin, "PUT", "spaces/handbook/members", {
      subject: `user:${USERS.commenter.id}`,
      role: "commenter"
    });
  });
  afterAll(async () => {
    expect(h.errors).toEqual([]);
    await h.close();
  });

  const createDoc = async (title: string, markdown = SOURCE) =>
    (await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title, markdown })).data.document.id as string;
  const createThread = async (id: string, anchor: object, body = "这里要确认") =>
    h.call(USERS.commenter, "POST", `documents/${id}/threads`, { anchor, body });
  const threadOf = async (threadId: string) => (await h.call(USERS.reader, "GET", `threads/${threadId}`)).data;

  describe("AI on words being edited", () => {
    const DOC = "第一段**重要**说明。\n\n第二段。\n";

    it("reads them from the person's own draft, and refuses words that are not in it", async () => {
      const id = await createDoc("编辑 AI", DOC);
      assistCalls.length = 0;
      expect(
        (
          await h.call(USERS.commenter, "POST", `documents/${id}/draft/assist`, {
            action: "rewrite",
            quote: "第一段重要"
          })
        ).data
      ).toMatchObject({ action: "rewrite", text: "结果" });
      expect(assistCalls[0]).toMatchObject({ action: "rewrite", content: "第一段重要" });
      expect(assistCalls[0]!.context).toContain("第二段");

      expect(
        (
          await h.call(USERS.commenter, "POST", `documents/${id}/draft/assist`, {
            action: "rewrite",
            quote: "还没写进去的字"
          })
        ).error.code
      ).toBe("ASSIST_SELECTION_INVALID");
      await h.call(USERS.commenter, "PUT", `documents/${id}/draft`, {
        markdown: `${DOC}\n刚写进草稿的字\n`,
        baseRevision: 1
      });
      expect(
        (
          await h.call(USERS.commenter, "POST", `documents/${id}/draft/assist`, {
            action: "rewrite",
            quote: "刚写进草稿的字"
          })
        ).status
      ).toBe(200);
      // Someone else's draft does not count.
      expect(
        (
          await h.call(USERS.editor, "POST", `documents/${id}/draft/assist`, {
            action: "rewrite",
            quote: "刚写进草稿的字"
          })
        ).error.code
      ).toBe("ASSIST_SELECTION_INVALID");
      // Nor does text the browser makes up when there is no shared draft for it to come from.
      assistCalls.length = 0;
      const made = await h.call(USERS.commenter, "POST", `documents/${id}/draft/assist`, {
        action: "rewrite",
        quote: "随便什么问题",
        markdown: "随便什么问题\n"
      });
      expect(made.error.code).toBe("ASSIST_SELECTION_INVALID");
      expect(assistCalls).toEqual([]);
      expect(
        (
          await h.call(USERS.commenter, "POST", `documents/${id}/draft/assist`, {
            action: "rewrite",
            quote: "字",
            markdown: "字".repeat(2 * 1024 * 1024 + 1)
          })
        ).error.code
      ).toBe("INPUT_INVALID");
    });

    it("needs edit rights for a translation and comment rights otherwise", async () => {
      const id = await createDoc("编辑 AI 权限", DOC);
      expect(
        (await h.call(USERS.reader, "POST", `documents/${id}/draft/assist`, { action: "rewrite", quote: "第二段" }))
          .status
      ).toBe(403);
      expect(
        (
          await h.call(USERS.commenter, "POST", `documents/${id}/draft/assist?lang=en`, {
            action: "rewrite",
            quote: "第二段"
          })
        ).status
      ).toBe(403);
    });
  });

  describe("suggestions from a discussion", () => {
    const DOC = "# 标题\n\n第一段说明。\n\n第二段**重要**说明。\n\n第三段说明。\n";

    it("sends the blocks a text comment sits in and the discussion, and writes nothing", async () => {
      const id = await createDoc("讨论生成", DOC);
      const thread = (await createThread(id, { kind: "quote", quote: "第二段重要" }, "这里的说法不对")).data;
      await h.call(USERS.editor, "POST", `threads/${thread.id}/comments`, { body: "改成“关键”吧" });
      assistCalls.length = 0;
      const result = await h.call(USERS.commenter, "POST", `threads/${thread.id}/suggestion`);
      expect(result.data).toMatchObject({
        baseRevision: 1,
        firstRef: "b3",
        lastRef: "b3",
        source: "第二段**重要**说明。",
        text: "结果"
      });
      expect(assistCalls).toHaveLength(1);
      expect(assistCalls[0]).toMatchObject({ action: "apply_discussion", content: "第二段**重要**说明。" });
      expect(assistCalls[0]!.context).toContain("这里的说法不对");
      expect(assistCalls[0]!.context).toContain("改成“关键”吧");
      expect(assistCalls[0]!.context).toContain("第二段重要");
      expect((await h.call(USERS.reader, "GET", `documents/${id}`)).data.revision.no).toBe(1);
    });

    it("works on blocks, and treats a comment on the page as being about all of it", async () => {
      const id = await createDoc("讨论生成范围", DOC);
      const block = (await createThread(id, { kind: "block", ref: "b2" })).data;
      expect((await h.call(USERS.commenter, "POST", `threads/${block.id}/suggestion`)).data).toMatchObject({
        firstRef: "b2",
        lastRef: "b2",
        source: "第一段说明。"
      });
      const whole = (await createThread(id, { kind: "document" })).data;
      expect((await h.call(USERS.commenter, "POST", `threads/${whole.id}/suggestion`)).data).toMatchObject({
        firstRef: "b1",
        lastRef: "b4",
        source: DOC.trimEnd()
      });
    });

    it("follows the words when the page has changed since", async () => {
      const id = await createDoc("讨论生成版本", DOC);
      const thread = (await createThread(id, { kind: "quote", quote: "第三段" })).data;
      await h.write(USERS.editor, "PUT", `documents/${id}/content`, {
        markdown: `新开头。\n\n${DOC}`,
        expectedRevision: 1
      });
      expect((await h.call(USERS.commenter, "POST", `threads/${thread.id}/suggestion`)).data).toMatchObject({
        baseRevision: 2,
        firstRef: "b5",
        source: "第三段说明。"
      });
    });

    it("can be submitted as a proposal that resolves the discussion when accepted", async () => {
      const id = await createDoc("讨论生成提案", DOC);
      const thread = (await createThread(id, { kind: "block", ref: "b2" })).data;
      const suggestion = (await h.call(USERS.commenter, "POST", `threads/${thread.id}/suggestion`)).data;
      const proposal = (
        await h.call(USERS.commenter, "POST", `documents/${id}/proposals`, {
          baseRevision: suggestion.baseRevision,
          ops: [{ op: "block_replace", ref: suggestion.firstRef, content: "改过的第一段。" }],
          threadIds: [thread.id]
        })
      ).data;
      await h.write(USERS.editor, "POST", `proposals/${proposal.id}/decide`, { decision: "accept" });
      expect((await threadOf(thread.id)).status).toBe("resolved");
      expect((await h.call(USERS.reader, "GET", `documents/${id}`)).data.markdown).toContain("改过的第一段。");
    });

    it("refuses readers, finished discussions, lost text and text too long to replace whole", async () => {
      const id = await createDoc("讨论生成拒绝", DOC);
      const thread = (await createThread(id, { kind: "quote", quote: "第三段" })).data;
      expect((await h.call(USERS.reader, "POST", `threads/${thread.id}/suggestion`)).status).toBe(403);
      await h.call(USERS.commenter, "POST", `threads/${thread.id}/resolve`);
      expect((await h.call(USERS.commenter, "POST", `threads/${thread.id}/suggestion`)).error.code).toBe(
        "THREAD_RESOLVED"
      );

      const lost = (await createThread(id, { kind: "quote", quote: "第一段说明" })).data;
      await h.write(USERS.editor, "PUT", `documents/${id}/content`, {
        markdown: "全部换掉了，没有一句一样。\n",
        expectedRevision: 1
      });
      expect((await h.call(USERS.commenter, "POST", `threads/${lost.id}/suggestion`)).error.code).toBe(
        "THREAD_ANCHOR_LOST"
      );

      const long = await createDoc("讨论生成太长", "很长的内容。".repeat(800));
      const onLong = (await createThread(long, { kind: "document" })).data;
      expect((await h.call(USERS.commenter, "POST", `threads/${onLong.id}/suggestion`)).error.code).toBe(
        "ASSIST_SELECTION_TOO_LONG"
      );
    });
  });

  describe("threads", () => {
    it("anchors from a quote, and refuses to guess between repeats", async () => {
      const id = await createDoc("引文定位");
      const created = await createThread(id, { kind: "quote", quote: QUOTE });
      expect(created.status).toBe(201);
      expect(created.data).toMatchObject({
        anchorState: "exact",
        status: "open",
        anchor: { kind: "text", exact: QUOTE }
      });
      expect((await createThread(id, { kind: "quote", quote: "检查一遍" })).error.code).toBe("ANCHOR_AMBIGUOUS");
      expect((await createThread(id, { kind: "quote", quote: "检查一遍", occurrence: 2 })).status).toBe(201);
      expect((await createThread(id, { kind: "quote", quote: "不存在" })).error.code).toBe("ANCHOR_NOT_FOUND");
    });

    it("anchors from a browser range the same way", async () => {
      const id = await createDoc("范围定位");
      const fromQuote = await createThread(id, { kind: "quote", quote: QUOTE });
      const { start, end } = fromQuote.data.anchor;
      const fromRange = await createThread(id, { kind: "text", start, end, exact: QUOTE });
      expect(fromRange.data.anchor).toEqual(fromQuote.data.anchor);
      expect((await createThread(id, { kind: "text", start: 0, end: 999999 })).error.code).toBe("ANCHOR_INVALID");
    });

    it("anchors to sections, blocks and the whole document", async () => {
      const id = await createDoc("块定位");
      expect((await createThread(id, { kind: "section", section: "第二步" })).data.anchor).toMatchObject({
        kind: "block",
        ref: "b4",
        type: "heading"
      });
      expect((await createThread(id, { kind: "block", ref: "b7" })).data.anchor).toMatchObject({
        kind: "block",
        ref: "b7",
        type: "mermaid"
      });
      expect((await createThread(id, { kind: "document" })).data.anchor).toEqual({ kind: "document" });
      expect((await createThread(id, { kind: "block", ref: "b99" })).error.code).toBe("ANCHOR_NOT_FOUND");
    });

    it("relocates on every new version and says how sure it is", async () => {
      const id = await createDoc("重定位");
      const thread = (await createThread(id, { kind: "quote", quote: QUOTE })).data;
      const save = (markdown: string, expectedRevision: number) =>
        h.write(USERS.editor, "PUT", `documents/${id}/content`, { markdown, expectedRevision });

      await save(`新增一段说明文字放在最前面。\n\n${SOURCE}`, 1);
      let current = await threadOf(thread.id);
      expect(current).toMatchObject({ anchorState: "exact", anchoredRevisionNo: 2 });
      expect(current.anchor.start).toBeGreaterThan(thread.anchor.start);

      await save(`新增一段说明文字放在最前面。\n\n${SOURCE.replace("会按你登记", "会照你登记")}`, 2);
      current = await threadOf(thread.id);
      expect(current.anchorState).toBe("fuzzy");
      expect(current.anchor.exact).toBe(QUOTE);

      await save("全部重写了，原文已经不存在。\n", 3);
      current = await threadOf(thread.id);
      expect(current.anchorState).toBe("orphaned");
      expect(current.anchor.exact).toBe(QUOTE);
    });

    it("leaves resolved threads alone", async () => {
      const id = await createDoc("已解决");
      const thread = (await createThread(id, { kind: "quote", quote: QUOTE })).data;
      await h.call(USERS.commenter, "POST", `threads/${thread.id}/resolve`);
      await h.write(USERS.editor, "PUT", `documents/${id}/content`, { markdown: "重写\n", expectedRevision: 1 });
      expect(await threadOf(thread.id)).toMatchObject({
        status: "resolved",
        anchorState: "exact",
        resolvedName: "评论者"
      });
      expect((await h.call(USERS.commenter, "POST", `threads/${thread.id}/reopen`)).data.status).toBe("open");
    });

    it("carries a selection made on an older version forward", async () => {
      const id = await createDoc("旧版本选区");
      await h.write(USERS.editor, "PUT", `documents/${id}/content`, {
        markdown: `前置内容。\n\n${SOURCE}`,
        expectedRevision: 1
      });
      const created = await createThread(id, { kind: "quote", quote: QUOTE, revision: 1 });
      expect(created.data).toMatchObject({ anchorState: "exact", anchoredRevisionNo: 2 });
    });

    it("runs replies, mentions and the related-to-me list", async () => {
      const id = await createDoc("通知");
      const thread = (
        await h.call(USERS.commenter, "POST", `documents/${id}/threads`, {
          anchor: { kind: "document" },
          body: "请看一下 @编辑者",
          mentions: [{ id: USERS.editor.id, name: "编辑者" }]
        })
      ).data;
      let inbox = (await h.call(USERS.editor, "GET", "me/inbox")).data;
      expect(inbox.notifications[0]).toMatchObject({
        kind: "mention",
        actorName: "评论者",
        threadId: thread.id,
        spaceSlug: "handbook",
        readAt: null
      });

      const reply = await h.call(USERS.editor, "POST", `threads/${thread.id}/comments`, { body: "看过了" });
      expect(reply.data).toMatchObject({ authorName: "编辑者", channel: "web" });
      expect((await h.call(USERS.commenter, "GET", "me/inbox")).data.notifications[0]).toMatchObject({
        kind: "reply",
        actorName: "编辑者"
      });

      await h.call(USERS.editor, "POST", "me/inbox/read", { ids: "all" });
      inbox = (await h.call(USERS.editor, "GET", "me/inbox")).data;
      expect(inbox.notifications[0].readAt).not.toBeNull();
      expect(
        (await h.call(USERS.reader, "POST", `threads/${thread.id}/comments`, { body: "读者不能评论" })).status
      ).toBe(403);
    });

    it("goes back to where its words are when it is reopened, or says they are gone", async () => {
      const id = await createDoc("重新打开");
      const thread = (await createThread(id, { kind: "quote", quote: QUOTE })).data;
      await h.call(USERS.commenter, "POST", `threads/${thread.id}/resolve`);
      await h.write(USERS.editor, "PUT", `documents/${id}/content`, {
        markdown: `今天新增早班登记要求。\n\n${SOURCE}`,
        expectedRevision: 1
      });
      const reopened = (await h.call(USERS.commenter, "POST", `threads/${thread.id}/reopen`)).data;
      expect(reopened).toMatchObject({ status: "open", anchorState: "exact", anchoredRevisionNo: 2 });
      expect(reopened.anchor.start).toBeGreaterThan(thread.anchor.start);
      await h.call(USERS.commenter, "POST", `threads/${thread.id}/resolve`);
      await h.write(USERS.editor, "PUT", `documents/${id}/content`, {
        markdown: "车辆停靠在东侧卸货区。\n",
        expectedRevision: 2
      });
      expect((await h.call(USERS.commenter, "POST", `threads/${thread.id}/reopen`)).data).toMatchObject({
        anchorState: "orphaned",
        anchoredRevisionNo: 3,
        anchor: { exact: QUOTE }
      });
    });

    it("drops out of the discussions on a page once every comment in it is taken back", async () => {
      const id = await createDoc("撤回");
      const thread = (await createThread(id, { kind: "quote", quote: QUOTE })).data;
      const replied = (
        await h.call(USERS.commenter, "POST", `documents/${id}/threads`, {
          anchor: { kind: "document" },
          body: "第一条"
        })
      ).data;
      await h.call(USERS.editor, "POST", `threads/${replied.id}/comments`, { body: "第二条" });
      await h.call(USERS.commenter, "DELETE", `comments/${thread.comments[0].id}`);
      await h.call(USERS.commenter, "DELETE", `comments/${replied.comments[0].id}`);
      const listed = (await h.call(USERS.reader, "GET", `documents/${id}/threads`)).data as { id: string }[];
      expect(listed.map(item => item.id)).toEqual([replied.id]);
      expect((await h.call(USERS.reader, "GET", `documents/${id}/threads?status=open`)).data).toHaveLength(1);
    });

    it("mentions someone by who they are, and takes the notice back with the comment", async () => {
      const id = await createDoc("提及");
      const created = (
        await h.call(USERS.commenter, "POST", `documents/${id}/threads`, {
          anchor: { kind: "document" },
          body: "@管理员 请看",
          mentions: [
            { id: USERS.editor.id, name: "管理员" },
            { id: "nobody-1", name: "不存在" }
          ]
        })
      ).data;
      expect(created.comments[0].mentions).toEqual([{ id: USERS.editor.id, name: USERS.editor.displayName }]);
      const mention = (await h.call(USERS.editor, "GET", "me/inbox")).data.notifications.find(
        (item: { threadId: string }) => item.threadId === created.id
      );
      expect(mention).toMatchObject({ kind: "mention" });
      await h.call(USERS.commenter, "DELETE", `comments/${created.comments[0].id}`);
      expect(
        (await h.call(USERS.editor, "GET", "me/inbox")).data.notifications.some(
          (item: { threadId: string }) => item.threadId === created.id
        )
      ).toBe(false);
    });

    it("anchors next to an emoji, and the page can still be saved with one there", async () => {
      const target = "请核对签收凭证后再完成交接。";
      for (const padding of [30, 31, 32]) {
        const id = await createDoc(`表情${padding}`, `📦${"a".repeat(padding)}\n\n${target}\n`);
        expect((await createThread(id, { kind: "quote", quote: target })).status).toBe(201);
      }
      const id = await createDoc("表情保存", `${"b".repeat(31)}\n\n${target}\n`);
      expect((await createThread(id, { kind: "quote", quote: target })).status).toBe(201);
      expect(
        (
          await h.write(USERS.editor, "PUT", `documents/${id}/content`, {
            markdown: `🚚${"b".repeat(31)}\n\n${target}\n`,
            expectedRevision: 1
          })
        ).status
      ).toBe(200);
    });

    it("lists what someone can read in their inbox, however much there is about pages they cannot", async () => {
      const readable = await createDoc("能读的页面");
      await h.call(USERS.commenter, "POST", `documents/${readable}/threads`, {
        anchor: { kind: "document" },
        body: "能读的提及",
        mentions: [{ id: USERS.reader.id, name: USERS.reader.displayName }]
      });
      const hidden = (
        await h.call(USERS.admin, "POST", "spaces/handbook/documents", {
          title: "读不了的页面",
          markdown: "保密\n",
          restricted: true
        })
      ).data.document.id as string;
      for (let i = 0; i < 60; i += 1) {
        await h.call(USERS.admin, "POST", `documents/${hidden}/threads`, {
          anchor: { kind: "document" },
          body: `第 ${i} 次`,
          mentions: [{ id: USERS.reader.id, name: USERS.reader.displayName }]
        });
      }
      const { notifications } = (await h.call(USERS.reader, "GET", "me/inbox")).data as {
        notifications: { documentId: string; summary: string }[];
      };
      expect(notifications.map(item => item.summary)).toContain("能读的提及");
      expect(notifications.some(item => item.documentId === hidden)).toBe(false);
    });

    it("lets people delete only their own comments", async () => {
      const id = await createDoc("删除评论");
      const thread = (
        await h.call(USERS.commenter, "POST", `documents/${id}/threads`, {
          anchor: { kind: "document" },
          body: "第一条"
        })
      ).data;
      const commentId = thread.comments[0].id as string;
      expect((await h.call(USERS.editor, "DELETE", `comments/${commentId}`)).status).toBe(403);
      expect((await h.call(USERS.commenter, "DELETE", `comments/${commentId}`)).status).toBe(200);
      expect((await threadOf(thread.id)).comments).toEqual([]);
    });

    it("summarises one thread or all of them", async () => {
      const id = await createDoc("总结");
      const thread = (await createThread(id, { kind: "quote", quote: QUOTE }, "地块范围要不要写清？")).data;
      await h.call(USERS.editor, "POST", `threads/${thread.id}/comments`, { body: "要写清。" });
      const summary = await h.call(USERS.commenter, "POST", `threads/${thread.id}/summary`);
      expect(summary.data.summary).toContain("总结");
      expect(prompts.at(-1)).toContain(QUOTE);
      expect(prompts.at(-1)).toContain("要写清。");
      expect((await threadOf(thread.id)).summary).toContain("总结");
      expect((await h.call(USERS.commenter, "POST", `documents/${id}/threads/summary`)).data.threadCount).toBe(1);
      expect((await h.call(USERS.reader, "POST", `threads/${thread.id}/summary`)).status).toBe(403);
    });
  });

  describe("selection assist", () => {
    it("reads the selection from the stored version and keeps its spaces", async () => {
      const id = await createDoc("划词", "# 划词\n\nThe quick brown fox.\n\n第二段的内容。\n");
      const start = "划词Thequick".length;
      const response = await h.call(USERS.reader, "POST", `documents/${id}/assist`, {
        action: "rewrite",
        start,
        end: start + "brownfox".length
      });
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ action: "rewrite", text: "结果" });
      expect(assistCalls.at(-1)).toMatchObject({ action: "rewrite", content: "brown fox" });
      expect(assistCalls.at(-1)!.context).toContain("第二段的内容");
    });

    it("refuses selections outside the document, too long, or from someone who cannot read it", async () => {
      const id = await createDoc("划词边界", "# 划词边界\n\n一段内容\n");
      const calls = assistCalls.length;
      expect(
        (await h.call(USERS.reader, "POST", `documents/${id}/assist`, { action: "explain", start: 9000, end: 9010 }))
          .status
      ).toBe(422);
      expect(
        (await h.call(USERS.reader, "POST", `documents/${id}/assist`, { action: "explain", start: 0, end: 4001 }))
          .status
      ).toBe(422);
      expect(
        (await h.call(USERS.reader, "POST", `documents/${id}/assist`, { action: "tell-a-joke", start: 0, end: 2 }))
          .status
      ).toBe(422);
      await h.call(USERS.admin, "PATCH", `documents/${id}`, { restricted: true });
      expect(
        (await h.call(USERS.reader, "POST", `documents/${id}/assist`, { action: "explain", start: 0, end: 2 })).status
      ).toBe(404);
      expect(assistCalls).toHaveLength(calls);
    });
  });

  describe("proposals", () => {
    const opsFor = () => [
      { op: "str_replace", pattern: "各办一次", content: "各办理一次" },
      { op: "str_replace", pattern: "补一块新的地块牌", content: "换新牌子" }
    ];
    const propose = async (
      id: string,
      principal = USERS.commenter,
      ops: object[] = opsFor(),
      baseRevision = 1,
      threadIds: string[] = []
    ) =>
      h.call(principal, "POST", `documents/${id}/proposals`, { baseRevision, ops, rationale: "统一用词", threadIds });

    it("does not touch the document until someone with edit rights accepts", async () => {
      const id = await createDoc("提案");
      const proposal = await propose(id);
      expect(proposal.status).toBe(201);
      expect(proposal.data).toMatchObject({ status: "pending", stale: false, baseRevisionNo: 1 });
      expect(proposal.data.proposedMarkdown).toContain("各办理一次");
      expect((await h.call(USERS.reader, "GET", `documents/${id}`)).data.revision.no).toBe(1);
      expect(
        (await h.call(USERS.editor, "GET", "me/inbox")).data.proposals.some(
          (item: { id: string }) => item.id === proposal.data.id
        )
      ).toBe(true);
      expect(
        (await h.call(USERS.commenter, "GET", "me/inbox")).data.proposals.some(
          (item: { id: string }) => item.id === proposal.data.id
        )
      ).toBe(false);

      expect(
        (await h.write(USERS.commenter, "POST", `proposals/${proposal.data.id}/decide`, { decision: "accept" })).status
      ).toBe(403);
      const accepted = await h.write(USERS.editor, "POST", `proposals/${proposal.data.id}/decide`, {
        decision: "accept"
      });
      expect(accepted.data.proposal).toMatchObject({ status: "accepted", decidedName: "编辑者", appliedRevisionNo: 2 });
      const text = await (await h.call(USERS.reader, "GET", `documents/${id}/content`)).response.text();
      expect(text).toContain("各办理一次");
      expect(text).toContain("换新牌子");
      const [latest] = (await h.call(USERS.reader, "GET", `documents/${id}/revisions`)).data;
      expect(latest.proposalId).toBe(proposal.data.id);
      expect(
        (await h.write(USERS.editor, "POST", `proposals/${proposal.data.id}/decide`, { decision: "reject" })).error.code
      ).toBe("PROPOSAL_DECIDED");
      expect(
        (await h.call(USERS.commenter, "GET", "me/inbox")).data.notifications.some(
          (item: { kind: string }) => item.kind === "proposal_decided"
        )
      ).toBe(true);
    });

    it("accepts only the chosen changes", async () => {
      const id = await createDoc("部分接受");
      const proposal = await propose(id);
      await h.write(USERS.editor, "POST", `proposals/${proposal.data.id}/decide`, {
        decision: "accept",
        opIndexes: [1]
      });
      const text = await (await h.call(USERS.reader, "GET", `documents/${id}/content`)).response.text();
      expect(text).toContain("换新牌子");
      expect(text).toContain("各办一次");
      expect((await h.call(USERS.reader, "GET", `proposals/${proposal.data.id}`)).data.acceptedOps).toEqual([1]);
    });

    it("merges onto newer versions and reports conflicts", async () => {
      const id = await createDoc("过期提案");
      const clean = await propose(id, USERS.commenter, [
        { op: "str_replace", pattern: "各办一次", content: "各办理一次" }
      ]);
      const conflicting = await propose(id, USERS.commenter, [
        { op: "str_replace", pattern: "各办一次", content: "配一次就好" }
      ]);
      await h.write(USERS.editor, "PUT", `documents/${id}/content`, {
        markdown: SOURCE.replace("检查一遍：棚门已经锁好。", "检查一遍：棚门锁好。"),
        expectedRevision: 1
      });
      expect((await h.call(USERS.reader, "GET", `proposals/${clean.data.id}`)).data.stale).toBe(true);

      const accepted = await h.write(USERS.editor, "POST", `proposals/${clean.data.id}/decide`, { decision: "accept" });
      expect(accepted.data.commit.revision.no).toBe(3);
      const text = await (await h.call(USERS.reader, "GET", `documents/${id}/content`)).response.text();
      expect(text).toContain("各办理一次");
      expect(text).toContain("检查一遍：棚门锁好。");

      const clash = await h.write(USERS.editor, "POST", `proposals/${conflicting.data.id}/decide`, {
        decision: "accept"
      });
      expect(clash.status).toBe(409);
      expect(clash.error.code).toBe("PROPOSAL_CONFLICT");
      expect((await h.call(USERS.reader, "GET", `proposals/${conflicting.data.id}`)).data.status).toBe("pending");
    });

    it("resolves the discussions it answers", async () => {
      const id = await createDoc("关联讨论");
      const thread = (await createThread(id, { kind: "quote", quote: QUOTE })).data;
      const proposal = await propose(id, USERS.commenter, opsFor(), 1, [thread.id]);
      await h.write(USERS.editor, "POST", `proposals/${proposal.data.id}/decide`, { decision: "accept" });
      expect((await threadOf(thread.id)).status).toBe("resolved");
    });

    it("rejects without touching the document", async () => {
      const id = await createDoc("拒绝");
      const proposal = await propose(id);
      const rejected = await h.write(USERS.editor, "POST", `proposals/${proposal.data.id}/decide`, {
        decision: "reject",
        note: "不需要"
      });
      expect(rejected.data.proposal).toMatchObject({ status: "rejected", decisionNote: "不需要" });
      expect((await h.call(USERS.reader, "GET", `documents/${id}`)).data.revision.no).toBe(1);
    });

    it("validates operations against the base version up front", async () => {
      const id = await createDoc("校验提案");
      expect((await propose(id, USERS.commenter, [{ op: "block_delete", ref: "b99" }])).error.code).toBe(
        "BLOCK_NOT_FOUND"
      );
      expect((await propose(id, USERS.commenter, opsFor(), 9)).error.code).toBe("REVISION_INVALID");
    });
  });

  describe("agents", () => {
    it("can read as the person they act for, comment and propose, but never edit directly", async () => {
      const id = await createDoc("Agent 权限");
      const read = await h.call(USERS.agent, "GET", `documents/${id}`);
      expect(read.data.role).toBe("commenter");

      const direct = await h.write(USERS.agent, "POST", `documents/${id}/ops`, {
        ops: [{ op: "block_delete", ref: "b1" }],
        expectedRevision: 1
      });
      expect(direct.status).toBe(403);
      expect(direct.error.message).toContain("proposal");

      const comment = await h.call(USERS.agent, "POST", `documents/${id}/threads`, {
        anchor: { kind: "quote", quote: QUOTE },
        body: "建议补充范围"
      });
      expect(comment.data.comments[0]).toMatchObject({ authorKind: "agent", channel: "agent" });

      const proposal = await h.call(USERS.agent, "POST", `documents/${id}/proposals`, {
        baseRevision: 1,
        ops: [{ op: "str_replace", pattern: "各办一次", content: "各办理一次" }],
        rationale: "用词"
      });
      expect(proposal.data).toMatchObject({ authorKind: "agent", onBehalfOf: USERS.editor.id, channel: "agent" });
      expect(
        (await h.write(USERS.agent, "POST", `proposals/${proposal.data.id}/decide`, { decision: "accept" })).status
      ).toBe(403);
    });

    it("cannot read beyond the person they act for", async () => {
      const restricted = (
        await h.call(USERS.admin, "POST", "spaces/handbook/documents", {
          title: "Agent 受限",
          markdown: "内容\n",
          restricted: true
        })
      ).data.document.id as string;
      expect((await h.call(USERS.agent, "GET", `documents/${restricted}`)).status).toBe(404);
      const forAdmin = { ...USERS.agent, onBehalfOf: { id: USERS.reader.id, groups: ["leads"] } };
      await h.call(USERS.admin, "PUT", `documents/${restricted}/members`, { subject: "group:leads", role: "viewer" });
      expect((await h.call(forAdmin, "GET", `documents/${restricted}`)).status).toBe(200);
    });
  });

  describe("tool catalog", () => {
    it("publishes names and schemas", async () => {
      const { data } = await h.call(USERS.reader, "GET", "tools");
      const names = data.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "doc_get",
          "doc_update",
          "thread_create",
          "proposal_create",
          "proposal_decide",
          "import_create",
          "doc_blocks"
        ])
      );
      expect(data.find((tool: { name: string }) => tool.name === "doc_get")).toMatchObject({
        access: "read",
        annotations: { readOnlyHint: true }
      });
      expect(data.find((tool: { name: string }) => tool.name === "doc_update").inputSchema.required).toEqual(
        expect.arrayContaining(["doc", "ops", "expectedRevision"])
      );
    });

    it("drives a whole workflow without a browser", async () => {
      const viaMcp = { ...USERS.editor, channel: "mcp" as const };
      await createDoc("工具流程");
      const doc = "handbook/工具流程";
      const outline = await h.call(viaMcp, "POST", "tools/doc_get", { doc, scope: "outline" });
      expect(outline.data.outline[0].text).toBe("第一步");
      const section = await h.call(viaMcp, "POST", "tools/doc_get", { doc, scope: "section", section: "第二步" });
      const revision = section.data.revision.no as number;
      const thread = await h.call(viaMcp, "POST", "tools/thread_create", {
        doc,
        quote: QUOTE,
        body: "来自 MCP 的评论"
      });
      expect(thread.data.comments[0].channel).toBe("mcp");
      const update = await h.call(viaMcp, "POST", "tools/doc_update", {
        doc,
        expectedRevision: revision,
        ops: [{ op: "block_replace", ref: section.data.blocks[1].ref, content: "用工具改写。" }]
      });
      expect(update.data.revision).toMatchObject({ no: 2, channel: "mcp" });
      expect(
        (
          await h.call(viaMcp, "POST", "tools/doc_update", {
            doc,
            expectedRevision: revision,
            ops: [{ op: "block_delete", ref: "b1" }]
          })
        ).error.code
      ).toBe("REVISION_CONFLICT");
      expect((await h.call(viaMcp, "POST", "tools/doc_diff", { doc, from: 1, to: 2 })).data.patch).toContain(
        "用工具改写"
      );
      expect(
        (
          await h.call(USERS.agent, "POST", "tools/doc_update", {
            doc,
            expectedRevision: 2,
            ops: [{ op: "block_delete", ref: "b1" }]
          })
        ).status
      ).toBe(403);
      expect((await h.call(viaMcp, "POST", "tools/doc_get", { doc: "没有斜杠" })).error.code).toBe(
        "DOCUMENT_REF_INVALID"
      );
      expect((await h.call(viaMcp, "POST", "tools/doc_get", {})).error.code).toBe("INPUT_INVALID");
      expect((await h.call(viaMcp, "POST", "tools/no_such_tool", {})).status).toBe(404);
      expect(
        (await h.call(viaMcp, "POST", "tools/doc_blocks", {})).data.some(
          (block: { name: string }) => block.name === "callout"
        )
      ).toBe(true);
    });
  });

  describe("editing comments and reactions", () => {
    const startThread = async () => {
      const documentId = await createDoc(`评论-${Math.random().toString(36).slice(2)}`);
      const thread = await h.call(USERS.commenter, "POST", `documents/${documentId}/threads`, {
        anchor: { kind: "document" },
        body: "原来的话"
      });
      return { documentId, threadId: thread.data.id as string, commentId: thread.data.comments[0].id as string };
    };

    it("lets only the author change their words, and marks the comment as edited", async () => {
      const { documentId, threadId, commentId } = await startThread();
      expect((await h.call(USERS.editor, "PATCH", `comments/${commentId}`, { body: "别人改的" })).status).toBe(403);
      expect((await h.call(USERS.commenter, "PATCH", `comments/${commentId}`, { body: "   " })).status).toBe(422);
      const updated = await h.call(USERS.commenter, "PATCH", `comments/${commentId}`, { body: "改过的话" });
      expect(updated.status).toBe(200);
      expect(updated.data).toMatchObject({ body: "改过的话" });
      expect(updated.data.editedAt).toBeTruthy();
      const [thread] = (await h.call(USERS.reader, "GET", `documents/${documentId}/threads`)).data.filter(
        (item: { id: string }) => item.id === threadId
      );
      expect(thread.comments[0].body).toBe("改过的话");
    });

    it("notifies only people newly mentioned by an edit", async () => {
      const { commentId } = await startThread();
      const before = (await h.call(USERS.editor, "GET", "me/inbox")).data.notifications.length;
      await h.call(USERS.commenter, "PATCH", `comments/${commentId}`, {
        body: "@编辑者 看一下",
        mentions: [{ id: USERS.editor.id, name: "编辑者" }]
      });
      await h.call(USERS.commenter, "PATCH", `comments/${commentId}`, {
        body: "@编辑者 再看一下",
        mentions: [{ id: USERS.editor.id, name: "编辑者" }]
      });
      const after = (await h.call(USERS.editor, "GET", "me/inbox")).data.notifications;
      expect(after.length).toBe(before + 1);
      expect(after[0]).toMatchObject({ kind: "mention", summary: "@编辑者 看一下" });
    });

    it("counts reactions per person, says which are mine, and forgets deleted comments", async () => {
      const { documentId, threadId, commentId } = await startThread();
      const react = (user: typeof USERS.editor, emoji: string, active: boolean) =>
        h.call(user, "POST", `comments/${commentId}/reactions`, { emoji, active });
      expect((await react(USERS.reader, "👍", true)).status).toBe(403);
      await react(USERS.commenter, "👍", true);
      await react(USERS.commenter, "👍", true);
      const both = await react(USERS.editor, "👍", true);
      expect(both.data).toEqual([{ emoji: "👍", count: 2, mine: true }]);
      await react(USERS.editor, "🎉", true);
      const read = async (user: typeof USERS.editor) =>
        (await h.call(user, "GET", `threads/${threadId}`)).data.comments[0].reactions;
      expect(await read(USERS.commenter)).toEqual([
        { emoji: "👍", count: 2, mine: true },
        { emoji: "🎉", count: 1, mine: false }
      ]);
      expect((await react(USERS.editor, "👍", false)).data).toEqual([
        { emoji: "👍", count: 1, mine: false },
        { emoji: "🎉", count: 1, mine: true }
      ]);
      await h.call(USERS.commenter, "DELETE", `comments/${commentId}`);
      expect((await react(USERS.commenter, "👍", true)).status).toBe(404);
      expect((await h.call(USERS.commenter, "GET", `documents/${documentId}/threads`)).status).toBe(200);
    });

    it("pushes a mention with where to read it, and a failed push does not fail the comment", async () => {
      const events: { location: string; documentTitle: string; recipientId: string }[] = [];
      const pushing = createHarness(fixture.getConnectionString(), {
        notifier: {
          notify: async event => {
            events.push(event);
            if (event.recipientId === USERS.reader.id) throw new Error("mail down");
          }
        }
      });
      const { document } = (
        await pushing.call(USERS.editor, "POST", "spaces/handbook/documents", {
          title: "提及文档",
          slug: `mention-${Date.now()}`,
          markdown: "正文\n"
        })
      ).data as { document: { id: string; path: string } };
      const created = await pushing.call(USERS.commenter, "POST", `documents/${document.id}/threads`, {
        anchor: { kind: "document" },
        body: "@ 两位",
        mentions: [
          { id: USERS.reader.id, name: "读者" },
          { id: USERS.editor.id, name: "编辑者" }
        ]
      });
      expect(created.status).toBe(201);
      expect(events.map(event => event.recipientId)).toEqual([USERS.reader.id, USERS.editor.id]);
      expect(events[1]).toMatchObject({
        documentTitle: "提及文档",
        location: `handbook/${document.path}?thread=${created.data.id}`
      });
      await pushing.close();
    });
  });
});
