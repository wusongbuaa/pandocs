// @vitest-environment happy-dom
import * as React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBootstrap } from "../src/data/bootstrap";
import type { PandocsPage } from "../src/data/pages";
import { bootstrap, entry, space } from "./support";

const NOW = new Date("2026-11-06T10:00:00.000Z").getTime();

function pageWith(overrides: { diagnostics?: readonly object[]; role?: string; translation?: object | null } = {}): PandocsPage {
  return {
    kind: "document",
    space: space("handbook", []),
    entry: entry("guide"),
    rendered: { hast: { type: "root", children: [] }, toc: [], headingTitle: "", readingMinutes: 1, description: "" },
    view: { markdown: "正文\n", role: overrides.role ?? "editor", revision: { no: 3 }, document: { title: "手册" }, blocks: [], diagnostics: overrides.diagnostics ?? [] } as never,
    translation: (overrides.translation ?? null) as never
  };
}

async function renderNotices(page: PandocsPage, path = "/handbook/guide") {
  applyBootstrap(bootstrap());
  const [{ PageContext }, { DocNotices }] = await Promise.all([import("@rspress/core/runtime"), import("../src/review/doc-notices")]);
  const data = { lang: "zh", frontmatter: {}, title: "手册", toc: [], pandocs: page } as never;
  const router = createMemoryRouter([{ path: "*", element: <PageContext.Provider value={{ data }}><DocNotices /></PageContext.Provider> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
}

function serverWith(latest: number) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ data: url.includes("/revisions") ? [{ no: latest, actorName: "周一鸣", createdAt: new Date(NOW - 60_000).toISOString() }] : [] }), { status: 200 });
  }));
  return asked;
}

function comeBack() {
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("coming back to a page", () => {
  it("says when someone saved a newer version, and asks the server once in a while rather than every time", async () => {
    const asked = serverWith(4);
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await renderNotices(pageWith());
    const revisionChecks = () => asked.filter(url => url.includes("/revisions")).length;
    comeBack();
    expect(revisionChecks()).toBe(0);
    now += 16_000;
    comeBack();
    expect(await screen.findByText(/文档已更新：周一鸣/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
    const count = revisionChecks();
    comeBack();
    expect(revisionChecks()).toBe(count);
  });

  it("stays quiet when the page is current", async () => {
    const asked = serverWith(3);
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await renderNotices(pageWith());
    now += 16_000;
    comeBack();
    await waitFor(() => expect(asked.some(url => url.includes("/revisions"))).toBe(true));
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  });

  it("does not offer to throw away what someone is editing", async () => {
    serverWith(4);
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await renderNotices(pageWith(), "/handbook/guide?mode=edit");
    now += 16_000;
    comeBack();
    expect(await screen.findByText(/你保存时会自动合并/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  });
});

describe("a draft left behind", () => {
  const withDraft = (draft: object | null) => vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ data: url.endsWith("/draft") ? draft : [] }), { status: 200 })));
  const FOUND = { markdown: "没保存的内容\n", baseRevision: 3, updatedAt: new Date(NOW - 120_000).toISOString() };

  it("is mentioned on the page, with a way back to it", async () => {
    withDraft(FOUND);
    await renderNotices(pageWith());
    expect(await screen.findByText(/你有一份没有保存的草稿/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "继续编辑" })).toBeTruthy();
  });

  it("is not mentioned when it says the same as the page, while editing, or to someone who cannot have one", async () => {
    withDraft({ ...FOUND, markdown: "正文\n" });
    await renderNotices(pageWith());
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText(/没有保存的草稿/u)).toBeNull();
    cleanup();
    withDraft(FOUND);
    await renderNotices(pageWith(), "/handbook/guide?mode=edit");
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText(/没有保存的草稿/u)).toBeNull();
    cleanup();
    withDraft(FOUND);
    await renderNotices(pageWith({ role: "viewer" }));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("problems in a page", () => {
  const PROBLEMS = [{ severity: "error", code: "BLOCK_BODY_INVALID", message: "chart 的内容无法解析：不是 JSON", line: 3 }, { severity: "warning", code: "BLOCK_UNKNOWN", message: "不认识的块 foo" }];

  it("are listed for people who can do something about them", async () => {
    serverWith(3);
    await renderNotices(pageWith({ diagnostics: PROBLEMS, role: "commenter" }));
    expect(screen.getByText("这篇文档有 2 处写法问题")).toBeTruthy();
    expect(screen.getByText("第 3 行：chart 的内容无法解析：不是 JSON")).toBeTruthy();
    expect(screen.getByText("不认识的块 foo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "去修改" })).toBeTruthy();
  });

  it("stay out of the way of readers, translations and the editor", async () => {
    serverWith(3);
    await renderNotices(pageWith({ diagnostics: PROBLEMS, role: "viewer" }));
    expect(screen.queryByText(/写法问题/u)).toBeNull();
    cleanup();
    await renderNotices(pageWith({ diagnostics: PROBLEMS, translation: { lang: "en", label: "English", exists: true, stale: false, machine: false, canEdit: true } }));
    expect(screen.queryByText(/写法问题/u)).toBeNull();
    cleanup();
    await renderNotices(pageWith({ diagnostics: PROBLEMS }), "/handbook/guide?mode=edit");
    expect(screen.queryByText(/写法问题/u)).toBeNull();
  });
});
