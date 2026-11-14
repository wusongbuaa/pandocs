// @vitest-environment happy-dom
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, mentionQuery } from "../src/annotations/composer";
import { runHostAction } from "../src/annotations/host-actions";
import { suggestionTarget } from "../src/annotations/suggestion-target";
import { relativeTime } from "../src/ui/time";
import type { PandocsPage } from "../src/data/pages";
import { bootstrap, entry, space } from "./support";
import { applyBootstrap } from "../src/data/bootstrap";

function pageWith(markdown: string, role: "viewer" | "commenter" | "editor" = "commenter"): PandocsPage {
  return {
    kind: "document",
    space: space("handbook", []),
    entry: entry("guide"),
    rendered: { hast: { type: "root", children: [] }, toc: [], headingTitle: "", readingMinutes: 1, description: "" },
    view: { markdown, role, revision: { no: 3 }, document: { title: "手册" }, blocks: [] } as never,
    translation: null
  };
}

describe("mentionQuery", () => {
  it("finds the name being typed, right after Chinese punctuation too", () => {
    expect(mentionQuery("同意，@林")).toBe("林");
    expect(mentionQuery("@周一")).toBe("周一");
    expect(mentionQuery("请 @lin")).toBe("lin");
  });

  it("ignores addresses, a bare @ and a finished mention", () => {
    expect(mentionQuery("a@b.com")).toBeNull();
    expect(mentionQuery("请 @")).toBeNull();
    expect(mentionQuery("@林 看一下")).toBeNull();
  });

  it("leaves the Enter that picks a word to an input method, and picks someone with the next", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ version: 1, data: [{ id: "u2", name: "周一鸣" }] }))
    );
    render(<Composer placeholder="写评论" onSubmit={async () => undefined} />);
    const box = screen.getByPlaceholderText("写评论") as HTMLTextAreaElement;
    await userEvent.setup().type(box, "@周");
    await screen.findByRole("listbox");
    // Safari ends the composition before that Enter, so only its key code tells; elsewhere it comes while composing.
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(box.value).toBe("@周");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value.startsWith("@周一鸣")).toBe(true);
    cleanup();
    vi.unstubAllGlobals();
  });
});

describe("relativeTime", () => {
  // It reads in the viewer's own time zone, so these are built in the test machine's zone.
  const local = (year: number, month: number, day: number, hour: number, minute: number, second = 0) =>
    new Date(year, month - 1, day, hour, minute, second);
  const now = local(2026, 11, 6, 10, 0);
  it.each([
    [local(2026, 11, 6, 9, 59, 40), "刚刚"],
    [local(2026, 11, 6, 9, 30), "30 分钟前"],
    [local(2026, 11, 6, 8, 5), "今天 08:05"],
    [local(2026, 11, 5, 17, 42), "昨天 17:42"],
    [local(2026, 10, 1, 9, 0), "10月1日 09:00"],
    [local(2025, 10, 1, 9, 0), "2025年10月1日 09:00"]
  ])("%s reads as %s", (value, expected) => {
    expect(relativeTime(value.toISOString(), now)).toBe(expected);
  });
});

describe("what a suggestion replaces", () => {
  const markdown = "第一段有**粗体**文字。\n\n第二段只有一句。\n\n第二段只有一句。\n\n最后一段。\n";

  it("replaces words found once in the source as they are", () => {
    const target = suggestionTarget(pageWith(markdown), "最后一段", "b4", "b4")!;
    expect(target.source).toBe("最后一段");
    expect(target.ops("结尾")).toEqual([{ op: "str_replace", pattern: "最后一段", content: "结尾" }]);
  });

  it("rewrites the block when the selection crosses marks, which the source spells differently", () => {
    const target = suggestionTarget(pageWith(markdown), "有粗体文字", "b1", "b1")!;
    expect(target.source).toBe("第一段有**粗体**文字。");
    expect(target.ops("新内容")).toEqual([{ op: "block_replace", ref: "b1", content: "新内容" }]);
  });

  it("rewrites the block when the words repeat, because replacing them would be ambiguous", () => {
    const target = suggestionTarget(pageWith(markdown), "第二段只有一句。", "b3", "b3")!;
    expect(target.ops("x")).toEqual([{ op: "block_replace", ref: "b3", content: "x" }]);
  });

  it("covers every block of a selection that spans several", () => {
    const target = suggestionTarget(pageWith(markdown), "文字。第二段只有一句", "b1", "b2")!;
    expect(target.source).toBe("第一段有**粗体**文字。\n\n第二段只有一句。");
    expect(target.ops("x")).toEqual([{ op: "block_replace", ref: "b1", end: "b2", content: "x" }]);
  });
});

