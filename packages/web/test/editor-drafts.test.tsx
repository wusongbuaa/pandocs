// @vitest-environment happy-dom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBootstrap } from "../src/data/bootstrap";
import { bootstrap, entry, space } from "./support";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../src/ui/toast", async importOriginal => ({ ...(await importOriginal<object>()), toast }));

const DRAFT_URL = /\/documents\/guide\/draft(\?lang=([a-z]+))?$/u;
const PUBLISHED = "# 标题\n\n原来的内容\n";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown> | null;
  readonly keepalive: boolean;
}

/** A server for the routes the editor uses, and what it was asked. */
function stubServer({
  draft = null,
  onSaveDraft,
  assistText = ""
}: {
  draft?: unknown;
  onSaveDraft?: (call: Call) => Response | Promise<Response> | undefined;
  assistText?: string;
} = {}) {
  const calls: Call[] = [];
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? "GET",
        url,
        body: init.body ? JSON.parse(String(init.body)) : null,
        keepalive: init.keepalive === true
      };
      calls.push(call);
      if (url.includes("/draft/assist")) return ok({ text: assistText });
      if (DRAFT_URL.test(url)) {
        if (call.method === "GET") return ok(draft);
        if (call.method === "PUT") return (await onSaveDraft?.(call)) ?? ok({ updatedAt: "2026-11-06T08:00:00.000Z" });
        return ok(null);
      }
      if (url.endsWith("/editing")) return ok({ other: null });
      return ok({ merged: false, changed: true });
    })
  );
  const savesOf = () => calls.filter(call => call.method === "PUT" && DRAFT_URL.test(call.url));
  const deletesOf = () => calls.filter(call => call.method === "DELETE" && DRAFT_URL.test(call.url));
  return { calls, savesOf, deletesOf };
}

function page(
  overrides: { role?: string; translation?: unknown; markdown?: string; titles?: Record<string, string> } = {}
) {
  return {
    kind: "document" as const,
    translation: overrides.translation ?? null,
    space: space("handbook", []),
    entry: entry("guide", { title: "原文标题", ...(overrides.titles ? { titles: overrides.titles } : {}) }),
    view: { role: overrides.role ?? "editor", markdown: overrides.markdown ?? PUBLISHED, revision: { no: 3 } },
    rendered: {} as never
  };
}

const TRANSLATION = { lang: "en", label: "English", canEdit: true, exists: true, stale: false, machine: false };

let goElsewhere: () => void = () => undefined;

async function openEditor(current: ReturnType<typeof page>, ai = { configured: true, ask: false }) {
  applyBootstrap(bootstrap({ ai }));
  const [{ PageContext }, { default: EditorPage }] = await Promise.all([
    import("@rspress/core/runtime"),
    import("../src/editor/editor-page")
  ]);
  const data = {
    lang: "zh",
    frontmatter: {},
    title: "原文标题",
    toc: [],
    routePath: "/handbook/guide",
    pandocs: current
  } as never;
  function Editing() {
    const navigate = useNavigate();
    goElsewhere = () => navigate("/elsewhere");
    const [params] = useSearchParams();
    return params.get("mode") === "edit" ? <EditorPage page={current as never} /> : <p>已离开编辑器</p>;
  }
  return render(
    <MemoryRouter initialEntries={["/handbook/guide?mode=edit"]}>
      <PageContext.Provider value={{ data }}>
        <Routes>
          <Route path="/handbook/guide" element={<Editing />} />
          <Route path="*" element={<p>已离开编辑器</p>} />
        </Routes>
      </PageContext.Provider>
    </MemoryRouter>
  );
}

function editorInstance() {
  const element = document.querySelector(".ProseMirror") as
    | (HTMLElement & { editor?: { chain(): any; getMarkdown?(): string } })
    | null;
  return element?.editor ?? null;
}

async function editorReady() {
  await waitFor(() => expect(editorInstance()).not.toBeNull(), { timeout: 5000 });
}

function type(text: string) {
  act(() => {
    editorInstance()!.chain().focus("end").insertContent(text).run();
  });
}

const lastSave = (saves: readonly Call[]) => saves.at(-1)!;
const localDraftKey = (lang = "") => `pandocs:draft:me:guide:${lang}`;

