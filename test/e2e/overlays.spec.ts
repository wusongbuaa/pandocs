import { expect as browserExpect, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { pandocsDescribe, PEOPLE, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "overlays";

/** What a scroll lock changes: whichever way it does it, the page stops being scrollable by its own means. */
const scroll = (page: Page) => page.evaluate(() => ({
  gutter: getComputedStyle(document.documentElement).scrollbarGutter,
  html: getComputedStyle(document.documentElement).overflowY,
  body: getComputedStyle(document.body).overflowY
}));

pandocsDescribe("what floats over a page leaves the page alone", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString());
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "手册", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
    const long = Array.from({ length: 60 }, (_, index) => `## 第 ${index + 1} 节\n\n正文。\n`).join("\n");
    const guide = (await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "指南", slug: "guide", markdown: long })).data.document.id;
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: `user:${PEOPLE.commenter.id}`, role: "commenter" });
    await app.api("commenter", "POST", `documents/${guide}/threads`, { anchor: { kind: "quote", quote: "第 1 节" }, body: "说一句。" });
    await app.api("commenter", "POST", `documents/${guide}/proposals`, { baseRevision: 1, ops: [{ op: "str_replace", pattern: "第 2 节", content: "第二节" }] }, { "Idempotency-Key": "overlays-suggestion" });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("keeps room for the scrollbar, and scrolling, under a menu and a select", async () => {
    const page = await app.open("admin", `/_/spaces/${SPACE}/members`);
    const select = page.locator('[data-slot="select-trigger"]').first();
    await browserExpect(select).toBeVisible({ timeout: 15_000 });
    const before = await scroll(page);
    expect(before.gutter).toBe("stable");
    await browserExpect(async () => {
      await select.click();
      await browserExpect(page.getByRole("option").first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    expect(await scroll(page)).toEqual(before);
    await page.keyboard.press("Escape");

    const reader = await app.open("editor", `/${SPACE}/guide`);
    const account = reader.getByRole("button", { name: `${PEOPLE.editor.displayName} 的账号菜单`, exact: true });
    await browserExpect(account).toBeVisible({ timeout: 15_000 });
    const start = await scroll(reader);
    await browserExpect(async () => {
      await account.click();
      await browserExpect(reader.getByRole("menu")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    expect(await scroll(reader)).toEqual(start);
    await reader.mouse.wheel(0, 400);
    await expect.poll(() => reader.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  it("covers the room for the scrollbar when a dialog does stop the page scrolling", async () => {
    const page = await app.open("editor", `/${SPACE}/guide`);
    const share = page.getByRole("button", { name: "分享", exact: true });
    await browserExpect(share).toBeVisible({ timeout: 15_000 });
    const main = () => page.locator("main").evaluate(element => element.getBoundingClientRect().toJSON());
    const before = await main();
    const background = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    const open = await background();
    await browserExpect(async () => {
      await share.click();
      await browserExpect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    expect(await main()).toEqual(before);
    await expect.poll(background).not.toBe(open);
    await page.keyboard.press("Escape");
    await browserExpect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(background).toBe(open);
  });

  it("does not push a page down when what is waiting on it arrives", async () => {
    const page = await app.open("editor", `/${SPACE}/guide`);
    await page.setViewportSize({ width: 1280, height: 800 });
    const row = page.locator(".rp-llms-container");
    await browserExpect(row.getByRole("button", { name: "修改建议 1", exact: true })).toBeVisible({ timeout: 15_000 });
    await browserExpect(row.getByRole("button", { name: "评论 1", exact: true })).toBeVisible();
    const height = await row.evaluate(element => element.getBoundingClientRect().height);
    expect(height).toBe(36);
  });
});
