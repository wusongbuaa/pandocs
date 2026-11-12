import { expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { pandocsDescribe, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "pandocs-docs";

pandocsDescribe("Pandocs' own documents, for a site to see what it can do", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString());
    await app.api("admin", "PATCH", "site", { defaultLang: "zh", locales: [{ lang: "zh", label: "简体中文" }, { lang: "en", label: "English" }] });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("imports them with one click, into a space of their own that links up and shows every block", async () => {
    const page = await app.open("admin", "/_/spaces?sample=1");
    const dialog = page.getByRole("dialog", { name: "导入示例文档" });
    await browserExpect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "导入", exact: true }).click();
    await page.waitForURL(`**/${SPACE}/`, { timeout: 60_000 });
    await browserExpect(page.getByText("人和智能体，同页协作")).toBeVisible({ timeout: 15_000 });

    const tree = (await app.api("admin", "GET", `spaces/${SPACE}/tree`)).data as { path: string; id: string }[];
    expect(tree).toHaveLength(30);
    for (const entry of tree) {
      const { data } = await app.api("admin", "GET", `documents/${entry.id}`);
      expect(data.diagnostics, entry.path).toEqual([]);
    }

    await page.getByRole("link", { name: "五分钟上手" }).first().click();
    await page.waitForURL(`**/${SPACE}/start`);
    await browserExpect(page.locator("main h1")).toContainText("五分钟上手");

    await page.goto(`${app.origin}/${SPACE}/writing/blocks`);
    const main = page.locator("main");
    await browserExpect(main.locator("h1")).toContainText("内容块", { timeout: 15_000 });
    await browserExpect(main.locator(".pd-diagram svg").first()).toBeVisible({ timeout: 20_000 });
    await browserExpect(main.locator(".pd-chart svg").first()).toBeVisible({ timeout: 20_000 });
    await browserExpect(main.locator(".pd-mindmap svg").first()).toBeVisible({ timeout: 20_000 });
    await browserExpect(main.locator(".pd-compare")).toBeVisible();
    const hotspots = main.locator(".pd-hotspots img");
    await hotspots.scrollIntoViewIfNeeded();
    await expect.poll(() => hotspots.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await browserExpect(main.getByText("不支持")).toHaveCount(0);

    // Sequence diagrams, which no other page has, with the names in Chinese.
    for (const [path, diagrams] of [["agents/together", 1], ["running/storage", 3]] as const) {
      await page.goto(`${app.origin}/${SPACE}/${path}`);
      await browserExpect(main.locator(".pd-diagram svg")).toHaveCount(diagrams, { timeout: 20_000 });
      await browserExpect(main.getByText("流程图无法显示")).toHaveCount(0);
    }
    expect(app.cspReports).toEqual([]);
  });

  it("makes something to try on the page about comments", async () => {
    const page = await app.open("admin", `/${SPACE}/collaboration/comments`);
    await browserExpect(page.getByRole("button", { name: "评论 1", exact: true })).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.getByRole("button", { name: "修改建议 1", exact: true })).toBeVisible();
  });

  it("has them in the site's other language too, with links that stay in it", async () => {
    const page = await app.open("admin", `/en/${SPACE}/`);
    await browserExpect(page.getByText("People and agents, on the same page")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "Five-minute start" }).first().click();
    await page.waitForURL(`**/en/${SPACE}/start`);
    await browserExpect(page.locator("main h1")).toContainText("Five-minute start");
  });

  it("stops offering them once they are here", async () => {
    const page = await app.open("admin", "/_/spaces");
    await browserExpect(page.getByRole("link", { name: "Pandocs 文档" })).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.getByRole("button", { name: "导入示例文档" })).toHaveCount(0);
  });
});
