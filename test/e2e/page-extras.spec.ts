import { expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { createNotionImporter } from "../../packages/server/src/importers/notion.js";
import { notionExport } from "../../packages/server/test/import-sources.js";
import { pandocsDescribe, choose, PEOPLE, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "extras";

pandocsDescribe("what makes a site its own, and pages easier to work with", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;
  let guide = "";

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString(), { importers: [createNotionImporter()] });
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "手册", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
    guide = (await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "指南", slug: "guide", markdown: "## 第一节\n\n正文。\n" })).data.document.id;
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "上手", slug: "start", markdown: "上手的内容。\n" });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("uses the site's colour and rules on its pages", async () => {
    await app.api("admin", "PATCH", "site", { brandColor: "#aa3366", customCss: ".rp-doc h2 { letter-spacing: 3px; }" });
    const page = await app.open("reader", `/${SPACE}/guide`);
    await browserExpect(page.locator("main .rp-doc h2")).toBeVisible({ timeout: 15_000 });
    const look = () => page.evaluate(() => ({
      brand: getComputedStyle(document.documentElement).getPropertyValue("--rp-c-brand").trim(),
      spacing: getComputedStyle(document.querySelector("main .rp-doc h2")!).letterSpacing
    }));
    await expect.poll(look).toEqual({ brand: "#aa3366", spacing: "3px" });
    await app.api("admin", "PATCH", "site", { brandColor: "", customCss: "" });
    await page.reload();
    await browserExpect(page.locator("main .rp-doc h2")).toBeVisible({ timeout: 15_000 });
    expect((await look()).brand).toBe("#159c5d");
  });

  it("lets an editor label a page and go from a label to other pages", async () => {
    const start = (await app.api("reader", "GET", `spaces/${SPACE}/tree`)).data.find((node: { slug: string }) => node.slug === "start");
    await app.api("editor", "PUT", `documents/${start.id}/labels`, { labels: ["入门"] });
    const page = await app.open("editor", `/${SPACE}/guide`);
    await page.getByRole("button", { name: "标签", exact: true }).click();
    await page.getByRole("combobox", { name: "新标签" }).fill("入门");
    await page.keyboard.press("Enter");
    const label = page.locator(".pd-labels").getByRole("button", { name: "入门", exact: true });
    await browserExpect(label).toBeVisible();
    await label.click();
    const other = page.locator(".pd-label-pages").getByRole("link", { name: "上手" });
    await browserExpect(other).toBeVisible();
    await other.click();
    await page.waitForURL(`**/${SPACE}/start`);
    await browserExpect(page.locator(".pd-labels").getByRole("button", { name: "入门", exact: true })).toBeVisible();
    await browserExpect(page.getByText("上手的内容")).toBeVisible();
  });

  it("shows a reader the labels, without the means to change them, and leaves them out of what can be commented on", async () => {
    const page = await app.open("reader", `/${SPACE}/guide`);
    await browserExpect(page.locator(".pd-labels").getByRole("button", { name: "入门", exact: true })).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.getByRole("button", { name: "去掉标签“入门”" })).toHaveCount(0);
    await browserExpect(page.getByRole("button", { name: "标签", exact: true })).toHaveCount(0);
  });

  it("makes a new page from a template", async () => {
    await app.api("editor", "POST", `spaces/${SPACE}/templates`, { name: "周报模板", markdown: "# {{title}}\n\n## 本周完成\n\n- \n" });
    const page = await app.open("editor", `/_/spaces/${SPACE}/pages`);
    await page.getByRole("button", { name: "新建页面", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "标题" }).fill("第四十五周");
    await choose(dialog.getByRole("combobox", { name: "起始内容" }), "周报模板");
    await dialog.getByRole("button", { name: "新建", exact: true }).click();
    await browserExpect(page.getByRole("dialog")).toHaveCount(0);
    const made = (await app.api("reader", "GET", `spaces/${SPACE}/tree`)).data.find((node: { title: string }) => node.title === "第四十五周");
    expect((await app.api("reader", "GET", `documents/${made.id}`)).data.markdown).toContain("# 第四十五周\n\n## 本周完成");
  });

  it("keeps templates in a place of their own, where one can start from a page", async () => {
    const page = await app.open("editor", `/_/spaces/${SPACE}/templates`);
    await browserExpect(page.getByText("周报模板")).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.getByText("会议记录")).toBeVisible();
    await page.getByRole("button", { name: "新建模板", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "名称" }).fill("从指南来");
    await choose(dialog.getByLabel("从页面复制内容（可选）"), "指南");
    await browserExpect(dialog.getByRole("textbox", { name: "内容" })).toHaveValue(/第一节/u);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await browserExpect(page.getByText("从指南来")).toBeVisible();
  });

  it("lets an administrator set up a webhook, test it, and see what it sent, without showing its address again", async () => {
    const page = await app.open("admin", `/_/spaces/${SPACE}/webhooks`);
    await page.getByRole("button", { name: "新建 Webhook", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await choose(dialog.getByRole("combobox", { name: "发送到" }), "飞书或 Lark 群");
    await dialog.getByRole("textbox", { name: "名称" }).fill("文档群");
    await dialog.getByRole("textbox", { name: "地址" }).fill("https://open.feishu.cn/open-apis/bot/v2/hook/not-a-real-token");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await browserExpect(page.getByRole("cell", { name: /^文档群/u })).toBeVisible();
    await browserExpect(page.getByText("https://open.feishu.cn/…")).toBeVisible();
    await browserExpect(page.getByText("not-a-real-token")).toHaveCount(0);

    await page.getByRole("button", { name: "发送测试", exact: true }).first().click();
    await browserExpect(page.getByText("这个服务器不能发送 Webhook")).toBeVisible();

    const created = (await app.api("editor", "GET", `spaces/${SPACE}/tree`)).data.find((node: { slug: string }) => node.slug === "start");
    const { revision } = (await app.api("editor", "GET", `documents/${created.id}`)).data;
    await app.api("editor", "PUT", `documents/${created.id}/content`, { markdown: "又改了一点。\n", expectedRevision: revision.no }, { "idempotency-key": "extras-hook" });
    await page.getByRole("button", { name: "记录", exact: true }).click();
    const log = page.getByRole("dialog");
    await browserExpect(log.getByRole("cell", { name: "保存页面" })).toBeVisible();
    await browserExpect(log.getByText("等待中")).toBeVisible();
  });

  it("lets an editor make a link to a page, and take it back", async () => {
    const page = await app.open("editor", `/${SPACE}/guide`);
    await page.getByRole("button", { name: "分享", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await choose(dialog.getByRole("combobox", { name: "有效期" }), "30 天");
    await dialog.getByRole("button", { name: "创建链接", exact: true }).click();
    const address = dialog.getByRole("textbox", { name: "链接" });
    await browserExpect(address).toHaveValue(/\/s\/pds_[\w-]+$/u);
    await browserExpect(dialog.getByText(/过期/u).first()).toBeVisible();
    await dialog.getByRole("button", { name: "撤销", exact: true }).click();
    await browserExpect(address).toHaveCount(0);
  });

  it("does not offer sharing to someone who cannot edit, or for a closed page", async () => {
    const reader = await app.open("reader", `/${SPACE}/guide`);
    await browserExpect(reader.getByRole("button", { name: "关注", exact: true })).toBeVisible({ timeout: 15_000 });
    await browserExpect(reader.getByRole("button", { name: "分享", exact: true })).toHaveCount(0);
    await app.api("admin", "POST", `spaces/${SPACE}/documents`, { title: "内部页", slug: "closed", markdown: "内部。\n", restricted: true });
    const admin = await app.open("admin", `/${SPACE}/closed`);
    await browserExpect(admin.getByRole("button", { name: "关注", exact: true })).toBeVisible({ timeout: 15_000 });
    await browserExpect(admin.getByRole("button", { name: "分享", exact: true })).toHaveCount(0);
  });

  it("brings in an export from another tool, and its pages work: images, links, the sidebar", async () => {
    const page = await app.open("editor", `/_/spaces/${SPACE}/imports`);
    await browserExpect(page.getByRole("heading", { name: "从其他工具导入" })).toBeVisible({ timeout: 15_000 });
    const section = page.locator(".pd-bulk-imports");
    await browserExpect(section.getByRole("combobox", { name: "来源" })).toContainText("Notion");
    await section.locator('input[type="file"]').setInputFiles({ name: "export.zip", mimeType: "application/zip", buffer: Buffer.from(notionExport()) });
    await section.getByRole("button", { name: "开始导入", exact: true }).click();
    await browserExpect(section.getByText("排队中")).toBeVisible();
    await app.settleImports();
    await browserExpect(section.getByText("新建 10 个，更新 0 个，未变 0 个，文件 3 个。")).toBeVisible({ timeout: 15_000 });

    await page.goto(`${app.origin}/${SPACE}/handbook`);
    await browserExpect(page.getByText("Keep the receipt")).toBeVisible({ timeout: 15_000 });
    const image = page.getByRole("img", { name: "A diagram" });
    await browserExpect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await page.locator("main .rp-doc").getByRole("link", { name: "Returns" }).first().click();
    await browserExpect(page.getByText("Seven days")).toBeVisible();
    await page.waitForURL(`**/${SPACE}/handbook/returns`);
  });

  it("says what is missing in a dialog, puts the server's answer on its field, and Enter submits", async () => {
    const page = await app.open("admin", "/_/spaces?new=1");
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "名称" });
    await name.press("Enter");
    await browserExpect(dialog.getByText("必填").first()).toBeVisible({ timeout: 15_000 });
    await name.fill("表单测试");
    const address = dialog.getByRole("textbox", { name: "地址" });
    await address.fill("api");
    await address.press("Enter");
    // The address is fine to look at, and only the server knows it is reserved.
    await browserExpect(dialog.getByRole("alert")).toContainText("api");
    await browserExpect(address).toHaveAttribute("aria-invalid", "true");
    await address.fill("form-test");
    await browserExpect(dialog.getByRole("alert")).toHaveCount(0);
    await address.press("Enter");
    await page.waitForURL("**/_/spaces/form-test/pages**", { timeout: 15_000 });
  }, 60_000);

  it("shows one space at a time in the management sidebar, and stays on it elsewhere", async () => {
    await app.api("admin", "POST", "spaces", { slug: "second-space", name: "第二空间", defaultRole: "viewer" });
    const page = await app.open("admin", `/_/spaces/${SPACE}/members`);
    const switcher = page.getByRole("combobox", { name: "空间", exact: true });
    await browserExpect(switcher).toBeVisible({ timeout: 15_000 });
    const members = page.locator(".rp-doc-layout__sidebar").getByRole("link", { name: "成员", exact: true });
    await browserExpect(members).toHaveCount(1);
    // The page arrives rendered, and the switcher works once the script behind it has caught up.
    const second = page.getByRole("option", { name: "第二空间", exact: true });
    await browserExpect(async () => {
      await switcher.click();
      await browserExpect(second).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await second.click();
    await page.waitForURL("**/_/spaces/second-space/members");
    await browserExpect(switcher).toContainText("第二空间");
    await page.locator(".rp-doc-layout__sidebar").getByRole("link", { name: "通知中心", exact: true }).click();
    await page.waitForURL("**/_/inbox");
    await browserExpect(switcher).toContainText("第二空间");
    await browserExpect(members).toHaveAttribute("href", /second-space/u);
  }, 60_000);

  it("tells someone following a page when it changes, and lets them stop", async () => {
    const page = await app.open("reader", `/${SPACE}/guide`);
    await page.getByRole("button", { name: "关注", exact: true }).click();
    await page.getByRole("switch", { name: "这个页面" }).check();
    await browserExpect(page.getByRole("button", { name: "已关注", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    const { revision } = (await app.api("editor", "GET", `documents/${guide}`)).data;
    await app.api("editor", "PUT", `documents/${guide}/content`, { markdown: "## 第一节\n\n改过了。\n", expectedRevision: revision.no, message: "补了一段" }, { "idempotency-key": "extras-follow" });

    await page.goto(`${app.origin}/_/inbox`);
    await browserExpect(page.getByText("补了一段")).toBeVisible({ timeout: 15_000 });
    const following = page.getByRole("listitem").filter({ hasText: "取消关注" });
    await browserExpect(following.getByRole("link", { name: "指南" })).toBeVisible();
    await following.getByRole("button", { name: "取消关注" }).click();
    await browserExpect(page.getByRole("button", { name: "取消关注" })).toHaveCount(0);
  });
});
