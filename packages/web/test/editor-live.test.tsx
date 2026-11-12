// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createLiveCodec, LIVE_META } from "@pandocs/editor-model";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBootstrap } from "../src/data/bootstrap";
import { bootstrap, entry, space } from "./support";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../src/ui/toast", async importOriginal => ({ ...await importOriginal<object>(), toast }));
const shared = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("../src/editor/live-session", () => ({ openLiveSession: async () => ({ session: shared.session, unreachable: false }) }));

const PUBLISHED = "# 标题\n\n原来的内容\n";

/** A shared draft as the editor sees it, with nobody else connected: what others do arrives as updates to its document. */
function sharedDraft(baseRevision: number, markdown?: string) {
  const doc = new Y.Doc();
  if (markdown !== undefined) Y.applyUpdate(doc, createLiveCodec().seed(markdown, { baseRevision }));
  const meta = doc.getMap<string | number | null>(LIVE_META);
  meta.set("baseRevision", baseRevision);
  const awareness = new Awareness(doc);
  const session = {
    doc,
    meta,
    provider: { awareness, hasUnsyncedChanges: false, on: () => undefined, off: () => undefined, setAwarenessField: (field: string, value: unknown) => awareness.setLocalStateField(field, value) },
    onEnded: () => () => undefined,
    destroy: () => awareness.destroy()
  };
  /** Someone else changes what everyone in the draft agrees on. */
  const elsewhere = (change: (meta: Y.Map<string | number | null>) => void) => {
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    change(other.getMap(LIVE_META));
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), "elsewhere"));
  };
  /** Someone else saves this text as the next version, which the server brings into the draft. */
  const savedElsewhere = (markdown: string, revision: number) => {
    const codec = createLiveCodec();
    act(() => Y.applyUpdate(doc, codec.align(Y.encodeStateAsUpdate(doc), markdown, {}).change, "elsewhere"));
    elsewhere(meta => {
      meta.set("savedBy", "小王");
      meta.set("baseRevision", revision);
    });
  };
  /** What the shared draft says now. */
  const text = (base: string) => createLiveCodec().markdownOf(Y.encodeStateAsUpdate(doc), base);
  return { session, elsewhere, savedElsewhere, text };
}

function stubServer(revision = "# 标题\n\n别人保存的内容\n", sent: { url: string; body: unknown }[] = []) {
  const asked: string[] = [];
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    asked.push(`${init.method ?? "GET"} ${url}`);
    if (typeof init.body === "string") sent.push({ url, body: JSON.parse(init.body) as unknown });
    if (/\/revisions\/\d+$/u.test(url)) return ok({ markdown: revision });
    if (url.includes("/draft") && (init.method ?? "GET") === "GET") return ok(null);
    return ok({ other: null });
  }));
  return asked;
}

async function openEditor() {
  const page = {
    kind: "document" as const,
    translation: null,
    space: space("handbook", []),
    entry: entry("guide", { title: "原文标题" }),
    view: { role: "editor", markdown: PUBLISHED, revision: { no: 3 } },
    rendered: {} as never
  };
  applyBootstrap(bootstrap({ ai: { configured: false, ask: false } }));
  const [{ PageContext }, { default: EditorPage }] = await Promise.all([import("@rspress/core/runtime"), import("../src/editor/editor-page")]);
  const data = { lang: "zh", frontmatter: {}, title: "原文标题", toc: [], routePath: "/handbook/guide", pandocs: page } as never;
  render(
    <MemoryRouter initialEntries={["/handbook/guide?mode=edit"]}>
      <PageContext.Provider value={{ data }}>
        <Routes>
          <Route path="/handbook/guide" element={<EditorPage page={page as never} />} />
        </Routes>
      </PageContext.Provider>
    </MemoryRouter>
  );
  await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull(), { timeout: 5000 });
}

