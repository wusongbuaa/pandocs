import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { expect as browserExpect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { createChangeListener } from "../../packages/server/src/change-listener.js";
import { listen } from "../../packages/server/src/listen.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "../../packages/server/test/support.js";
import { launchBrowser, pandocsDescribe } from "./fixture.js";

const postgres = usePostgresFixture();
const ROOT = resolve(import.meta.dirname, "../..");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** The real server and a host page on another origin, the way another system would use this. */
pandocsDescribe("a page embedded in another system", () => {
  let server: TestServer;
  let admin: Client;
  let http: ReturnType<typeof listen>;
  let origin = "";
  let host: Server;
  let hostOrigin = "";
  let otherHost: Server;
  let otherOrigin = "";
  let browser: Browser;
  let stopListener = () => undefined as void;
  let secret = "";
  const tokenRequests: number[] = [];
  let ttlSeconds = 3600;
  const problems: string[] = [];

  /** What the other system's server does. The secret never reaches its web page. */
  const issueToken = async () => {
    tokenRequests.push(Date.now());
    const response = await fetch(`${origin}/api/v1/embed/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ user: { id: "visitor-1", displayName: "外部同事" }, ttlSeconds })
    });
    return ((await response.json()) as { data: { token: string } }).data.token;
  };

  const hostPage = (attributes: string) => `<!doctype html><meta charset="utf-8"><title>对方系统</title><h1 id="host-title">对方系统的页面</h1>
<pandocs-doc id="doc" server="${origin}" app="helpdesk" ${attributes} style="height:700px"></pandocs-doc>
<script type="module">
  import "${origin}/embed.js";
  const doc = document.getElementById("doc");
  window.navigated = [];
  doc.addEventListener("pandocs-navigate", event => window.navigated.push(event.detail.path));
  doc.addEventListener("pandocs-ready", () => { window.ready = true; });
  doc.getToken = async () => (await fetch("/token")).text();
</script>`;

  const serveHost = (attributes: () => string) => createServer((request, response) => {
    if (request.url === "/token") {
      void issueToken().then(token => response.writeHead(200, { "content-type": "text/plain" }).end(token));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(hostPage(attributes()));
  });

  let attributes = 'space="shared" path="guide"';
  const openHost = async (address: string): Promise<{ page: Page; frame: FrameLocator }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("console", message => {
      if (message.type() === "error" && !message.text().includes("favicon")) problems.push(message.text());
    });
    page.on("pageerror", error => problems.push(error.message));
    await page.goto(address);
    return { page, frame: page.frameLocator("pandocs-doc iframe") };
  };

  /** With a real mouse, so at a position on the page around the frame. */
  const selectWordsInFrame = async (page: Page, words: string) => {
    const inner = page.frames().find(item => item.url().includes("/embed/"))!;
    const offset = (await page.locator("pandocs-doc iframe").boundingBox())!;
    const box = await inner.evaluate(wanted => {
      const walker = document.createTreeWalker(document.querySelector("[data-pandocs-body]")!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.nodeValue!.indexOf(wanted);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
      }
      return null;
    }, words);
    if (!box) throw new Error(`页面上没有这段文字：${words}`);
    await page.mouse.move(offset.x + box.left + 1, offset.y + box.y);
    await page.mouse.down();
    await page.mouse.move(offset.x + box.right - 1, offset.y + box.y, { steps: 8 });
    await page.mouse.up();
  };

  beforeAll(async () => {
    execFileSync("pnpm", ["--filter", "@pandocs/web", "build"], { cwd: ROOT, stdio: "ignore" });
    execFileSync("pnpm", ["--filter", "@pandocs/embed", "build"], { cwd: ROOT, stdio: "ignore" });
    server = await startServer(postgres.getConnectionString(), { PANDOCS_WEB_DIR: join(ROOT, "packages/web/dist") });
    admin = await signInFirstAdmin(server);
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port: 0 }, info => {
        origin = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
    stopListener = createChangeListener(postgres.getConnectionString(), server.runtime.events.wake, { fallbackMs: 3_600_000 }).stop;
    host = serveHost(() => attributes);
    await new Promise<void>(done => host.listen(0, "localhost", done));
    hostOrigin = `http://localhost:${(host.address() as AddressInfo).port}`;
    otherHost = serveHost(() => attributes);
    await new Promise<void>(done => otherHost.listen(0, "localhost", done));
    otherOrigin = `http://localhost:${(otherHost.address() as AddressInfo).port}`;

    secret = (await admin.json("POST", "/api/v1/admin/embed-apps", { slug: "helpdesk", name: "服务台", allowedOrigins: [hostOrigin] })).data.secret;
    await admin.json("POST", "/api/v1/spaces", { slug: "shared", name: "给外部看的", defaultRole: "none" });
    await admin.json("PUT", "/api/v1/spaces/shared/members", { subject: "group:embed:helpdesk", role: "commenter" });
    const upload = await admin.request("/api/v1/spaces/shared/assets?filename=a.png", { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    const image = ((await upload.json()) as { data: { path: string } }).data.path;
    await admin.json("POST", "/api/v1/spaces/shared/documents", { title: "说明", slug: "guide", markdown: `# 说明\n\n第一段普通说明。\n\n![示意图](${image})\n\n[另一页](./other)\n` });
    await admin.json("POST", "/api/v1/spaces/shared/documents", { title: "另一页", slug: "other", markdown: "# 另一页\n\n另一页的内容。\n" });

    browser = await launchBrowser();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    stopListener();
    server?.runtime.events.stop();
    await Promise.all([host, otherHost].map(item => item && new Promise(done => item.close(done))));
    if (http) await new Promise(done => http.close(done));
    await server?.close();
  });

  it("shows the same page as the site, without the site around it, and images load", async () => {
    const { page, frame } = await openHost(hostOrigin);
    await browserExpect(frame.getByText("第一段普通说明")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { ready?: boolean }).ready)).toBe(true);
    await browserExpect(page.locator("#host-title")).toBeVisible();
    await browserExpect(frame.locator(".rp-nav")).toHaveCount(0);
    await browserExpect(frame.locator(".rp-doc-layout__sidebar, .rp-sidebar")).toHaveCount(0);
    const image = frame.getByRole("img", { name: "示意图" });
    await browserExpect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    // The token never appears anywhere a script on the host, or a log, could pick it up from the address.
    expect(await page.locator("pandocs-doc").evaluate(element => element.shadowRoot!.querySelector("iframe")!.src)).not.toContain("pdg_");
    await page.close();
  }, 60_000);

  it("lets a visitor comment like anyone on the site, under the name their system gave", async () => {
    const { page, frame } = await openHost(hostOrigin);
    await browserExpect(frame.getByText("第一段普通说明")).toBeVisible({ timeout: 20_000 });
    await selectWordsInFrame(page, "第一段普通");
    await frame.getByRole("toolbar", { name: "选中文字的操作" }).getByRole("button", { name: "评论", exact: true }).click();
    await frame.getByPlaceholder(/写下评论/u).fill("外部同事的看法");
    await frame.locator(".pd-panel").getByRole("button", { name: "发送", exact: true }).click();
    await browserExpect(frame.locator(".pd-card").getByText("外部同事的看法")).toBeVisible();

    const { id } = (await admin.json("GET", "/api/v1/spaces/shared/resolve?path=guide")).data;
    const threadsNow = async () => (await admin.json("GET", `/api/v1/documents/${id}/threads`)).data as { id: string; comments: object[] }[];
    await expect.poll(async () => (await threadsNow()).length).toBeGreaterThan(0);
    const threads = await threadsNow();
    expect(threads.at(-1)!.comments[0]).toMatchObject({ body: "外部同事的看法", authorName: "外部同事", channel: "embed" });

    // And the visitor hears about a reply from the site right away, with nothing reloading.
    await admin.json("POST", `/api/v1/threads/${threads.at(-1)!.id}/comments`, { body: "站内同事的回复" });
    await browserExpect(frame.locator(".pd-card").getByText("站内同事的回复")).toBeVisible({ timeout: 8000 });
    await page.close();
  }, 60_000);

  it("offers no edit to someone only allowed to comment", async () => {
    const { page, frame } = await openHost(hostOrigin);
    await browserExpect(frame.getByText("第一段普通说明")).toBeVisible({ timeout: 20_000 });
    await browserExpect(frame.getByRole("link", { name: "建议修改" })).toBeVisible();
    await browserExpect(frame.getByRole("link", { name: "编辑", exact: true })).toHaveCount(0);
    await page.close();
  }, 60_000);

  it("tells the page around it where it went, and goes where that page says", async () => {
    const { page, frame } = await openHost(hostOrigin);
    await browserExpect(frame.getByText("第一段普通说明")).toBeVisible({ timeout: 20_000 });
    await frame.getByRole("link", { name: "另一页", exact: true }).click();
    await browserExpect(frame.getByText("另一页的内容")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { navigated: string[] }).navigated.at(-1))).toBe("/shared/other");

    await page.locator("pandocs-doc").evaluate(element => element.setAttribute("path", "guide"));
    await browserExpect(frame.getByText("第一段普通说明")).toBeVisible({ timeout: 10_000 });
    await page.close();
  }, 60_000);

  it("asks for a new token before the old one runs out, and keeps working", async () => {
    ttlSeconds = 61;
    tokenRequests.length = 0;
    const { page, frame } = await openHost(hostOrigin);
    await browserExpect(frame.getByText("第一段普通说明")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => tokenRequests.length, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
    ttlSeconds = 3600;
    await frame.getByRole("link", { name: "另一页", exact: true }).click();
    await browserExpect(frame.getByText("另一页的内容")).toBeVisible({ timeout: 10_000 });
    await page.close();
  }, 60_000);

  it("cannot be framed by a site that is not on the list", async () => {
    const { page, frame } = await openHost(otherOrigin);
    tokenRequests.length = 0;
    await page.waitForTimeout(2000);
    await browserExpect(frame.getByText("第一段普通说明")).toHaveCount(0);
    // The browser refused to load it, so it never got as far as asking who this is.
    expect(tokenRequests).toEqual([]);
    // That refusal is reported as an error on the page, as it should be, and it is the only one expected.
    problems.splice(0, problems.length, ...problems.filter(problem => !problem.includes("frame-ancestors")));
    await page.close();
  }, 60_000);

  it("uses the language the page around it asks for, whatever the browser's", async () => {
    attributes = 'space="shared" path="guide" lang="en"';
    try {
      const { page, frame } = await openHost(hostOrigin);
      await browserExpect(frame.getByRole("link", { name: "History" })).toBeVisible({ timeout: 20_000 });
      await page.close();
    } finally {
      attributes = 'space="shared" path="guide"';
    }
  }, 60_000);

  it("says what is wrong when opened directly, rather than hanging", async () => {
    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    await page.goto(`${origin}/embed/helpdesk/shared/guide`);
    await browserExpect(page.getByText("文档暂时打不开")).toBeVisible({ timeout: 15_000 });
    await context.close();
  }, 60_000);

  it("had no errors on the pages around it or inside it", () => {
    expect(problems).toEqual([]);
  });
});
