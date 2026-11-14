import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { listen } from "../../packages/server/src/listen.js";
import {
  ADMIN,
  signInFirstAdmin,
  startServer,
  type Client,
  type TestServer
} from "../../packages/server/test/support.js";
import { launchBrowser, pandocsDescribe } from "./fixture.js";

const postgres = usePostgresFixture();
const ROOT = resolve(import.meta.dirname, "../..");
const MARKDOWN =
  "# Returns\n\nWithin seven days of delivery.\n\n## Refunds\n\nOn the original card.\n\n```ts\nconst days = 7;\n```\n\n$$x^2$$\n\n:::tip\n\nKeep the receipt.\n\n:::\n";

/** Pages as they leave the server, for anything that runs no scripts, and what becomes of them in a browser. */
pandocsDescribe("pages rendered on the server", () => {
  let server: TestServer;
  let admin: Client;
  let http: ReturnType<typeof listen>;
  let origin = "";
  let browser: Browser;

  const open = async (path: string, options: { readonly javaScript?: boolean; readonly locale?: string } = {}) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: options.locale ?? "en-US",
      javaScriptEnabled: options.javaScript ?? true
    });
    const page = await context.newPage();
    const problems: string[] = [];
    const asked: string[] = [];
    page.on("pageerror", error => problems.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && !message.text().includes("favicon") && !message.text().includes("401"))
        problems.push(message.text());
    });
    page.on("request", request => {
      if (request.url().includes("/api/")) asked.push(new URL(request.url()).pathname);
    });
    await page.goto(`${origin}${path}`);
    return { page, problems, asked };
  };

  const live = (page: Page) => page.waitForFunction(() => document.documentElement.dataset.live === "");

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
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "Shop", defaultRole: "none" });
    await admin.json("POST", "/api/v1/spaces", { slug: "inside", name: "Inside", defaultRole: "none" });
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "Returns",
      slug: "returns",
      markdown: MARKDOWN
    });
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "Shipping",
      slug: "shipping",
      markdown: "Shipping takes a week.\n"
    });
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "Rich",
      slug: "rich",
      markdown: [
        "Words before.",
        "```mermaid\nflowchart LR\n  A --> B\n```",
        '```chart title="Sales"\n{"type":"bar","xKey":"Month","data":[{"Month":"January","Sales":5}]}\n```',
        "Words after."
      ].join("\n\n")
    });
    await admin.json("PATCH", "/api/v1/spaces/shop", { publicRead: true });
    browser = await launchBrowser();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    if (http) await new Promise(done => http.close(done));
    await server?.close();
  });

  it("has the whole page in the HTML, with no script of its own to run", async () => {
    const response = await fetch(`${origin}/shop/returns`, { headers: { "accept-language": "en" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Returns - Pandocs</title>");
    expect(html).toContain("Within seven days of delivery.");
    expect(html).toContain("Keep the receipt.");
    expect(html).toContain('href="/shop/shipping"');
    expect(html).toContain('id="refunds"');
    expect(html).toContain("katex");
    // Highlighted, so the same as what a browser would have rendered.
    expect(html).toMatch(/shiki[^]*const/u);
    // The page's policy allows no inline scripts, so there can be none; this one only holds data.
    expect(html.match(/<script(?![^>]*\b(?:src=|type="application\/json"))[^>]*>/gu)).toBeNull();
  });

  it("says what the page is to search engines and link previews", async () => {
    const html = await (await fetch(`${origin}/shop/returns`, { headers: { "accept-language": "en" } })).text();
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<meta name="description" content="Within seven days of delivery.">');
    expect(head).toContain('<meta property="og:description" content="Within seven days of delivery.">');
    expect(head).toContain('<meta property="og:title" content="Returns - Pandocs">');
    expect(head).toContain('<link rel="canonical" href="http://pandocs.test/shop/returns">');
    expect(head).toContain('<meta property="og:url" content="http://pandocs.test/shop/returns">');
    expect(head).toContain('<meta property="og:site_name" content="Pandocs">');
    // For an agent that finds its way here: where the rest of it is.
    expect(head).toContain('<link rel="alternate" type="text/markdown" href="http://pandocs.test/shop/returns.md">');
    expect(head).toContain('<link rel="describedby" href="http://pandocs.test/llms.txt">');
    expect(html).toContain("the complete documentation index is available at http://pandocs.test/llms.txt");
    // A view of a page is the same page, as far as anyone indexing it goes.
    const view = await (await fetch(`${origin}/shop/returns?view=slides`)).text();
    expect(view).toContain('<link rel="canonical" href="http://pandocs.test/shop/returns">');
    // There is nothing to say about a page that does not exist.
    const missing = await (await fetch(`${origin}/shop/no-such-page`)).text();
    expect(missing).toContain('<meta name="robots" content="noindex">');
    expect(missing).not.toContain("canonical");
    expect(missing).not.toContain("the complete documentation index");
  });

  it("shows when a page changed in the reader's time, once it knows where they are", async () => {
    const html = await (await fetch(`${origin}/shop/returns`)).text();
    expect(html).toMatch(/<time datetime="[^"]+">\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/time>/iu);
    const { page, problems } = await open("/shop/returns");
    await live(page);
    await browserExpect(page.locator(".rp-last-updated time")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
    expect(problems).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("reads the same with scripts off", async () => {
    const { page } = await open("/shop/returns", { javaScript: false });
    await browserExpect(page.getByText("Within seven days of delivery.")).toBeVisible();
    await browserExpect(page.locator(".rp-nav")).toBeVisible();
    await browserExpect(page.getByRole("link", { name: "Shipping", exact: true })).toBeVisible();
    await page.context().close();
  }, 60_000);

  it("does not move anything on the page when the app takes over", async () => {
    const positions = async (page: Page) =>
      Promise.all(
        ["h1", "#refunds", ".katex-display", ".rp-callout", ".rp-doc-footer", ".rp-outline"].map(async selector => {
          const box = await page.locator(selector).first().boundingBox();
          return [selector, box && Math.round(box.x), box && Math.round(box.y), box && Math.round(box.height)];
        })
      );
    const still = await open("/shop/returns", { javaScript: false });
    const before = await positions(still.page);
    await still.page.context().close();
    const { page } = await open("/shop/returns");
    await live(page);
    await page.waitForTimeout(500);
    expect(await positions(page)).toEqual(before);
    await page.context().close();
  }, 60_000);

  it("renders a page in another language on the server too, with its notice about that", async () => {
    const site = (await admin.json("GET", "/api/v1/site")).data as { defaultLang: string; locales: unknown };
    await admin.json("PATCH", "/api/v1/site", {
      locales: [
        { lang: "en", label: "English" },
        { lang: "zh", label: "中文" }
      ]
    });
    try {
      const context = await browser.newContext({ locale: "zh-CN", javaScriptEnabled: false });
      await context.addCookies([...admin.cookies].map(([name, value]) => ({ name, value, url: origin })));
      const page = await context.newPage();
      await page.goto(`${origin}/zh/shop/returns`);
      await browserExpect(page.getByText("Within seven days of delivery.")).toBeVisible();
      await browserExpect(page.getByLabel("翻译状态")).toContainText("中文");
      await browserExpect(page.getByRole("link", { name: "手动翻译" })).toHaveAttribute(
        "href",
        "/zh/shop/returns?mode=edit"
      );
      await context.close();
    } finally {
      await admin.json("PATCH", "/api/v1/site", { locales: site.locales });
    }
  }, 60_000);

  it("makes itself heard if a page does not match what the server rendered, and carries on", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", message => {
      if (message.type() === "error") problems.push(message.text());
    });
    await page.route("**/shop/returns", async route => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace("Within seven days of delivery.</p>", "Something else altogether.</p>")
      });
    });
    await page.goto(`${origin}/shop/returns`);
    await browserExpect(page.getByText("Within seven days of delivery.")).toBeVisible({ timeout: 15_000 });
    expect(problems.join()).toContain("did not match what the server rendered");
    await context.close();
  }, 60_000);

  it("keeps what someone wrote in a title or a description from reading as anything else", async () => {
    const hostile = "<img src=x onerror=alert(1)></title><script>alert(2)</script>\"'><!--";
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: hostile,
      slug: "hostile",
      markdown: `${hostile}\n\nA line.\n`
    });
    // A visitor's list of pages is shared for a few seconds.
    await expect
      .poll(async () => (await fetch(`${origin}/shop/hostile`)).status, { timeout: 15_000, interval: 500 })
      .toBe(200);
    // As a browser reads the HTML, before anything of the app runs.
    const still = await open("/shop/hostile", { javaScript: false });
    expect(await still.page.title()).toContain("<img src=x");
    expect(await still.page.locator('img[src="x"]').count()).toBe(0);
    expect(await still.page.locator('script:not([type="application/json"]):has-text("alert(2)")').count()).toBe(0);
    expect(await still.page.locator("meta[name=description]").getAttribute("content")).toContain("alert(2)");
    await still.page.context().close();
    const { page, problems } = await open("/shop/hostile");
    await live(page);
    expect(await page.title()).toContain("<img src=x");
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(problems).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("says nothing of who wrote a page to a stranger, anywhere in the page", async () => {
    const html = await (await fetch(`${origin}/shop/returns`)).text();
    expect(html).not.toContain(ADMIN.displayName);
    expect(html).toContain('"actorName":""');
  });

  it("links the styles of formulas before the page shows, only where there are some", async () => {
    expect(await (await fetch(`${origin}/shop/returns`)).text()).toMatch(
      /<link rel="stylesheet" crossorigin href="\/assets\/katex-[^"]+\.css">/u
    );
    expect(await (await fetch(`${origin}/shop/shipping`)).text()).not.toContain("katex");
  });

  it("becomes the live app in place, without asking again for what came with it", async () => {
    const { page, problems, asked } = await open("/shop/returns");
    await live(page);
    await browserExpect(page.getByText("Within seven days of delivery.")).toBeVisible();
    expect(problems).toEqual([]);
    expect(asked.filter(path => path === "/api/v1/bootstrap" || /\/documents\/[^/]+$/u.test(path))).toEqual([]);
    // Now a link moves within the app.
    await page.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });
    await page.getByRole("link", { name: "Shipping", exact: true }).click();
    await browserExpect(page.getByText("Shipping takes a week.")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
    expect(problems).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("starts out the way the page was rendered for anyone, in dark mode too", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      colorScheme: "dark"
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", error => problems.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") problems.push(message.text());
    });
    await page.goto(`${origin}/shop/returns`);
    await live(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    expect(problems).toEqual([]);
    await context.close();
  }, 60_000);

  it("leaves what needs a page around it for the browser, and shows it there", async () => {
    const html = await (await fetch(`${origin}/shop/rich`)).text();
    expect(html).toContain("Words after.");
    expect(html).not.toContain("recharts");
    const { page, problems } = await open("/shop/rich");
    await live(page);
    await browserExpect(page.locator(".pd-diagram svg")).toBeVisible({ timeout: 20_000 });
    expect(problems).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("opens the tools on a page in the browser, around the same page from the server", async () => {
    const html = await admin.request("/shop/returns?view=source", { headers: { "accept-language": "en" } });
    const text = await html.text();
    expect(text).toContain("rp-nav");
    expect(text).toContain("Opening…");
    expect(text).not.toContain("Within seven days of delivery.</p>");
    const manage = await (await admin.request("/_/account", { headers: { "accept-language": "en" } })).text();
    expect(manage).toContain("rp-nav");
    expect(manage).toContain("Opening…");
  });

  it("offers its tools to a browser that lets agents use them, on the data it runs on", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    // No browser ships this yet without a flag, so this stands in for it, the way the theme's own hook expects.
    await context.addInitScript(() => {
      const tools: Record<string, { execute(input: unknown, options: object): unknown }> = {};
      Object.assign(document, {
        modelContext: {
          registerTool: (tool: { name: string; execute(input: unknown, options: object): unknown }) => {
            tools[tool.name] = tool;
          }
        }
      });
      Object.assign(window, { webMcpTools: tools });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/shop/returns`);
    await live(page);
    await expect
      .poll(() => page.evaluate(() => Object.keys((window as unknown as { webMcpTools: object }).webMcpTools).sort()))
      .toEqual(
        expect.arrayContaining([
          "get_current_page",
          "get_page",
          "get_site_info",
          "list_pages",
          "navigate",
          "search_docs"
        ])
      );
    const call = (name: string, input: object = {}) =>
      page.evaluate(
        async ([tool, args]) => {
          const answer = await (
            window as unknown as { webMcpTools: Record<string, { execute(input: unknown, options: object): unknown }> }
          ).webMcpTools[tool as string]!.execute(args, {});
          return JSON.stringify(answer);
        },
        [name, input] as const
      );
    const site = await call("get_site_info");
    expect(site).toContain("Pandocs");
    expect(site).toContain("/shop/returns");
    expect(await call("list_pages")).toContain("Shipping");
    expect(await call("get_current_page")).toContain("Within seven days of delivery.");
    expect(await call("get_page", { routePath: "/shop/shipping" })).toContain("Shipping takes a week.");
    await call("navigate", { routePath: "/shop/shipping" });
    await browserExpect(page.getByText("Shipping takes a week.")).toBeVisible();
    await context.close();
  }, 60_000);

  it("answers an address with no page as one, in the theme's own page", async () => {
    const response = await fetch(`${origin}/shop/no-such-page`, { headers: { "accept-language": "en" } });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("rp-not-found");
    const { page, problems, asked } = await open("/shop/no-such-page");
    await live(page);
    expect(problems.filter(problem => !problem.includes("404"))).toEqual([]);
    expect(asked.filter(path => path.endsWith("/resolve"))).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("gives a page one address, and leads the others there", async () => {
    const at = async (path: string) => {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      return [response.status, response.headers.get("location")];
    };
    expect(await at("/shop/returns/")).toEqual([301, "/shop/returns"]);
    expect(await at("/SHOP/Returns.html")).toEqual([301, "/shop/returns"]);
    expect(await at("/shop/returns/?view=source")).toEqual([301, "/shop/returns?view=source"]);
    expect(await at("/shop")).toEqual([301, "/shop/"]);
    expect(await at("/shop/")).toEqual([200, null]);
    // With one space, that is what the site is.
    expect(await at("/")).toEqual([302, "/shop/"]);
  });

  it("sends a page that moved to where it is now", async () => {
    const { data } = await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "Old",
      slug: "old-name",
      markdown: "Moved text.\n"
    });
    await admin.json("POST", `/api/v1/documents/${data.document.id as string}/move`, { slug: "new-name" });
    const response = await fetch(`${origin}/shop/old-name?x=1`, { redirect: "manual" });
    expect([response.status, response.headers.get("location")]).toEqual([301, "/shop/new-name?x=1"]);
    // Even in the moments a visitor's list of pages is still from before there was one: no going around in circles.
    const { data: fresh } = await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "Fresh",
      slug: "fresh",
      markdown: "Just written.\n"
    });
    expect(fresh.document.id).toBeTruthy();
    const early = await fetch(`${origin}/shop/fresh`, { redirect: "manual" });
    expect(early.status).toBe(404);
  });

  it("renders in the reader's language, down to the theme's own words", async () => {
    const chinese = await (await fetch(`${origin}/shop/returns`, { headers: { "accept-language": "zh-CN" } })).text();
    expect(chinese).toContain('data-language="zh"');
    expect(chinese).toContain("目录");
    const english = await (await fetch(`${origin}/shop/returns`, { headers: { "accept-language": "en" } })).text();
    expect(english).toContain('data-language="en"');
    expect(english).toContain("ON THIS PAGE");
    const chosen = await (
      await fetch(`${origin}/shop/returns`, { headers: { "accept-language": "en", cookie: "pandocs_language=zh" } })
    ).text();
    expect(chosen).toContain("目录");
    const { page, problems } = await open("/shop/returns", { locale: "zh-CN" });
    await live(page);
    await browserExpect(page.locator(".rp-outline").getByText("目录", { exact: true })).toBeVisible();
    expect(problems).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("keeps a signed-in person's page theirs, and a stranger's page free of it", async () => {
    const html = await (await admin.request("/shop/returns", { headers: { "accept-language": "en" } })).text();
    expect(html).toContain("?view=history");
    const visitor = await (await fetch(`${origin}/shop/returns`, { headers: { "accept-language": "en" } })).text();
    // A visitor is offered the same things, as buttons that ask them to sign in rather than links into them.
    expect(visitor).not.toContain("?view=history");
    expect(visitor).toContain("Sign in");
  });

  it("tells a stranger nothing about what is closed, and how to get in if it is theirs", async () => {
    const answers = await Promise.all(
      ["/inside/", "/inside/anything", "/nothing-here"].map(async path => {
        const response = await fetch(`${origin}${path}`, { redirect: "manual", headers: { "accept-language": "en" } });
        expect(response.status, path).toBe(404);
        return (await response.text()).replaceAll(path, "");
      })
    );
    expect(answers[0]).toContain("sign in to see it");
    expect(answers[0]).not.toContain("Inside");
    const account = await fetch(`${origin}/_/account`, { redirect: "manual" });
    expect(account.status).toBe(302);
    expect(account.headers.get("location")).toContain("/login?next=");
  });

  it("leaves the page to the browser when told to, showing its shape until then", async () => {
    const plain = await startServer(postgres.getConnectionString(), {
      PANDOCS_WEB_DIR: join(ROOT, "packages/web/dist"),
      PANDOCS_RENDER_PAGES: "false"
    });
    let unrendered: ReturnType<typeof listen>;
    const address = await new Promise<string>(done => {
      unrendered = listen(plain.app, { hostname: "127.0.0.1", port: 0 }, info => done(`http://127.0.0.1:${info.port}`));
    });
    const html = await (await fetch(`${address}/shop/returns`)).text();
    expect(html).toContain("pd-boot");
    expect(html).not.toContain("Within seven days of delivery.");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("**/api/v1/bootstrap", async route => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto(`${address}/shop/returns`, { waitUntil: "commit" });
    await browserExpect(page.locator(".pd-boot__line--title")).toBeVisible({ timeout: 5000 });
    await browserExpect(page.locator(".pd-boot")).toHaveCount(0, { timeout: 15_000 });
    await browserExpect(page.getByText("Within seven days of delivery.")).toBeVisible();
    await page.close();
    await new Promise(resolve => unrendered!.close(resolve));
    await plain.close();
  }, 60_000);
});