beforeEach(() => {
  toast.mockClear();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a shared draft", () => {
  it("takes the title someone else types", async () => {
    stubServer();
    const draft = sharedDraft(3);
    shared.session = draft.session;
    await openEditor();
    draft.elsewhere(meta => meta.set("titleDraft", "别人改的标题"));
    await waitFor(() => expect(screen.getByDisplayValue("别人改的标题")).toBeTruthy());
  });

  it("follows a version someone else saved, and says who saved it", async () => {
    const asked = stubServer();
    const draft = sharedDraft(3);
    shared.session = draft.session;
    await openEditor();
    draft.elsewhere(meta => {
      meta.set("savedBy", "小王");
      meta.set("baseRevision", 4);
    });
    await waitFor(() => expect(asked.some(call => call.endsWith("/documents/guide/revisions/4"))).toBe(true));
    expect(toast.mock.calls.flat().join()).toContain("小王");
  });

  it("says when someone discarded it", async () => {
    stubServer();
    const draft = sharedDraft(3);
    shared.session = draft.session;
    await openEditor();
    draft.elsewhere(meta => meta.set("discardedBy", "小李"));
    await waitFor(() => expect(toast.mock.calls.flat().join()).toContain("小李"));
  });

  it("asks for no version it cannot name, and announces no save that did not happen", async () => {
    const asked = stubServer();
    const draft = sharedDraft(3);
    shared.session = draft.session;
    await openEditor();
    draft.elsewhere(meta => {
      meta.set("savedBy", "小王");
      meta.set("baseRevision", "不是数字");
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(asked.filter(call => call.includes("/revisions/"))).toEqual([]);
    expect(toast.mock.calls.flat().join()).not.toContain("小王");
  });
});

describe("the Markdown source in a shared draft", () => {
  const typeInSource = (markdown: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Markdown 源码" }));
    fireEvent.change(document.querySelector("textarea.pd-editor__source")!, { target: { value: markdown } });
  };

  it("keeps what someone else saved meanwhile when saved from the source", async () => {
    const theirs = "# 标题\n\n原来的内容\n\n别人保存的内容\n";
    const sent: { url: string; body: unknown }[] = [];
    stubServer(theirs, sent);
    const draft = sharedDraft(3, PUBLISHED);
    shared.session = draft.session;
    await openEditor();
    typeInSource("# 标题\n\n原来的内容，我在源码里改的\n");
    draft.savedElsewhere(theirs, 4);
    await waitFor(() => expect(toast.mock.calls.flat().join()).toContain("小王"));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(sent.some(item => item.url.endsWith("/documents/guide/content"))).toBe(true));
    const saved = sent.find(item => item.url.endsWith("/documents/guide/content"))!.body as { markdown: string; expectedRevision: number };
    expect(saved.markdown).toContain("别人保存的内容");
    expect(saved.markdown).toContain("我在源码里改的");
    expect(saved.expectedRevision).toBe(4);
  });

  it("puts what was typed there into the draft on stopping, as the notice says", async () => {
    stubServer();
    const draft = sharedDraft(3, PUBLISHED);
    shared.session = draft.session;
    await openEditor();
    typeInSource("# 标题\n\n原来的内容\n\n夜班待办：核对签收\n");
    fireEvent.click(screen.getByRole("button", { name: "退出编辑" }));
    expect(draft.text(PUBLISHED)).toContain("夜班待办：核对签收");
  });

  it("keeps what was typed there when the page is left another way", async () => {
    const sent: { url: string; body: unknown }[] = [];
    stubServer(undefined, sent);
    const draft = sharedDraft(3, PUBLISHED);
    shared.session = draft.session;
    await openEditor();
    typeInSource("# 标题\n\n原来的内容\n\n查完 FAQ 回来接着写\n");
    cleanup();
    await waitFor(() => expect(sent.some(item => item.url.includes("/documents/guide/draft") && JSON.stringify(item.body).includes("查完 FAQ 回来接着写"))).toBe(true));
  });
});