beforeEach(() => {
  toast.mockClear();
  // Node's own `localStorage` hides the test environment's, and needs a file to work.
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key)
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("leaving the editor", () => {
  it("saves what was typed a moment ago when someone navigates away", async () => {
    const server = stubServer();
    await openEditor(page());
    await editorReady();
    type("刚打的字");
    act(() => goElsewhere());
    await screen.findByText("已离开编辑器");
    await waitFor(() => expect(server.savesOf()).toHaveLength(1));
    expect(String(lastSave(server.savesOf()).body!.markdown)).toContain("刚打的字");
    expect(lastSave(server.savesOf()).body!.baseRevision).toBe(3);
    expect(toast.mock.calls).toEqual([["修改已存为草稿，下次打开可以继续"]]);
    await waitFor(() => expect(localStorage.getItem(localDraftKey())).toBeNull());
  });

  it("keeps a copy in this browser when that save does not go through", async () => {
    const server = stubServer({ onSaveDraft: () => Promise.reject(new TypeError("Failed to fetch")) });
    await openEditor(page());
    await editorReady();
    type("断网时打的字");
    act(() => goElsewhere());
    await screen.findByText("已离开编辑器");
    await waitFor(() => expect(server.savesOf()).toHaveLength(1));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(localDraftKey()) ?? "{}").markdown).toContain("断网时打的字")
    );
  });

  it("lets a request outlive a closing tab, with a copy here in case it does not arrive", async () => {
    const server = stubServer({ onSaveDraft: () => new Promise<Response>(() => undefined) });
    await openEditor(page());
    await editorReady();
    type("关标签页前打的字");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await waitFor(() => expect(server.savesOf()).toHaveLength(1));
    expect(lastSave(server.savesOf()).keepalive).toBe(true);
    expect(String(lastSave(server.savesOf()).body!.markdown)).toContain("关标签页前打的字");
    expect(JSON.parse(localStorage.getItem(localDraftKey()) ?? "{}").markdown).toContain("关标签页前打的字");
  });

  it("does not ask when nothing changed", async () => {
    stubServer();
    await openEditor(page());
    await editorReady();
    fireEvent.click(screen.getByRole("button", { name: "退出编辑" }));
    await screen.findByText("已离开编辑器");
  });

  it("asks when something changed, and keeps it as a draft on request", async () => {
    const server = stubServer();
    await openEditor(page());
    await editorReady();
    type("想留下的字");
    fireEvent.click(screen.getByRole("button", { name: "退出编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: "留作草稿并退出" }));
    await screen.findByText("已离开编辑器");
    expect(String(lastSave(server.savesOf()).body!.markdown)).toContain("想留下的字");
    expect(server.deletesOf()).toHaveLength(0);
    expect(toast.mock.calls).toEqual([["修改已存为草稿，下次打开可以继续"]]);
  });

  it("says where the draft is when the server cannot take it on the way out", async () => {
    stubServer({ onSaveDraft: () => Promise.reject(new TypeError("Failed to fetch")) });
    await openEditor(page());
    await editorReady();
    type("没发出去的字");
    fireEvent.click(screen.getByRole("button", { name: "退出编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: "留作草稿并退出" }));
    await screen.findByText("已离开编辑器");
    expect(toast.mock.calls).toEqual([["暂时连不上服务器，草稿先留在这台电脑上"]]);
    expect(JSON.parse(localStorage.getItem(localDraftKey()) ?? "{}").markdown).toContain("没发出去的字");
  });

  it("throws everything away on request", async () => {
    const server = stubServer();
    localStorage.setItem(
      localDraftKey(),
      JSON.stringify({ markdown: "旧的", baseRevision: 3, updatedAt: "2020-01-01T00:00:00.000Z" })
    );
    await openEditor(page());
    fireEvent.click(await screen.findByRole("button", { name: "继续编辑草稿" }));
    await editorReady();
    type("不要的字");
    fireEvent.click(screen.getByRole("button", { name: "退出编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: "丢弃修改" }));
    await screen.findByText("已离开编辑器");
    expect(server.deletesOf()).toHaveLength(1);
    expect(localStorage.getItem(localDraftKey())).toBeNull();
    expect(server.savesOf().filter(save => String(save.body!.markdown).includes("不要的字"))).toHaveLength(0);
  });

  it("clears the drafts once the page is saved", async () => {
    const server = stubServer();
    await openEditor(page());
    await editorReady();
    type("保存的字");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已离开编辑器");
    expect(
      server.calls.some(
        call =>
          call.method === "PUT" &&
          call.url.endsWith("/documents/guide/content") &&
          String(call.body!.markdown).includes("保存的字")
      )
    ).toBe(true);
    expect(server.deletesOf()).toHaveLength(1);
    expect(localStorage.getItem(localDraftKey())).toBeNull();
    expect(server.savesOf()).toHaveLength(0);
  });
});

describe("autosave", () => {
  it("leaves a copy in this browser and says so when the server cannot be reached", async () => {
    stubServer({ onSaveDraft: () => Promise.reject(new TypeError("Failed to fetch")) });
    await openEditor(page());
    await editorReady();
    type("断网的字");
    await screen.findByText("草稿暂存在这台电脑上，恢复后会同步", undefined, { timeout: 4000 });
    expect(JSON.parse(localStorage.getItem(localDraftKey()) ?? "{}").markdown).toContain("断网的字");
  });

  it("does not count a save as covering what was typed while it was on its way", async () => {
    let answer: (response: Response) => void = () => undefined;
    const server = stubServer({
      onSaveDraft: call =>
        String(call.body!.markdown).includes("后打的字")
          ? undefined
          : new Promise<Response>(resolve => {
              answer = resolve;
            })
    });
    await openEditor(page());
    await editorReady();
    type("先打的字");
    await waitFor(() => expect(server.savesOf()).toHaveLength(1), { timeout: 4000 });
    type("后打的字");
    await act(async () => {
      answer(new Response(JSON.stringify({ data: { updatedAt: "2026-11-06T08:00:00.000Z" } }), { status: 200 }));
      await Promise.resolve();
    });
    act(() => goElsewhere());
    await screen.findByText("已离开编辑器");
    await waitFor(() => expect(server.savesOf()).toHaveLength(2));
    expect(String(lastSave(server.savesOf()).body!.markdown)).toContain("后打的字");
  });
});

describe("an expired session", () => {
  it("keeps the text and asks to sign in, instead of leaving the page", async () => {
    stubServer({
      onSaveDraft: () =>
        new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "未登录" } }), { status: 401 })
    });
    const reload = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      reload,
      href: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash
    });
    await openEditor(page());
    await editorReady();
    type("过期后打的字");
    await screen.findByText("登录已过期", undefined, { timeout: 4000 });
    expect(reload).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(localDraftKey()) ?? "{}").markdown).toContain("过期后打的字");
    fireEvent.click(screen.getByRole("button", { name: "重新登录" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(localDraftKey()) ?? "{}").markdown).toContain("过期后打的字");
  });
});

