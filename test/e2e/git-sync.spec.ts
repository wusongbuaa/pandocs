import { expect as browserExpect, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeRepository } from "../../packages/core/test/fake-git.js";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { pandocsDescribe, choose, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "synced";

pandocsDescribe("keeping a space the same as a repository", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;
  const repo = new FakeRepository();
  /** Asks for a sync as someone would, and does what the worker would. */
  const syncNow = async (page: Page) => {
    const asked = page.waitForResponse(response => response.url().endsWith("/git-sync/run"));
    await page.getByRole("button", { name: "立即同步", exact: true }).click();
    await asked;
    await browserExpect(page.getByText("稍后开始同步").first()).toBeVisible();
    await app.settleGitSync();
  };

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString(), { git: repo });
    // Work in the background speaks the site's language, there being nobody's browser to ask.
    await app.api("admin", "PATCH", "site", { defaultLang: "zh", locales: [{ lang: "zh", label: "简体中文" }] });
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "同步", defaultRole: "viewer" });
    await app.api("admin", "POST", `spaces/${SPACE}/documents`, { title: "指南", slug: "guide", markdown: "第一段。\n" });
  }, 120_000);

  afterAll(async () => {
    expect(app.cspReports).toEqual([]);
    await app?.close();
  });

  it("connects, syncs, says how to be quicker, shows what went wrong, and disconnects", async () => {
    const page = await app.open("admin", `/_/spaces/${SPACE}/git-sync`);
    await browserExpect(page.getByText("还没有连接仓库")).toBeVisible();

    await page.getByRole("button", { name: "连接仓库", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: /^仓库/u }).fill("https://someone:hunter2@git.example.com/acme/docs.git");
    await dialog.getByLabel("访问令牌").fill("secret-token");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    // A password in the address is the one thing it will not take.
    await browserExpect(page.getByText("仓库地址要以 https:// 开头，令牌单独填写")).toBeVisible();
    await dialog.getByRole("textbox", { name: /^仓库/u }).fill("https://git.example.com/acme/docs.git");
    await dialog.getByRole("textbox", { name: /^目录/u }).fill("docs");
    await choose(dialog.getByRole("combobox", { name: "页面和文件地址相同时" }), "保留文件，作为页面的新版本");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();

    await browserExpect(page.getByText("等待第一次同步")).toBeVisible();
    await browserExpect(page.getByRole("definition").getByText("https://git.example.com/acme/docs.git", { exact: true })).toBeVisible();
    await browserExpect(page.getByRole("definition").getByText("已设置", { exact: true })).toBeVisible();
    await browserExpect(page.getByText("secret-token")).toHaveCount(0);
    const address = await page.getByRole("textbox", { name: "Webhook 地址" }).inputValue();
    expect(address.startsWith(`${app.origin}/api/v1/git-hooks/`)).toBe(true);

    await syncNow(page);
    expect(repo.read("docs/guide.md")).toBe("第一段。\n");
    await browserExpect(page.getByText(/上次检查/u)).toBeVisible();
    await browserExpect(page.getByRole("definition").locator("code")).toHaveText(repo.latest!.slice(0, 7));
    await browserExpect(page.getByRole("row", { name: /1 个页面/u })).toBeVisible();

    // What it could not take is said, next to what it did.
    repo.commit({ "docs/bad name.md": "有空格\n", "docs/guide.md": "第二段。\n" }, "Change the guide", "Grace");
    await syncNow(page);
    await browserExpect(page.getByText("docs/bad name.md: 这个名字不能作为页面地址")).toBeVisible();

    // And a failure says what it was, and clears once it works again.
    repo.failure = new Error("could not reach the host");
    await syncNow(page);
    await browserExpect(page.getByText("同步失败").first()).toBeVisible();
    await browserExpect(page.getByText("could not reach the host").first()).toBeVisible();
    repo.failure = null;
    await syncNow(page);
    await browserExpect(page.getByText(/上次检查/u)).toBeVisible();

    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
    const editing = page.getByRole("dialog");
    await browserExpect(editing.getByRole("combobox", { name: "页面和文件地址相同时" })).toHaveCount(0);
    await browserExpect(editing.getByLabel("访问令牌")).toHaveAttribute("placeholder", /已设置/u);
    await editing.getByRole("button", { name: "取消", exact: true }).click();

    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "断开", exact: true }).click();
    await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "断开", exact: true }).click();
    await browserExpect(page.getByText("还没有连接仓库")).toBeVisible();
  });

  it("shows where a version came from in a page's history", async () => {
    const page = await app.open("admin", `/${SPACE}/guide`);
    await browserExpect(page.getByText("第二段。")).toBeVisible();
    const { data: found } = await app.api("admin", "GET", `spaces/${SPACE}/resolve?path=guide`);
    const { data: revisions } = await app.api("admin", "GET", `documents/${found.id as string}/revisions`);
    expect(revisions[0]).toMatchObject({ channel: "git", message: "Change the guide" });
    expect(revisions[0].actorName).toContain("Grace");
  });
});