describe("sending a page to the host's agents", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the address within what servers accept, however much was selected", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    runHostAction(
      { id: "a", label: "发", href: "/chat?prompt={title}%0A{text}" },
      { url: "http://x", title: "标题", text: "字".repeat(5000) }
    );
    const address = String(open.mock.calls[0]![0]);
    expect(address.length).toBeLessThan(8000);
    expect(decodeURIComponent(address)).toContain(`标题\n${"字".repeat(600)}`);
  });
});

describe("host actions", () => {
  beforeEach(() => {
    vi.stubGlobal("open", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fills the link, encoded, and opens it next to the document", () => {
    runHostAction(
      { id: "a", label: "创建任务", href: "/tasks/new?title={title}&from={url}" },
      { url: "https://x.test/d?a=1", title: "登录 & 账号", text: "" }
    );
    expect(window.open).toHaveBeenCalledWith(
      `/tasks/new?title=${encodeURIComponent("登录 & 账号")}&from=${encodeURIComponent("https://x.test/d?a=1")}`,
      "_blank",
      "noopener,noreferrer"
    );
  });
});

describe("the annotation store", () => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  let threads: unknown[] = [];

  beforeEach(() => {
    requests.length = 0;
    threads = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, url, body });
        if (method === "POST" && url.endsWith("/threads")) {
          const thread = {
            id: "t1",
            status: "open",
            anchor: body.anchor,
            anchorState: "exact",
            comments: [
              {
                id: "c1",
                authorId: "me",
                authorName: "测试用户",
                authorKind: "user",
                channel: "web",
                body: body.body,
                createdAt: new Date().toISOString()
              }
            ]
          };
          threads = [thread];
          return Response.json({ version: 1, data: thread }, { status: 201 });
        }
        return Response.json({ version: 1, data: threads });
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the anchor a selection captured, then selects the new discussion", async () => {
    const store = await import("../src/annotations/store");
    await store.openDocument("d1");
    store.startComment({ kind: "text", start: 3, end: 9, exact: "选中的字", revision: 2 });
    await store.submitComment("写点什么", [{ id: "u2", name: "周一鸣" }]);
    const post = requests.find(request => request.method === "POST")!;
    expect(post.url).toBe("/api/v1/documents/d1/threads");
    expect(post.body).toEqual({
      anchor: { kind: "text", start: 3, end: 9, exact: "选中的字", revision: 2 },
      body: "写点什么",
      mentions: [{ id: "u2", name: "周一鸣" }]
    });
    function Probe() {
      const state = store.useAnnotations();
      return (
        <output>
          {JSON.stringify({
            active: state.activeId,
            pending: state.pending,
            threads: state.threads.length,
            open: state.open
          })}
        </output>
      );
    }
    render(<Probe />);
    expect(JSON.parse(screen.getByRole("status").textContent!)).toEqual({
      active: "t1",
      pending: null,
      threads: 1,
      open: true
    });
    cleanup();
    store.closeDocument();
  });

  it("anchors an image or diagram discussion by its block, without the preview", async () => {
    const store = await import("../src/annotations/store");
    await store.openDocument("d1");
    store.startComment({ kind: "block", ref: "b4", preview: "控制台", revision: 2 });
    await store.submitComment("这张图过期了", []);
    expect(requests.find(request => request.method === "POST")!.body).toMatchObject({
      anchor: { kind: "block", ref: "b4", revision: 2 }
    });
    store.closeDocument();
  });
});