describe("opening on a draft", () => {
  const SERVER_DRAFT = {
    markdown: "# 标题\n\n服务器上的草稿\n",
    baseRevision: 2,
    updatedAt: "2026-11-06T07:00:00.000Z"
  };

  it("can be saved straight away, since it already differs from the page", async () => {
    stubServer({ draft: SERVER_DRAFT });
    await openEditor(page());
    fireEvent.click(await screen.findByRole("button", { name: "继续编辑草稿" }));
    await editorReady();
    await waitFor(() => expect(document.querySelector(".ProseMirror")?.textContent).toContain("服务器上的草稿"));
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("prefers the copy in this browser when it is newer, and hands it to the server", async () => {
    const server = stubServer({ draft: SERVER_DRAFT });
    localStorage.setItem(
      localDraftKey(),
      JSON.stringify({ markdown: "# 标题\n\n本机的草稿\n", baseRevision: 3, updatedAt: "2026-11-06T07:30:00.000Z" })
    );
    await openEditor(page());
    fireEvent.click(await screen.findByRole("button", { name: "继续编辑草稿" }));
    await editorReady();
    await waitFor(() => expect(document.querySelector(".ProseMirror")?.textContent).toContain("本机的草稿"));
    await waitFor(() => expect(server.savesOf()).toHaveLength(1), { timeout: 4000 });
    expect(String(lastSave(server.savesOf()).body!.markdown)).toContain("本机的草稿");
    await waitFor(() => expect(localStorage.getItem(localDraftKey())).toBeNull());
  });

  it("prefers the server's copy when it is newer", async () => {
    stubServer({ draft: SERVER_DRAFT });
    localStorage.setItem(
      localDraftKey(),
      JSON.stringify({ markdown: "# 标题\n\n更早的本机草稿\n", baseRevision: 3, updatedAt: "2026-11-06T06:00:00.000Z" })
    );
    await openEditor(page());
    fireEvent.click(await screen.findByRole("button", { name: "继续编辑草稿" }));
    await editorReady();
    await waitFor(() => expect(document.querySelector(".ProseMirror")?.textContent).toContain("服务器上的草稿"));
  });

  it("does not ask about a draft the same as the page", async () => {
    stubServer({ draft: { ...SERVER_DRAFT, markdown: PUBLISHED } });
    localStorage.setItem(
      localDraftKey(),
      JSON.stringify({ markdown: PUBLISHED, baseRevision: 3, updatedAt: "2026-11-06T07:30:00.000Z" })
    );
    await openEditor(page());
    await editorReady();
    expect(screen.queryByRole("button", { name: "继续编辑草稿" })).toBeNull();
    expect(localStorage.getItem(localDraftKey())).toBeNull();
  });

  it("uses the draft of someone else's account for nobody", async () => {
    stubServer();
    localStorage.setItem(
      "pandocs:draft:someone:guide:",
      JSON.stringify({ markdown: "别人的草稿", baseRevision: 3, updatedAt: "2099-01-01T00:00:00.000Z" })
    );
    await openEditor(page());
    await editorReady();
    expect(screen.queryByRole("button", { name: "继续编辑草稿" })).toBeNull();
  });
});

describe("a translation", () => {
  it("has a draft of its own, title included", async () => {
    const server = stubServer();
    await openEditor(
      page({ translation: TRANSLATION, role: "viewer", markdown: "# Title\n\nBody\n", titles: { en: "English title" } })
    );
    await editorReady();
    expect(
      server.calls.some(call => call.method === "GET" && call.url.endsWith("/documents/guide/draft?lang=en"))
    ).toBe(true);
    const title = screen.getByLabelText("标题") as HTMLInputElement;
    expect(title.value).toBe("English title");
    fireEvent.change(title, { target: { value: "New title" } });
    await waitFor(() => expect(server.savesOf()).toHaveLength(1), { timeout: 4000 });
    expect(lastSave(server.savesOf()).url).toMatch(/\/documents\/guide\/draft\?lang=en$/u);
    expect(lastSave(server.savesOf()).body!.title).toBe("New title");
  });

  it("resumes with the title it had, even when only the title changed", async () => {
    stubServer({
      draft: {
        markdown: "# Title\n\nBody\n",
        title: "Draft title",
        baseRevision: 3,
        updatedAt: "2026-11-06T07:00:00.000Z"
      }
    });
    await openEditor(
      page({ translation: TRANSLATION, role: "viewer", markdown: "# Title\n\nBody\n", titles: { en: "English title" } })
    );
    fireEvent.click(await screen.findByRole("button", { name: "继续编辑草稿" }));
    await editorReady();
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("Draft title");
  });

  it("clears only its own draft once saved", async () => {
    const server = stubServer();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign,
      href: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash
    });
    await openEditor(
      page({ translation: TRANSLATION, role: "viewer", markdown: "# Title\n\nBody\n", titles: { en: "English title" } })
    );
    await editorReady();
    type("more");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(server.deletesOf().map(call => call.url.split("/").at(-1))).toEqual(["draft?lang=en"]);
  });
});

