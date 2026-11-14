import { expect as browserExpect, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { pandocsDescribe, PEOPLE, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "density";

/** Font size and line height, the way a stylesheet would say them. */
const type = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate(element => {
      const style = getComputedStyle(element);
      return `${parseFloat(style.fontSize)}/${parseFloat(style.lineHeight)}`;
    });

/** How far each step's number sits below the middle of its heading's first line. */
const stepOffsets = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll(headings =>
    headings.map(heading => {
      const style = getComputedStyle(heading);
      return (
        parseFloat(getComputedStyle(heading, "::before").top) -
        parseFloat(style.paddingTop) -
        parseFloat(style.lineHeight) / 2
      );
    })
  );

pandocsDescribe("how much fits on a page", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString());
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "手册", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
    const markdown =
      "第一段正文，足够长。\n\n- 列表里的一项\n\n## 第一节\n\n正文。\n\n### 小节\n\n正文。\n\n:::tip\n\n提示里的文字。\n\n:::\n";
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "指南", slug: "guide", markdown });
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, {
      title: "上手",
      slug: "start",
      markdown: "上手的内容。\n"
    });
    const steps =
      ":::steps\n\n## 准备\n\n正文。\n\n## 提交\n\n正文。\n\n:::\n\n:::steps\n\n### 验证\n\n正文。\n\n### 发布\n\n正文。\n\n:::\n";
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, {
      title: "发布流程",
      slug: "release",
      markdown: steps
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("keeps a page's text at its size, with tighter headings, lines and sidebar", async () => {
    const page = await app.open("editor", `/${SPACE}/guide`);
    const main = "main .rp-doc";
    await browserExpect(page.locator(`${main} h2`).first()).toBeVisible({ timeout: 15_000 });
    expect(await type(page, `${main} > p, ${main} p`)).toBe("16/26");
    expect(await type(page, `${main} ul`)).toBe("16/26");
    expect(await type(page, `${main} h2`)).toBe("24/32");
    expect(await type(page, `${main} h3`)).toBe("20/28");
    expect(await type(page, ".rp-sidebar-item")).toBe("14/22");
    const tops = await page
      .locator(".rp-sidebar-item")
      .evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
    expect(tops[1]! - tops[0]!).toBe(32);
  });

  it("gives management pages the width of the screen, with smaller headings and closer rows", async () => {
    const page = await app.open("admin", `/_/spaces/${SPACE}/members`);
    await browserExpect(page.locator(".pd-manage__head h1")).toBeVisible({ timeout: 15_000 });
    expect(await type(page, ".pd-manage__head h1")).toBe("24/32");
    expect(await type(page, ".pd-manage h2")).toBe("16/24");
    const cell = page.locator(".pd-manage td").first();
    await browserExpect(cell).toBeVisible({ timeout: 15_000 });
    expect(await cell.evaluate(element => getComputedStyle(element).paddingTop)).toBe("8px");
    expect(await page.locator(".pd-manage").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(
      900
    );
  });

  it("puts each step's number level with its heading, when reading and when editing", async () => {
    const page = await app.open("editor", `/${SPACE}/release`);
    await browserExpect(page.locator(".rp-steps > h3")).toHaveCount(2, { timeout: 15_000 });
    expect(await stepOffsets(page, ".rp-steps > :is(h2, h3)")).toEqual([0, 0, 0, 0]);
    await page.goto(`${app.origin}/${SPACE}/release?mode=edit`);
    const editing = ".pd-steps-edit [data-node-view-content] > div > :is(h2, h3)";
    await browserExpect(page.locator(editing)).toHaveCount(4, { timeout: 15_000 });
    expect(await stepOffsets(page, editing)).toEqual([0, 0, 0, 0]);
  });

  it("keeps the button that copies an agent's settings in their corner", async () => {
    const page = await app.open("editor", "/_/account");
    const settings = page.getByLabel("MCP 客户端配置");
    await browserExpect(settings).toBeVisible({ timeout: 15_000 });
    const block = (await settings.boundingBox())!;
    const button = (await page.locator(".pd-copy-block").getByRole("button", { name: "复制" }).boundingBox())!;
    expect(button.y - block.y).toBeCloseTo(8, 1);
    expect(block.x + block.width - (button.x + button.width)).toBeCloseTo(8, 1);
  });
});
