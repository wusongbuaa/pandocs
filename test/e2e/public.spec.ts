import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { listen } from "../../packages/server/src/listen.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "../../packages/server/test/support.js";
import { launchBrowser, pandocsDescribe } from "./fixture.js";

const postgres = usePostgresFixture();
const ROOT = resolve(import.meta.dirname, "../..");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

/** A browser with no cookies, on the real server. */
pandocsDescribe("reading a public space with no login", () => {
  let server: TestServer;
  let admin: Client;
  let http: ReturnType<typeof listen>;
  let origin = "";
  let browser: Browser;
  const problems: string[] = [];
  const refused: string[] = [];

  const open = async (path: string): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("pageerror", error => problems.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && !message.text().includes("favicon") && !message.text().includes("401"))
        problems.push(message.text());
    });
    // A page that keeps asking for what a visitor cannot have is broken, even if nothing shows it.
    page.on("response", response => {
      if (response.url().includes("/api/") && response.status() >= 400)
        refused.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    await page.goto(`${origin}${path}`);
    return page;
  };

  beforeAll(async () => {
    execFileSync("pnpm", ["--filter", "@pandocs/web", "build"], { cwd: ROOT, stdio: "ignore" });
    server = await startServer(postgres.getConnectionString(), { PANDOCS_WEB_DIR: join(ROOT, "packages/web/dist") });
    admin = await signInFirstAdmin(server);
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port: 0 }, info => {
        origin = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
    // Someone who signs in to edit gets the shared draft, as on the real server.
    http.on("upgrade", server.runtime.live.handleUpgrade);
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "书店", defaultRole: "none" });
    await admin.json("POST", "/api/v1/spaces", { slug: "inside", name: "内部", defaultRole: "none" });
    const upload = await admin.request("/api/v1/spaces/shop/assets?filename=a.png", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    });
    const image = ((await upload.json()) as { data: { path: string } }).data.path;
    const { id } = (
      await admin.json("POST", "/api/v1/spaces/shop/documents", {
        title: "退货流程",
        slug: "returns",
        markdown: `# 退货流程\n\n七天内可以退货。\n\n![示意图](${image})\n\n## 怎么退\n\n到店办理。\n`
      })
    ).data.document;
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "进货价",
      slug: "cost",
      markdown: "保密内容\n",
      restricted: true
    });
    await admin.json("POST", "/api/v1/spaces/inside/documents", {
      title: "内部",
      slug: "note",
      markdown: "只给同事看\n"
    });
    await admin.json("POST", `/api/v1/documents/${id}/threads`, {
      anchor: { kind: "quote", quote: "七天" },
      body: "内部讨论的内容"
    });
    await admin.json("PATCH", "/api/v1/spaces/shop", { publicRead: true });
    browser = await launchBrowser();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    if (http) await new Promise(done => http.close(done));
    await server?.close();
  });

  it("reads the page as anyone would, with its images and outline", async () => {
    const page = await open("/shop/returns");
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    const image = page.getByRole("img", { name: "示意图" });
    await browserExpect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await browserExpect(page.locator(".rp-outline, .rp-doc-layout__outline").getByText("怎么退").first()).toBeVisible();
    await page.context().close();
  }, 60_000);

  it("shows a visitor what signing in offers, and asks them to sign in for it over the page", async () => {
    const page = await open("/shop/returns");
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    await browserExpect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
    for (const name of ["评论", "编辑", "历史", "关注"])
      await browserExpect(page.getByRole("button", { name, exact: true })).toBeVisible();
    // Only the ways in: nothing of the discussion itself, and nothing only editors get.
    await browserExpect(page.getByRole("button", { name: "分享" })).toHaveCount(0);
    await browserExpect(page.getByText("内部讨论的内容")).toHaveCount(0);
    await page.getByRole("button", { name: "此页更多操作" }).click();
    await browserExpect(page.getByRole("menuitem", { name: "演示" })).toBeVisible();
    await page.keyboard.press("Escape");
    await browserExpect(page.getByRole("menu")).toHaveCount(0);

    const dialog = page.getByRole("dialog", { name: "登录" });
    await page.getByRole("button", { name: "历史", exact: true }).click();
    await browserExpect(dialog.getByText("登录后可以查看这一页的历史版本。")).toBeVisible();
    await browserExpect(dialog.getByLabel("邮箱", { exact: true })).toBeVisible();
    await browserExpect(dialog.getByRole("link", { name: "忘记密码？" })).toHaveAttribute("href", "/forgot-password");
    await page.keyboard.press("Escape");
    await browserExpect(dialog).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/shop/returns");
    await page.getByRole("button", { name: "登录后发表评论" }).click();
    await browserExpect(dialog.getByText("登录后可以评论这一页。")).toBeVisible();
    await dialog.getByRole("button", { name: "关闭" }).click();
    await browserExpect(dialog).toHaveCount(0);

    const box = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector("[data-pandocs-body]")!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.nodeValue!.indexOf("七天内");
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 3);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
      }
      return null;
    });
    await page.mouse.move(box!.left + 1, box!.y);
    await page.mouse.down();
    await page.mouse.move(box!.right - 1, box!.y, { steps: 5 });
    await page.mouse.up();
    const toolbar = page.getByRole("toolbar", { name: "选中文字的操作" });
    await browserExpect(toolbar).toBeVisible();
    for (const name of ["建议修改", "智能辅助"])
      await browserExpect(toolbar.getByRole("button", { name, exact: true })).toHaveCount(0);
    await toolbar.getByRole("button", { name: "评论", exact: true }).click();
    await browserExpect(dialog.getByText("登录后可以评论选中的文字。")).toBeVisible();
    await page.context().close();
  }, 60_000);

  it("signs in without leaving the page, and says what went wrong in place", async () => {
    const page = await open("/shop/returns");
    await page.getByRole("link", { name: "登录", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登录" });
    await dialog.getByLabel("邮箱", { exact: true }).fill("admin@example.test");
    await dialog.getByLabel("密码", { exact: true }).fill("not the password");
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await browserExpect(dialog.getByRole("alert")).toHaveText("邮箱或密码不对");
    await dialog.getByLabel("密码", { exact: true }).fill("correct horse battery");
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    // The same page, now for someone with a name, who can see the discussion.
    await browserExpect(page.getByRole("button", { name: /^评论 1/u })).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/shop/returns");
    await page.context().close();
  }, 60_000);

  it("goes on to what they asked for once they have signed in", async () => {
    const page = await open("/shop/returns");
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登录" });
    await browserExpect(dialog.getByText("登录后可以编辑这一页，或提出修改建议。")).toBeVisible();
    await dialog.getByLabel("邮箱", { exact: true }).fill("admin@example.test");
    await dialog.getByLabel("密码", { exact: true }).fill("correct horse battery");
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(/\/shop\/returns\?mode=edit$/u);
    await browserExpect(page.locator(".ProseMirror")).toBeVisible({ timeout: 20_000 });
    await page.context().close();
  }, 60_000);

  it("asks a visitor sent to the editor to sign in, rather than just showing the page", async () => {
    const page = await open("/shop/returns?mode=edit");
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    const notice = page.getByRole("status").filter({ hasText: "登录后可以编辑这一页，或提出修改建议。" });
    await browserExpect(notice).toBeVisible();
    await notice.getByRole("button", { name: "登录", exact: true }).click();
    await browserExpect(page.getByRole("dialog", { name: "登录" }).getByLabel("邮箱", { exact: true })).toBeVisible();
    await page.context().close();
  }, 60_000);

  it("finds public pages, and only those", async () => {
    const page = await open("/shop/returns");
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    await browserExpect(page.getByRole("link", { name: "进货价" })).toHaveCount(0);
    const answer = await page.evaluate(
      async () => (await fetch("/api/v1/search?q=%E9%80%80%E8%B4%A7")).json() as Promise<{ data: { title: string }[] }>
    );
    expect(answer.data.map(hit => hit.title)).toEqual(["退货流程"]);
    const hidden = await page.evaluate(
      async () => (await fetch("/api/v1/search?q=%E4%BF%9D%E5%AF%86")).json() as Promise<{ data: unknown[] }>
    );
    expect(hidden.data).toEqual([]);
    refused.length = 0;
    await page.context().close();
  }, 60_000);

  it("centres the words on its sign-in button", async () => {
    const page = await open("/shop/returns");
    const signIn = page.getByRole("link", { name: "登录" });
    await browserExpect(signIn).toBeVisible({ timeout: 15_000 });
    const offset = await signIn.evaluate(link => {
      const range = document.createRange();
      range.selectNodeContents(link);
      const words = range.getBoundingClientRect();
      const box = link.getBoundingClientRect();
      return (words.top + words.bottom) / 2 - (box.top + box.bottom) / 2;
    });
    expect(Math.abs(offset)).toBeLessThan(1);
    await page.context().close();
  }, 60_000);

  it("shows nothing of a closed page, offers to log in, and goes on to it from there", async () => {
    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/inside/note`);
    expect(response?.status()).toBe(404);
    await browserExpect(page.getByText("如果这个页面需要登录才能看")).toBeVisible();
    await browserExpect(page.getByText("只给同事看")).toHaveCount(0);
    await page.getByRole("link", { name: "登录", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登录" });
    await dialog.getByLabel("邮箱", { exact: true }).fill("admin@example.test");
    await dialog.getByLabel("密码", { exact: true }).fill("correct horse battery");
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await browserExpect(page.getByText("只给同事看")).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/inside/note");
    await context.close();
  }, 60_000);

  it("sends someone to log in for the app's own pages, and the sign-in link still works on its own", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/_/account`);
    await page.waitForURL(/\/login\?next=/u);
    const visitor = await open("/shop/returns");
    await browserExpect(visitor.getByRole("link", { name: "登录", exact: true })).toHaveAttribute(
      "href",
      "/login?next=%2Fshop%2Freturns"
    );
    await visitor.context().close();
    await context.close();
  }, 60_000);

  it("never asked for anything a visitor cannot have, and had no errors", () => {
    expect(refused).toEqual([]);
    expect(problems).toEqual([]);
  });
});