describe("the title", () => {
  it("is a field in the editor, saved as a draft and with the page", async () => {
    const server = stubServer();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign,
      href: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash
    });
    await openEditor(page());
    await editorReady();
    const title = screen.getByLabelText("标题") as HTMLInputElement;
    expect(title.value).toBe("原文标题");
    fireEvent.change(title, { target: { value: "新的标题" } });
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(server.savesOf()).toHaveLength(1), { timeout: 4000 });
    expect(lastSave(server.savesOf()).body!.title).toBe("新的标题");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(
      server.calls.find(call => call.method === "PUT" && call.url.endsWith("/documents/guide/content"))!.body!.title
    ).toBe("新的标题");
    expect(server.deletesOf()).toHaveLength(1);
  });

  it("is saved, after someone moved the page meanwhile, to where it is now", async () => {
    stubServer();
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) =>
        init.method === "PUT" && url.endsWith("/documents/guide/content")
          ? new Response(
              JSON.stringify({ data: { merged: false, changed: true, document: { path: "returns/guide" } } }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          : answer(url, init)
      )
    );
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign,
      href: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash
    });
    await openEditor(page());
    await editorReady();
    type("正文的字");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(String(assign.mock.calls[0]![0])).toMatch(/\/handbook\/returns\/guide$/u);
  });

  it("leaves the save alone when it did not change, and cannot be left empty", async () => {
    const server = stubServer();
    await openEditor(page());
    await editorReady();
    type("正文的字");
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "  " } });
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "原文标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已离开编辑器");
    expect(
      server.calls.find(call => call.method === "PUT" && call.url.endsWith("/documents/guide/content"))!.body
    ).not.toHaveProperty("title");
  });

  it("offers a draft that only changed the title", async () => {
    stubServer({
      draft: { markdown: PUBLISHED, title: "草稿里的标题", baseRevision: 3, updatedAt: "2026-11-06T07:00:00.000Z" }
    });
    await openEditor(page());
    fireEvent.click(await screen.findByRole("button", { name: "继续编辑草稿" }));
    await editorReady();
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("草稿里的标题");
  });
});