describe("the selection toolbar", () => {
  afterEach(cleanup);

  async function toolbarFor(
    role: "viewer" | "commenter" | "editor",
    ai: { configured: boolean; ask: boolean } = { configured: true, ask: false }
  ) {
    applyBootstrap(
      bootstrap({ ai, site: { actions: [{ id: "agent", label: "发给智能体", href: "/chat", copy: "{title}" }] } })
    );
    const { registerBuiltinSelectionActions } = await import("../src/annotations/selection-actions");
    const { SelectionToolbar } = await import("../src/annotations/selection-toolbar");
    registerBuiltinSelectionActions(
      () => undefined,
      () => undefined
    );
    const context = {
      page: pageWith("正文\n", role),
      selection: { start: 0, end: 2, exact: "正文", rect: null },
      range: document.createRange(),
      clear: () => undefined
    };
    render(<SelectionToolbar rect={new DOMRect(100, 200, 40, 20)} context={context} />);
    return screen.getByRole("toolbar");
  }

  it("lets someone who can comment comment and suggest", async () => {
    const toolbar = await toolbarFor("commenter");
    const labels = [...toolbar.querySelectorAll("button")].map(button => button.getAttribute("aria-label"));
    expect(labels).toEqual(["评论", "建议修改", "智能辅助", "复制", "复制链接", "更多"]);
  });

  it("does not offer AI on a site with no model", async () => {
    const toolbar = await toolbarFor("commenter", { configured: false, ask: false });
    const labels = [...toolbar.querySelectorAll("button")].map(button => button.getAttribute("aria-label"));
    expect(labels).toEqual(["评论", "建议修改", "复制", "复制链接", "更多"]);
  });

  it("leaves a reader with copying, and what the host offers", async () => {
    const toolbar = await toolbarFor("viewer");
    const labels = [...toolbar.querySelectorAll("button")].map(button => button.getAttribute("aria-label"));
    expect(labels).toEqual(["智能辅助", "复制", "复制链接", "更多"]);
    await userEvent.click(toolbar.querySelector('button[aria-label="更多"]')!);
    expect(screen.getByRole("menuitem", { name: "发给智能体" })).not.toBeNull();
  });
});

describe("a suggestion from a discussion", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const THREAD = {
    id: "t1",
    documentId: "guide",
    status: "open",
    anchorState: "exact",
    summary: null,
    createdName: "",
    resolvedName: null,
    createdAt: "",
    anchor: { kind: "block", ref: "b2", type: "paragraph", hash: "x", preview: "第一段" } as never,
    comments: [
      {
        id: "c1",
        authorId: "u1",
        authorName: "林夏",
        authorKind: "user",
        channel: "web",
        body: "这里写错了，应该是第二段",
        createdAt: new Date().toISOString()
      }
    ]
  } as const;
  const SUGGESTION = { baseRevision: 3, firstRef: "b2", lastRef: "b4", source: "第一段说明。", text: "第二段说明。" };

  async function openCard(
    reply: unknown,
    role: "commenter" | "viewer" = "commenter",
    thread: object = THREAD,
    ai = { configured: true, ask: false }
  ) {
    applyBootstrap(bootstrap({ ai }));
    const calls: { url: string; method: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
        return new Response(
          JSON.stringify({
            data: url.endsWith("/suggestion")
              ? reply
              : url.endsWith("/proposals") && init.method !== "POST"
                ? []
                : { id: "p1" }
          }),
          { status: 200 }
        );
      })
    );
    const [{ ThreadCard }, { PageContext }, { MDXProvider }] = await Promise.all([
      import("../src/annotations/thread-card"),
      import("@rspress/core/runtime"),
      import("@mdx-js/react")
    ]);
    const data = {
      lang: "zh",
      frontmatter: {},
      title: "手册",
      toc: [],
      pandocs: pageWith("第一段说明。\n", role)
    } as never;
    render(
      <MemoryRouter>
        <PageContext.Provider value={{ data }}>
          <MDXProvider components={{}}>
            <ThreadCard role={role} active thread={thread as never} />
          </MDXProvider>
        </PageContext.Provider>
      </MemoryRouter>
    );
    return calls;
  }

  it("shows the change for checking, then submits it as a proposal tied to the discussion", async () => {
    const calls = await openCard(SUGGESTION);
    await userEvent.click(screen.getByRole("button", { name: "根据讨论生成修改建议" }));
    const box = (await screen.findByLabelText("改成")) as HTMLTextAreaElement;
    expect(box.value).toBe("第二段说明。");
    await waitFor(() => expect(document.querySelector(".pd-diff__row--added")?.textContent).toContain("第二段说明。"));
    await userEvent.click(screen.getByRole("button", { name: "提交建议" }));
    await waitFor(() =>
      expect(calls.some(call => call.method === "POST" && call.url.endsWith("/proposals"))).toBe(true)
    );
    const posted = calls.find(call => call.method === "POST" && call.url.endsWith("/documents/guide/proposals"))!;
    expect(posted.body).toMatchObject({
      baseRevision: 3,
      threadIds: ["t1"],
      ops: [{ op: "block_replace", ref: "b2", end: "b4", content: "第二段说明。" }]
    });
    expect(posted.body.rationale).toContain("这里写错了");
  });

  it("says so when the discussion did not ask for any change", async () => {
    await openCard({ ...SUGGESTION, text: "第一段说明。\n" });
    await userEvent.click(screen.getByRole("button", { name: "根据讨论生成修改建议" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "根据讨论生成修改建议" }) as HTMLButtonElement).disabled).toBe(false)
    );
    expect(screen.queryByLabelText("改成")).toBeNull();
  });

  it("is not offered to readers, on resolved discussions or when the text is gone", async () => {
    await openCard(SUGGESTION, "viewer");
    expect(screen.queryByRole("button", { name: "根据讨论生成修改建议" })).toBeNull();
    cleanup();
    await openCard(SUGGESTION, "commenter", { ...THREAD, status: "resolved" });
    expect(screen.queryByRole("button", { name: "根据讨论生成修改建议" })).toBeNull();
    cleanup();
    await openCard(SUGGESTION, "commenter", { ...THREAD, anchorState: "orphaned" });
    expect(screen.queryByRole("button", { name: "根据讨论生成修改建议" })).toBeNull();
    cleanup();
    await openCard(SUGGESTION, "commenter", THREAD, { configured: false, ask: false });
    expect(screen.queryByRole("button", { name: "根据讨论生成修改建议" })).toBeNull();
  });
});

