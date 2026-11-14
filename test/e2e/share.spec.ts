import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { listen } from "../../packages/server/src/listen.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "../../packages/server/test/support.js";
import { canReadClipboard, launchBrowser, pandocsDescribe } from "./fixture.js";

const postgres = usePostgresFixture();
const ROOT = resolve(import.meta.dirname, "../..");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

/** A browser with no cookies and a link someone sent it, on the real server, on a site with nothing public. */
pandocsDescribe("reading through a share link", () => {
  let server: TestServer;
  let admin: Client;
  let http: ReturnType<typeof listen>;
  let origin = "";
  let browser: Browser;
  let guide = "";
  const problems: string[] = [];
  const refused: string[] = [];

  const open = async (path: string): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("pageerror", error => problems.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && !message.text().includes("favicon") && !message.text().includes("404"))
        problems.push(message.text());
    });
    // A page that keeps asking for what its visitor cannot have is broken, even if nothing shows it.
    page.on("response", response => {
      if (response.url().includes("/api/") && response.status() >= 400)
        refused.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    await page.goto(`${origin}${path}`);
    return page;
  };
  const shareGuide = async (body: object = {}) =>
    (await admin.json("POST", `/api/v1/documents/${guide}/share-links`, body)).data as { id: string; path: string };

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
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "书店", defaultRole: "none" });
    const upload = await admin.request("/api/v1/spaces/shop/assets?filename=a.png", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    });
    const image = ((await upload.json()) as { data: { path: string } }).data.path;
    guide = (
      await admin.json("POST", "/api/v1/spaces/shop/documents", {
        title: "退货流程",
        slug: "returns",
        markdown: `七天内可以退货。\n\n![示意图](${image})\n\n## 怎么退\n\n联系客服。\n`
      })
    ).data.document.id;
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "退款",
      slug: "refund",
      parentPath: "returns",
      markdown: "三天到账。\n"
    });
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "进货价",
      slug: "cost",
      markdown: "保密内容\n"
    });
    browser = await launchBrowser();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    if (http) await new Promise(done => http.close(done));
    await server?.close();
  });

  it("opens straight on the page, with its images and outline, and asks for nothing it cannot have", async () => {
    const page = await open((await shareGuide()).path);
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toMatch(/^\/s\/pds_[\w-]+\/shop\/returns$/u);
    const image = page.getByRole("img", { name: "示意图" });
    await browserExpect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await browserExpect(page.locator(".rp-outline, .rp-doc-layout__outline").getByText("怎么退").first()).toBeVisible();
    await page.locator("html[data-live]").waitFor({ state: "attached" });
    expect(problems).toEqual([]);
    expect(refused).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("has nothing around it that leads elsewhere, or that only someone signed in can use", async () => {
    const page = await open((await shareGuide()).path);
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    await browserExpect(page.locator(".rp-nav")).toBeHidden();
    await browserExpect(page.getByText("进货价")).toHaveCount(0);
    await browserExpect(page.getByText("退款")).toHaveCount(0);
    for (const name of ["评论", "编辑", "历史版本", "关注", "分享", "搜索"])
      await browserExpect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await browserExpect(page.getByText("这篇文档有帮助吗")).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute("content"))).toBe(
      "noindex"
    );
    await page.context().close();
  }, 60_000);

  it.skipIf(!canReadClipboard)(
    "can copy the page as Markdown",
    async () => {
      const page = await open((await shareGuide()).path);
      await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.locator(".rp-llms-copy-button, .rp-llms-button").first().click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
        .toContain("七天内可以退货");
      await page.context().close();
    },
    60_000
  );

  it("gets a sidebar when it covers subpages, and can go between them", async () => {
    const page = await open((await shareGuide({ includeChildren: true })).path);
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("link", { name: "退款" }).first().click();
    await browserExpect(page.getByText("三天到账")).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(/^\/s\/pds_[\w-]+\/shop\/returns\/refund$/u);
    await browserExpect(page.getByText("进货价")).toHaveCount(0);
    await page.reload();
    await browserExpect(page.getByText("三天到账")).toBeVisible({ timeout: 20_000 });
    await page.context().close();
  }, 60_000);

  it("is not found at another page's address in the same space", async () => {
    const { path } = await shareGuide();
    const page = await open(`${path}/shop/cost`);
    await browserExpect(page.getByText("进货价")).toHaveCount(0);
    await browserExpect(page.getByText("保密内容")).toHaveCount(0);
    await page.context().close();
  }, 60_000);

  it("says plainly that a revoked link no longer works", async () => {
    const link = await shareGuide();
    const page = await open(link.path);
    await browserExpect(page.getByText("七天内可以退货")).toBeVisible({ timeout: 20_000 });
    await admin.json("DELETE", `/api/v1/share-links/${link.id}`);
    await page.reload();
    await browserExpect(page.getByText("这个链接已经失效")).toBeVisible();
    await browserExpect(page.getByText("七天内可以退货")).toHaveCount(0);
    await page.context().close();
  }, 60_000);
});