describe("problems in the text", () => {
  const BROKEN = "正文\n\n```chart\n不是 JSON\n```\n";

  it("are listed in the editor from the start, and follow the text", async () => {
    stubServer();
    await openEditor(page({ markdown: BROKEN }));
    await editorReady();
    expect(screen.getByRole("button", { name: /1 处写法问题/u })).toBeTruthy();
  });

  it("does not bother anyone when there are none", async () => {
    stubServer();
    await openEditor(page());
    await editorReady();
    expect(screen.queryByRole("button", { name: /写法问题/u })).toBeNull();
  });
});

describe("AI while editing", () => {
  const openMenu = async () => {
    act(() => {
      editorInstance()!.chain().focus().setTextSelection({ from: 7, to: 10 }).run();
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
  };

  it("is not offered on a site with no model", async () => {
    stubServer({});
    await openEditor(page({ markdown: "# 标题\n\n原来的内容\n" }), { configured: false, ask: false });
    await editorReady();
    act(() => {
      editorInstance()!.chain().focus().setTextSelection({ from: 7, to: 10 }).run();
    });
    await screen.findByRole("button", { name: "评论" });
    expect(screen.queryByRole("button", { name: "AI" })).toBeNull();
  });

  it("saves the draft first, reads from it, and replaces only on request", async () => {
    const server = stubServer({ assistText: "改写后的字" });
    await openEditor(page({ markdown: "# 标题\n\n原来的内容\n" }));
    await editorReady();
    type("补充");
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "改写" }));
    const replace = await screen.findByRole("button", { name: "替换选中文字" });
    expect(server.savesOf()).toHaveLength(1);
    expect(String(lastSave(server.savesOf()).body!.markdown)).toContain("补充");
    const body = server.calls.find(call => call.url.includes("/draft/assist"))!.body as {
      action: string;
      quote: string;
    };
    expect(body.action).toBe("rewrite");
    expect(document.querySelector(".ProseMirror")?.textContent).not.toContain("改写后的字");
    fireEvent.click(replace);
    await waitFor(() => expect(document.querySelector(".ProseMirror")?.textContent).toContain("改写后的字"));
    expect(document.querySelector(".ProseMirror")?.textContent).not.toContain(body.quote);
  });

  it("offers no replacing for what is only an explanation", async () => {
    stubServer({ assistText: "这段说的是" });
    await openEditor(page({ markdown: "# 标题\n\n原来的内容\n" }));
    await editorReady();
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "解释" }));
    await screen.findByText("这段说的是");
    expect(screen.queryByRole("button", { name: "替换选中文字" })).toBeNull();
  });
});

