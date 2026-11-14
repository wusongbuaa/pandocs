import { expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { pandocsDescribe, choose, PEOPLE, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "review";

pandocsDescribe("change sets", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;
  const createPage = async (title: string, slug: string, markdown: string) =>
    (await app.api("admin", "POST", `spaces/${SPACE}/documents`, { title, slug, markdown })).data.document.id as string;

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString());
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "评审", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, {
      subject: `user:${PEOPLE.commenter.id}`,
      role: "commenter"
    });
  }, 120_000);

  afterAll(async () => {
    expect(app.cspReports).toEqual([]);
    await app?.close();
  });

  it("goes from an edit in the editor, through a second page and a review, to landing on both pages at once", async () => {
    const guide = await createPage("指南", "guide", "第一段说明。\n");
    await createPage("常见问题", "faq", "老的答案。\n");
    await app.api("admin", "PATCH", `spaces/${SPACE}`, {
      mergeRules: { requiredApprovals: 1, requireChangeSets: false }
    });

    const author = await app.open("commenter", `/${SPACE}/guide?mode=edit`);
    const editor = author.locator(".ProseMirror");
    await browserExpect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await author.keyboard.press("End");
    await author.keyboard.type("补充的内容。");
    await author.getByRole("button", { name: "提交建议", exact: true }).click();
    const dialog = author.getByRole("dialog");
    await choose(dialog.getByRole("combobox", { name: "提交方式" }), "新的变更集");
    await dialog.getByRole("textbox", { name: "变更集标题" }).fill("整理帮助页");
    await dialog.getByRole("button", { name: "提交", exact: true }).click();
    await browserExpect(author.getByText("已加入变更集")).toBeVisible();

    await author.goto(`${app.origin}/_/spaces/${SPACE}/change-sets`);
    await author.getByRole("link", { name: /整理帮助页/u }).click();
    await browserExpect(author.getByRole("heading", { name: "整理帮助页" })).toBeVisible();
    await browserExpect(author.getByText("补充的内容")).toBeVisible();
    await browserExpect(author.getByText("需要 1 人批准，目前 0 人")).toBeVisible();

    await author.getByRole("button", { name: "修改页面", exact: true }).click();
    const change = author.getByRole("dialog");
    await choose(change.getByLabel("页面"), "faq");
    await browserExpect(change.getByRole("textbox", { name: "内容" })).toHaveValue(/老的答案/u);
    await change.getByRole("textbox", { name: "内容" }).fill("新的答案。\n");
    await change.getByRole("button", { name: "加入变更集", exact: true }).click();
    await browserExpect(author.getByText("新的答案")).toBeVisible();
    await browserExpect(author.getByRole("button", { name: "合并", exact: true })).toBeDisabled();

    const reviewer = await app.open("editor", "/_/inbox");
    await reviewer.getByRole("link", { name: /请求评审“整理帮助页”/u }).click();
    await browserExpect(reviewer.getByRole("heading", { name: "整理帮助页" })).toBeVisible();
    const merge = reviewer.getByRole("button", { name: "合并", exact: true });
    await browserExpect(merge).toBeDisabled();
    await reviewer.getByRole("textbox", { name: "你的评审意见（可选）" }).fill("可以");
    await reviewer.getByRole("button", { name: "批准", exact: true }).click();
    await browserExpect(reviewer.getByText("批准了")).toBeVisible();
    await browserExpect(merge).toBeEnabled();
    await merge.click();
    // Merging asks for sureness first.
    await reviewer.getByRole("alertdialog").getByRole("button", { name: "合并", exact: true }).click();
    await browserExpect(reviewer.getByText("已合并").first()).toBeVisible({ timeout: 15_000 });

    const read = await app.api("reader", "GET", `documents/${guide}`);
    expect(read.data.markdown).toContain("补充的内容");
    await author.goto(`${app.origin}/_/inbox`);
    await browserExpect(author.getByText(/合并了你的变更集/u).first()).toBeVisible();
  }, 120_000);

  it("shows what a conflict is about, and what is missing, rather than merging", async () => {
    const page = await createPage("冲突页", "conflict", "同一段。\n");
    const { data: set } = await app.api("commenter", "POST", `spaces/${SPACE}/change-sets`, { title: "会冲突" });
    await app.api("commenter", "POST", `change-sets/${set.id as string}/pages`, {
      document: page,
      baseRevision: 1,
      markdown: "我的版本。\n"
    });
    await app.api(
      "editor",
      "PUT",
      `documents/${page}/content`,
      { markdown: "他的版本。\n", expectedRevision: 1 },
      { "idempotency-key": "change-sets-conflict" }
    );
    await app.api("admin", "PATCH", `spaces/${SPACE}`, {
      mergeRules: { requiredApprovals: 0, requireChangeSets: false }
    });
    const reviewer = await app.open("editor", `/_/spaces/${SPACE}/change-sets?id=${set.id as string}`);
    await browserExpect(reviewer.getByText("这个页面的同一处已被改动")).toBeVisible({ timeout: 15_000 });
    await browserExpect(reviewer.getByRole("button", { name: "合并", exact: true })).toBeDisabled();
  }, 60_000);

  it("lets whoever made one by mistake delete it, after asking", async () => {
    const { data: set } = await app.api("commenter", "POST", `spaces/${SPACE}/change-sets`, { title: "建错的变更集" });
    const author = await app.open("commenter", `/_/spaces/${SPACE}/change-sets?id=${set.id as string}`);
    await author.getByRole("button", { name: "删除变更集" }).click({ timeout: 15_000 });
    await author.getByRole("alertdialog").getByRole("button", { name: "删除", exact: true }).click();
    await browserExpect(author.getByText("变更集已删除")).toBeVisible();
    await browserExpect(author).toHaveURL(new RegExp(`/_/spaces/${SPACE}/change-sets$`, "u"));
    await browserExpect(author.locator(".pd-manage").getByText("建错的变更集")).toHaveCount(0);
    expect((await app.api("commenter", "GET", `change-sets/${set.id as string}`)).status).toBe(404);
    const { data: other } = await app.api("commenter", "POST", `spaces/${SPACE}/change-sets`, {
      title: "别人的变更集"
    });
    const reviewer = await app.open("editor", `/_/spaces/${SPACE}/change-sets?id=${other.id as string}`);
    await browserExpect(reviewer.getByRole("button", { name: "关闭", exact: true })).toBeVisible({ timeout: 15_000 });
    await browserExpect(reviewer.getByRole("button", { name: "删除变更集" })).toHaveCount(0);
  }, 60_000);

  it("is the only way to change anything in a space that says so, without anyone needing to be told how", async () => {
    await createPage("受保护", "guarded", "原文。\n");
    await app.api("admin", "PATCH", `spaces/${SPACE}`, {
      mergeRules: { requiredApprovals: 2, requireChangeSets: true }
    });
    const page = await app.open("editor", `/${SPACE}/guarded?mode=edit`);
    const editor = page.locator(".ProseMirror");
    await browserExpect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("改一下。");
    await page.getByRole("button", { name: "提交建议", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const choice = dialog.getByRole("combobox", { name: "提交方式" });
    await browserExpect(choice).toContainText("新的变更集");
    await choice.click();
    await browserExpect(page.getByRole("option", { name: "新的变更集" })).toBeVisible();
    await browserExpect(page.getByRole("option", { name: "这个页面的修改建议" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "提交", exact: true }).click();
    await browserExpect(page.getByText("已加入变更集")).toBeVisible();
    await app.api("admin", "PATCH", `spaces/${SPACE}`, {
      mergeRules: { requiredApprovals: 0, requireChangeSets: false }
    });
  }, 60_000);

  it("lets an administrator set the rules", async () => {
    const page = await app.open("admin", `/_/spaces/${SPACE}/settings`);
    await browserExpect(page.getByRole("heading", { name: "改动评审" })).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("变更集需要的批准人数").fill("3");
    await page.getByRole("switch", { name: /所有改动都要经过评审/u }).check();
    await page.locator(".pd-merge-rules").getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(async () => (await app.api("admin", "GET", `spaces/${SPACE}`)).data.mergeRules)
      .toEqual({ requiredApprovals: 3, requireChangeSets: true });
    await app.api("admin", "PATCH", `spaces/${SPACE}`, {
      mergeRules: { requiredApprovals: 0, requireChangeSets: false }
    });
  }, 60_000);
});
