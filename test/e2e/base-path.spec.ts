import { expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { pandocsDescribe, PEOPLE, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "handbook";

pandocsDescribe("a site below a path of another site's", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString(), {}, { base: "/docs" });
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "手册", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "指南", slug: "guide", markdown: "## 第一节\n\n公式 $$E = mc^2$$ 和[上手](./start)。\n\n:::steps\n\n### 准备\n\n正文。\n\n:::\n" });
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "上手", slug: "start", markdown: "上手要读的内容。\n" });
  }, 120_000);

  afterAll(async () => {
    expect(app.cspReports).toEqual([]);
    await app?.close();
  });

  it("reads, moves between pages, searches, edits and manages without leaving its path", async () => {
    const page = await app.open("editor", `/${SPACE}/guide`);
    await browserExpect(page.locator("main .rp-doc h2").first()).toContainText("第一节", { timeout: 15_000 });
    await browserExpect(page.locator(".katex").first()).toBeVisible();
    const link = page.locator(".rp-sidebar-item", { hasText: "上手" });
    await browserExpect(link).toHaveAttribute("href", `/docs/${SPACE}/start`);
    await link.click();
    await browserExpect(page.getByText("上手要读的内容。")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/docs/${SPACE}/start`);

    await page.keyboard.press("ControlOrMeta+k");
    await page.locator(".rp-search-panel__input").fill("第一节");
    await browserExpect(page.locator(".rp-suggest-item__title, .rp-suggest-item__header").filter({ hasText: "指南" }).first()).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    await page.goto(`${app.origin}/docs/${SPACE}/guide?mode=edit`);
    await browserExpect(page.locator(".ProseMirror")).toContainText("第一节", { timeout: 15_000 });
    await page.goto(`${app.origin}/docs/_/spaces/${SPACE}/pages`);
    await browserExpect(page.locator(".pd-manage").getByText("上手").first()).toBeVisible({ timeout: 15_000 });
    await page.goto(`${app.origin}/docs/_/account`);
    await browserExpect(page.getByLabel("MCP 客户端配置")).toContainText(`${app.origin}/docs/mcp`, { timeout: 15_000 });
    expect(app.outside).toEqual([]);
  }, 90_000);
});