describe("the Markdown source", () => {
  const WRITTEN = "---\ntag: 示例\n---\n\n# 标题\n\n*   写法特别的列表\n*   第二项\n\n最后一段\n";
  const sourceBox = () => screen.getByRole("textbox", { name: "Markdown 源码" }) as HTMLTextAreaElement;
  const toggle = () => fireEvent.click(screen.getByRole("button", { name: "Markdown 源码" }));

  it("shows the whole text, front matter included, and saves exactly what was typed", async () => {
    const server = stubServer();
    await openEditor(page({ markdown: WRITTEN }));
    await editorReady();
    toggle();
    expect(sourceBox().value).toBe(WRITTEN);
    const typed = `${WRITTEN}\n::unknownblock\n`;
    fireEvent.change(sourceBox(), { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已离开编辑器");
    expect(
      server.calls.find(call => call.method === "PUT" && call.url.endsWith("/documents/guide/content"))!.body!.markdown
    ).toBe(typed);
  });

  it("keeps it safe the same way as the editor", async () => {
    const server = stubServer();
    await openEditor(page({ markdown: WRITTEN }));
    await editorReady();
    toggle();
    fireEvent.change(sourceBox(), { target: { value: `${WRITTEN}\n刚写的\n` } });
    act(() => goElsewhere());
    await screen.findByText("已离开编辑器");
    await waitFor(() => expect(server.savesOf()).toHaveLength(1));
    expect(String(lastSave(server.savesOf()).body!.markdown)).toContain("刚写的");
  });

  it("carries changes back to the editor, and untouched blocks keep their exact bytes", async () => {
    const server = stubServer();
    await openEditor(page({ markdown: WRITTEN }));
    await editorReady();
    toggle();
    fireEvent.change(sourceBox(), {
      target: { value: WRITTEN.replace("tag: 示例", "tag: 新的").replace("最后一段", "改过的一段") }
    });
    toggle();
    expect(screen.queryByRole("textbox", { name: "Markdown 源码" })).toBeNull();
    await waitFor(() => expect(document.querySelector(".ProseMirror")?.textContent).toContain("改过的一段"));
    type("和新写的");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已离开编辑器");
    const saved = String(
      server.calls.find(call => call.method === "PUT" && call.url.endsWith("/documents/guide/content"))!.body!.markdown
    );
    expect(saved).toContain("tag: 新的");
    expect(saved).toContain("*   写法特别的列表\n*   第二项");
    expect(saved).toContain("改过的一段和新写的");
  });

  it("indents with Tab rather than leaving the box", async () => {
    stubServer();
    await openEditor(page());
    await editorReady();
    toggle();
    const box = sourceBox();
    box.setSelectionRange(0, 0);
    fireEvent.keyDown(box, { key: "Tab" });
    expect(sourceBox().value.startsWith("  ")).toBe(true);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("diagrams, charts and file trees", () => {
  const WRITTEN =
    '开头\n\n```tree title="目录"\nsrc\n└── a.ts\n```\n\n```chart\n{"type":"bar","xKey":"月","data":[{"月":"一","数":1}]}\n```\n\n```ts\nconst a = 1;\n```\n';
  const views = () => [...document.querySelectorAll(".pd-code-view")] as HTMLElement[];

  it("read as they will on the page, and ordinary code stays code", async () => {
    stubServer();
    await openEditor(page({ markdown: WRITTEN }));
    await editorReady();
    await waitFor(() => expect(views()).toHaveLength(3));
    const [tree, chart, code] = views() as [HTMLElement, HTMLElement, HTMLElement];
    await waitFor(() => expect(tree.querySelector(".pd-file-tree figcaption")?.textContent).toBe("目录"));
    expect(tree.querySelector(".pd-code-view__source--closed")).not.toBeNull();
    expect(chart.querySelector(".pd-code-view__preview")).not.toBeNull();
    expect(code.querySelector(".pd-code-view__preview")).toBeNull();
    expect(code.querySelector(".pd-code-view__source--closed")).toBeNull();
  });

  it("open their source when the caret goes in, with the preview following what is typed", async () => {
    stubServer();
    await openEditor(page({ markdown: WRITTEN }));
    await editorReady();
    await waitFor(() => expect(views()).toHaveLength(3));
    const tree = views()[0]!;
    fireEvent.mouseDown(tree.querySelector(".pd-code-view__preview")!);
    await waitFor(() => expect(tree.querySelector(".pd-code-view__source--closed")).toBeNull());
    act(() => {
      editorInstance()!.chain().insertContent("x").run();
    });
    await waitFor(() => expect(tree.querySelector(".pd-file-tree")?.textContent).toMatch(/xsrc|srcx/u), {
      timeout: 2000
    });
  });

  it("save back to the same Markdown", async () => {
    const server = stubServer();
    await openEditor(page({ markdown: WRITTEN }));
    await editorReady();
    type("结尾");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已离开编辑器");
    const saved = String(
      server.calls.find(call => call.method === "PUT" && call.url.endsWith("/documents/guide/content"))!.body!.markdown
    );
    expect(saved).toContain('```tree title="目录"\nsrc\n└── a.ts\n```');
    expect(saved).toContain("```ts\nconst a = 1;");
  });
});

describe("someone who cannot edit a page in another language", () => {
  it("suggests changes to the source rather than writing a translation", async () => {
    const server = stubServer();
    await openEditor(page({ role: "commenter", translation: { ...TRANSLATION, canEdit: false, exists: false } }));
    await editorReady();
    expect(screen.getByRole("button", { name: "提交建议" })).toBeTruthy();
    expect(screen.queryByLabelText("标题")).toBeNull();
    expect(server.calls.some(call => call.method === "GET" && call.url.endsWith("/documents/guide/draft"))).toBe(true);
  });
});