describe("comments", () => {
  afterEach(cleanup);

  it("makes addresses links, and only web addresses", async () => {
    applyBootstrap(bootstrap());
    const { ThreadCard } = await import("../src/annotations/thread-card");
    render(
      <ThreadCard
        role="viewer"
        active={false}
        thread={{
          id: "t1",
          documentId: "d1",
          status: "open",
          anchorState: "exact",
          summary: null,
          createdName: "",
          resolvedName: null,
          createdAt: "",
          anchor: { kind: "document" } as never,
          comments: [
            {
              id: "c1",
              authorId: "u1",
              authorName: "林夏",
              authorKind: "user",
              channel: "web",
              mentions: [{ id: "u2", name: "周一鸣" }],
              body: "看 https://example.com/a?b=1。@周一鸣 也看，javascript:alert(1) 不算（https://example.com/b）",
              createdAt: new Date().toISOString()
            }
          ]
        }}
      />
    );
    const links = [...document.querySelectorAll(".pd-comment a")] as HTMLAnchorElement[];
    expect(links.map(link => link.getAttribute("href"))).toEqual([
      "https://example.com/a?b=1",
      "https://example.com/b"
    ]);
    expect(links[0]!.rel).toContain("noopener");
    expect(links[0]!.target).toBe("_blank");
    expect(document.querySelector(".pd-mention")?.textContent).toBe("@周一鸣");
  });

  it("shows a comment's text as text, and its mentions as names", async () => {
    applyBootstrap(bootstrap());
    const { ThreadCard } = await import("../src/annotations/thread-card");
    render(
      <ThreadCard
        role="viewer"
        active={false}
        thread={{
          id: "t1",
          documentId: "d1",
          status: "open",
          anchorState: "exact",
          summary: null,
          createdName: "",
          resolvedName: null,
          createdAt: "",
          anchor: { kind: "document" } as never,
          comments: [
            {
              id: "c1",
              authorId: "u1",
              authorName: "林夏",
              authorKind: "agent",
              channel: "mcp",
              body: "<img src=x onerror=alert(1)> @周一鸣 看看",
              createdAt: new Date().toISOString(),
              mentions: [{ id: "u2", name: "周一鸣" }]
            }
          ]
        }}
      />
    );
    expect(document.querySelector(".pd-comment img")).toBeNull();
    expect(document.querySelector(".pd-mention")?.textContent).toBe("@周一鸣");
    expect(screen.getByText("来自 MCP")).not.toBeNull();
    expect(screen.getByLabelText("智能体")).not.toBeNull();
    // A reader sees the discussion but gets no way to change it.
    expect(screen.queryByLabelText("解决这条讨论")).toBeNull();
    expect(screen.queryByLabelText("编辑这条评论")).toBeNull();
  });
});
