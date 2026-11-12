import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { listen } from "../../packages/server/src/listen.js";
import { startServer, type TestServer } from "../../packages/server/test/support.js";
import { choose, launchBrowser, pandocsDescribe } from "./fixture.js";

const postgres = usePostgresFixture();
const ROOT = resolve(import.meta.dirname, "../..");
const PASSWORD = "the-first-password";

/** Someone who has just started the server, with nothing set up, on the real thing. */
pandocsDescribe("the first time anyone uses a site", () => {
  let server: TestServer;
  let http: ReturnType<typeof listen>;
  let origin = "";
  let browser: Browser;
  let admin: Page;
  const problems: string[] = [];

  const open = async (path: string, viewport = { width: 1440, height: 900 }): Promise<Page> => {
    const context = await browser.newContext({ viewport, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("pageerror", error => problems.push(error.message));
    page.on("console", message => {
      // Firefox also notes every stream a page still had open when it is left.
      if (message.type() === "error" && !message.text().includes("favicon") && !message.text().includes("404") && !message.text().includes("410") && !message.text().includes("401") && !message.text().includes("was interrupted while the page was loading")) problems.push(message.text());
    });
    await page.goto(`${origin}${path}`);
    return page;
  };

  beforeAll(async () => {
    execFileSync("pnpm", ["--filter", "@pandocs/web", "build"], { cwd: ROOT, stdio: "ignore" });
    server = await startServer(postgres.getConnectionString(), { PANDOCS_WEB_DIR: join(ROOT, "packages/web/dist") });
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port: 0 }, info => {
        origin = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
    // As the server itself does, so that editing is live here too.
    http.on("upgrade", server.runtime.live.handleUpgrade);
    browser = await launchBrowser();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    http?.closeAllConnections();
    if (http) await new Promise(done => http.close(done));
    await server?.close();
    expect(problems).toEqual([]);
  });

  it("goes from an empty site to writing a first page without looking for anything", async () => {
    admin = await open("/");
    await browserExpect(admin.getByRole("heading", { name: "创建管理员账号" })).toBeVisible({ timeout: 15_000 });
    await admin.getByLabel("名字").fill("站长");
    await admin.getByLabel("邮箱").fill("first@example.test");
    await admin.getByLabel("密码").fill(PASSWORD);
    await admin.getByRole("button", { name: "创建并登录" }).click();

    // The home page says what comes next.
    await browserExpect(admin.getByText("还没有空间")).toBeVisible({ timeout: 15_000 });
    await browserExpect(admin.getByRole("link", { name: "导入示例文档" })).toBeVisible();
    await admin.getByRole("link", { name: "新建空间" }).click();
    const spaceDialog = admin.getByRole("dialog");
    await browserExpect(spaceDialog).toBeVisible({ timeout: 15_000 });
    // An English name fills in the address, and it can still be changed.
    await spaceDialog.getByLabel("名称").fill("Team Handbook");
    await browserExpect(spaceDialog.getByLabel("地址")).toHaveValue("team-handbook");
    await spaceDialog.getByRole("button", { name: "新建", exact: true }).click();

    // A space is for pages, so the next thing is a page.
    const pageDialog = admin.getByRole("dialog");
    await browserExpect(pageDialog.getByRole("heading", { name: "新建页面" })).toBeVisible({ timeout: 15_000 });
    await pageDialog.getByLabel("标题").fill("Getting started");
    await pageDialog.getByRole("button", { name: "新建", exact: true }).click();

    await browserExpect(admin.locator(".ProseMirror")).toBeVisible({ timeout: 20_000 });
    await browserExpect(admin).toHaveURL(/\/team-handbook\/getting-started\?mode=edit$/u);
    await admin.locator(".ProseMirror").click();
    await admin.keyboard.type("The first paragraph.");
    await admin.getByRole("button", { name: "保存", exact: true }).click();
    await browserExpect(admin.locator(".ProseMirror")).toHaveCount(0, { timeout: 15_000 });
    await browserExpect(admin.getByText("The first paragraph.")).toBeVisible();
  }, 120_000);

  it("shows the home background the way the theme draws it, with no edge across it", async () => {
    await admin.goto(`${origin}/team-handbook/`);
    await browserExpect(admin.locator(".rp-home-background")).toBeAttached({ timeout: 15_000 });
    // A background on the root element stops the body's from reaching the canvas, and the body then paints over the gradient.
    expect(await admin.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect(await admin.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
  });

  it("opens the new page dialog from the front page of an empty space, and says what an empty page is for", async () => {
    await admin.evaluate(async () => {
      await fetch("/api/v1/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "empty", name: "空的", defaultRole: "viewer" }) });
    });
    await admin.goto(`${origin}/empty/`);
    await admin.getByRole("link", { name: "新建文档" }).click();
    const dialog = admin.getByRole("dialog");
    await browserExpect(dialog.getByRole("heading", { name: "新建页面" })).toBeVisible({ timeout: 15_000 });
    await browserExpect(admin).not.toHaveURL(/new=1/u);
    await dialog.getByRole("button", { name: "取消" }).click();

    await admin.evaluate(async () => {
      await fetch("/api/v1/spaces/team-handbook/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Blank", slug: "blank", markdown: "" }) });
    });
    await admin.goto(`${origin}/team-handbook/blank`);
    await browserExpect(admin.getByText("这个页面还是空的")).toBeVisible({ timeout: 15_000 });
    await admin.locator(".pd-blank-page").getByRole("link", { name: "开始写" }).click();
    await browserExpect(admin.locator(".ProseMirror")).toBeVisible({ timeout: 20_000 });
    await admin.getByRole("button", { name: "退出编辑" }).click();
  }, 60_000);

  it("gets a new person in with a link, with no mail set up", async () => {
    await admin.goto(`${origin}/_/users`);
    await admin.getByRole("button", { name: "添加用户" }).click();
    const dialog = admin.getByRole("dialog");
    await dialog.getByLabel("名字").fill("Bob");
    await dialog.getByLabel("邮箱").fill("bob@example.test");
    await dialog.getByRole("button", { name: "添加", exact: true }).click();

    const linkDialog = admin.getByRole("dialog");
    await browserExpect(linkDialog.getByRole("heading", { name: "把这个链接发给 Bob" })).toBeVisible({ timeout: 15_000 });
    const link = (await linkDialog.locator(".pd-token").textContent())!;
    expect(link).toContain("/set-password/");
    await linkDialog.getByRole("button", { name: "完成" }).click();
    await browserExpect(admin.getByText("还没有设置密码")).toBeVisible();

    const bob = await open(new URL(link).pathname);
    await browserExpect(bob.getByText("bob@example.test")).toBeVisible({ timeout: 15_000 });
    await bob.getByLabel("密码（至少 8 位）").fill("bobs-own-password");
    await bob.getByRole("button", { name: "保存并登录" }).click();
    await browserExpect(bob.getByRole("button", { name: "Bob 的账号菜单" })).toBeVisible({ timeout: 15_000 });
    // Used up.
    const again = await open(new URL(link).pathname);
    await browserExpect(again.getByRole("heading", { name: "这个链接已经失效" })).toBeVisible({ timeout: 15_000 });

    const forgot = await open("/login");
    await forgot.getByRole("link", { name: "忘记密码？" }).click();
    await browserExpect(forgot.getByText("请联系站点管理员")).toBeVisible({ timeout: 15_000 });
    await forgot.getByRole("link", { name: "返回登录" }).click();
    await browserExpect(forgot.getByRole("button", { name: "登录" })).toBeVisible();
  }, 90_000);

  it("shows how to connect an agent, for this site", async () => {
    await admin.goto(`${origin}/_/account`);
    const settings = admin.getByLabel("MCP 客户端配置");
    await browserExpect(settings).toContainText(`${origin}/mcp`, { timeout: 15_000 });
    await admin.getByRole("button", { name: "新建令牌" }).click();
    const dialog = admin.getByRole("dialog");
    await dialog.getByLabel("名称").fill("my agent");
    await choose(dialog.getByRole("combobox", { name: "权限" }), "智能体（只能读取、评论和提修改建议）");
    await dialog.getByRole("button", { name: "新建", exact: true }).click();
    const made = admin.getByRole("dialog");
    await browserExpect(made.getByLabel("MCP 客户端配置")).toContainText("Bearer pd_", { timeout: 15_000 });
    await made.getByRole("button", { name: "完成" }).click();
  });

  it("offers no AI on a site with no model, and shows what is waiting for someone", async () => {
    const id = await admin.evaluate(async () => {
      const made = await fetch("/api/v1/spaces/team-handbook/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Reviewed", slug: "reviewed", markdown: "Words to change.\n" }) });
      const { data } = await made.json() as { data: { document: { id: string } } };
      await fetch(`/api/v1/documents/${data.document.id}/proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 1, ops: [{ op: "str_replace", pattern: "change", content: "keep" }] }) });
      return data.document.id;
    });
    expect(id).toBeTruthy();
    await admin.goto(`${origin}/team-handbook/reviewed`);
    await admin.getByText("Words to change.").selectText();
    const toolbar = admin.getByRole("toolbar", { name: "选中文字的操作" });
    await browserExpect(toolbar.getByRole("button", { name: "评论", exact: true })).toBeVisible({ timeout: 15_000 });
    await browserExpect(toolbar.getByRole("button", { name: "AI" })).toHaveCount(0);
    await admin.keyboard.press("Escape");
    await admin.mouse.click(5, 500);
    await admin.getByRole("button", { name: "修改建议 1" }).click();
    await browserExpect(admin.getByRole("tab", { name: /修改建议/u })).toHaveAttribute("aria-selected", "true");
    await browserExpect(admin.locator(".pd-proposal-card")).toBeVisible();
  }, 60_000);

  it("fits the editor's toolbar on a phone", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
    await context.addCookies((await admin.context().cookies()).map(({ name, value }) => ({ name, value, url: origin })));
    const phone = await context.newPage();
    await phone.goto(`${origin}/team-handbook/getting-started?mode=edit`);
    const save = phone.getByRole("button", { name: "保存", exact: true });
    await browserExpect(save).toBeVisible({ timeout: 20_000 });
    expect((await save.boundingBox())!.x + (await save.boundingBox())!.width).toBeLessThanOrEqual(390);
    const status = await phone.locator(".pd-editor__status").boundingBox();
    expect(status!.height).toBeLessThan(30);
    await context.close();
  }, 60_000);
});
