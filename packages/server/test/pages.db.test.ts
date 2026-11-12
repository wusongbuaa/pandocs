import { DEFAULT_BRAND_COLOR } from "@pandocs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { CSP_HEADER, PAGE_CSP } from "../src/web/csp.js";
import { ADMIN, PUBLIC_URL, signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();

describe("what the server answers outside the API", () => {
  let server: TestServer;
  let admin: Client;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
    await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "入门", slug: "start", markdown: "第一段。\n" });
  });
  afterAll(() => server.close());

  it("serves the app's code to anyone, compressed when the browser can take it", async () => {
    const visitor = server.client();
    const compressed = await visitor.request("/assets/app-abc.js", { headers: { "accept-encoding": "gzip, br" } });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBe("br");
    expect(compressed.headers.get("cache-control")).toContain("immutable");
    expect(await compressed.text()).toBe("brotli-bytes");
    const plain = await visitor.request("/assets/app-abc.js");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("content-type")).toContain("javascript");
    expect((await visitor.request("/theme-init.js")).headers.get("cache-control")).toBe("no-cache");
  });

  it("does not read files outside the app's directory", async () => {
    const visitor = server.client();
    for (const path of ["/..%2f..%2fetc%2fpasswd", "/assets/..%2f..%2f..%2fetc%2fpasswd"]) {
      const response = await visitor.request(path);
      expect(await response.text()).not.toContain("root:");
    }
  });

  it("gives a signed-in person the page with its enforced policy", async () => {
    const page = await admin.request("/handbook/start");
    expect(page.status).toBe(200);
    expect(page.headers.get(CSP_HEADER)).toBe(PAGE_CSP);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await page.text()).toContain("<title>app</title>");
  });

  it("gives a page written with front matter as a title and its text, without the settings or the title twice", async () => {
    await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "指南", slug: "with-settings", markdown: "---\ntitle: 指南\n---\n\n# 指南\n\n正文。\n" });
    expect(await (await admin.request("/handbook/with-settings.md")).text()).toMatch(/\n\n# 指南\n\n正文。\n$/u);
    expect(await (await admin.request("/handbook/with-settings.md")).text()).not.toContain("title: 指南");
    await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "说明", slug: "settings-only", markdown: "---\noutline: false\n---\n\n正文。\n" });
    expect(await (await admin.request("/handbook/settings-only.md")).text()).toMatch(/\n\n# 说明\n\n正文。\n$/u);
  });

  it("serves a page's Markdown and the llms.txt files by session or token, never to strangers", async () => {
    const visitor = server.client();
    expect((await visitor.request("/handbook/start.md")).status).toBe(401);
    expect((await visitor.request("/llms.txt")).status).toBe(401);
    const markdown = await admin.request("/handbook/start.md");
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    const text = await markdown.text();
    expect(text.startsWith(`> For the complete documentation index, see [llms.txt](${PUBLIC_URL}/llms.txt).\n`)).toBe(true);
    expect(text).toMatch(/^> Something wrong on this page\? POST .* to http:\/\/pandocs\.test\/api\/v1\/documents\/[0-9a-f-]+\/feedback\.$/mu);
    expect(text.endsWith("\n\n# 入门\n\n第一段。\n")).toBe(true);
    const { token } = (await admin.json("POST", "/api/v1/account/tokens", { name: "读", scopes: ["read"] })).data;
    const auth = { headers: { authorization: `Bearer ${token}` } };
    expect(await (await visitor.request("/handbook/llms.txt", auth)).text()).toContain(`[入门](${PUBLIC_URL}/handbook/start.md)`);
    expect(await (await visitor.request("/llms-full.txt", auth)).text()).toContain("第一段。");
    expect((await visitor.request("/no-such-space/llms.txt", auth)).status).toBe(404);
  });

  it("gives someone copying a page from the site the page and nothing else", async () => {
    const copied = await admin.request("/handbook/start.md", { headers: { host: "pandocs.test", referer: `${PUBLIC_URL}/handbook/start` } });
    expect(await copied.text()).toBe("# 入门\n\n第一段。\n");
    const elsewhere = await admin.request("/handbook/start.md", { headers: { host: "pandocs.test", referer: "https://somewhere.example/" } });
    expect(await elsewhere.text()).toContain("llms.txt");
  });

  it("gives what reads a page's Markdown links that work wherever it ends up", async () => {
    const { data } = await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "Links", slug: "links", markdown: "See [the start](./start.md).\n" });
    expect(await (await admin.request("/handbook/links.md")).text()).toContain(`[the start](${PUBLIC_URL}/handbook/start.md)`);
    const copied = await admin.request("/handbook/links.md", { headers: { host: "pandocs.test", referer: `${PUBLIC_URL}/handbook/links` } });
    expect(await copied.text()).toContain("[the start](./start.md)");
    await admin.json("DELETE", `/api/v1/documents/${data.document.id as string}`);
  });

  it("answers an address with Markdown when that is what is asked for first", async () => {
    const asked = async (accept: string) => {
      const response = await admin.request("/handbook/start", { headers: { accept } });
      return { type: response.headers.get("content-type"), vary: response.headers.get("vary") };
    };
    for (const accept of ["text/markdown", "text/markdown, text/html, */*", "text/html;q=0.5, text/markdown"]) expect(await asked(accept)).toEqual({ type: "text/markdown; charset=utf-8", vary: expect.stringContaining("Accept") });
    for (const accept of ["text/html,application/xhtml+xml,*/*;q=0.8", "text/html, text/markdown", "*/*", "text/markdown;q=0"]) expect(await asked(accept)).toEqual({ type: "text/html; charset=utf-8", vary: expect.stringContaining("Accept") });
    const refused = await server.client().request("/handbook/start", { headers: { accept: "text/markdown" } });
    expect(refused.status).toBe(401);
  });

  it("lists what is under a front page nobody has written, as Markdown too", async () => {
    const space = await admin.request("/handbook/index.md");
    expect(space.status).toBe(200);
    expect(await space.text()).toContain(`[入门](${PUBLIC_URL}/handbook/start.md)`);
    const negotiated = await admin.request("/handbook/", { headers: { accept: "text/markdown" } });
    expect(await negotiated.text()).toContain(`[入门](${PUBLIC_URL}/handbook/start.md)`);
    const site = await admin.request("/index.md");
    expect(await site.text()).toContain(`[入门](${PUBLIC_URL}/handbook/start.md)`);
    expect((await admin.request("/no-such-space/index.md")).status).toBe(404);
  });

  it("has the llms.txt files of a language under that language", async () => {
    const { data: created } = await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "附录", slug: "appendix", markdown: "原文。\n" });
    await admin.json("PATCH", "/api/v1/site", { defaultLang: "zh", locales: [{ lang: "zh", label: "简体中文" }, { lang: "en", label: "English" }] });
    await admin.json("PUT", `/api/v1/documents/${created.document.id as string}/translations/en`, { title: "Appendix", markdown: "The original.\n", sourceRevision: 1, machine: false });
    const index = await (await admin.request("/en/llms.txt")).text();
    expect(index).toContain(`[Appendix](${PUBLIC_URL}/en/handbook/appendix.md)`);
    expect(index).toContain(`[入门](${PUBLIC_URL}/en/handbook/start.md)`);
    expect(await (await admin.request("/en/handbook/llms.txt")).text()).toContain(`[Appendix](${PUBLIC_URL}/en/handbook/appendix.md)`);
    const full = await (await admin.request("/en/llms-full.txt")).text();
    expect(full).toContain("The original.");
    expect(full).not.toContain("原文。");
    expect(full).toContain("第一段。");
    expect((await admin.request("/handbook/extra/llms.txt")).status).toBe(404);
    expect(await (await admin.request("/en/handbook/appendix.md")).text()).toContain(`[llms.txt](${PUBLIC_URL}/en/llms.txt)`);
    await admin.json("DELETE", `/api/v1/documents/${created.document.id as string}`);
    await admin.json("PATCH", "/api/v1/site", { defaultLang: "zh", locales: [{ lang: "zh", label: "简体中文" }] });
  });

  it("keeps crawlers out of a site with nothing public", async () => {
    const visitor = server.client();
    const robots = await visitor.request("/robots.txt");
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    expect((await visitor.request("/sitemap.xml")).status).toBe(404);
    expect((await visitor.request("/mcp/public", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("answers health checks without a login", async () => {
    const visitor = server.client();
    expect((await visitor.request("/healthz")).status).toBe(200);
    expect((await visitor.request("/readyz")).status).toBe(200);
    expect((await visitor.json("GET", "/api/v1/me")).status).toBe(401);
  });

  it("names the site on its login page and takes no script there", async () => {
    await admin.json("PATCH", "/api/v1/site", { title: "<青石>手册" });
    const page = await server.client().request("/login", { headers: { "accept-language": "en-US,en;q=0.9" } });
    expect(page.headers.get(CSP_HEADER)).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("&#60;青石&#62;手册");
    expect(html).toContain("Sign in");
    expect(html).not.toContain("<script");
    expect(ADMIN.email).toBeTruthy();
  });

  it("says what its API is to anyone who asks", async () => {
    const response = await server.client().request("/api/v1/openapi.yaml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect(await response.text()).toContain("openapi: 3.1");
  });

  it("gives an agent reading a page where to find its API description", async () => {
    const upload = await admin.request("/api/v1/spaces/handbook/assets?filename=api.yaml", { method: "POST", headers: { "content-type": "application/yaml" }, body: "openapi: 3.1.0\n" });
    const { path } = (await upload.json() as { data: { path: string } }).data;
    expect(path).toMatch(/^assets\/[a-f0-9]{64}\./u);
    await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "接口", slug: "api-page", markdown: `::openapi{src="${path}"}\n` });
    const markdown = await admin.request("/handbook/api-page.md", { headers: { authorization: "" } });
    expect(await markdown.text()).toMatch(new RegExp(`::openapi\\{src="${PUBLIC_URL}/api/v1/spaces/handbook/assets/[a-f0-9]{64}"\\}`, "u"));
  });

  it("has the site's own stylesheet there before anyone signs in", async () => {
    const response = await server.client().request("/site.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await response.text()).toContain(`--rp-c-brand: ${DEFAULT_BRAND_COLOR};`);
  });

  it("puts the site's own favicon, colour and logo on its pages and its sign-in page, in place of Pandocs' own", async () => {
    const icon = "data:image/png;base64,iVBORw0KGgo=";
    expect(await (await admin.request("/handbook/start")).text()).toContain('href="/favicon.svg"');
    await admin.json("PATCH", "/api/v1/site", { favicon: icon, brandColor: "#336699", logo: "/brand/mark.svg" });
    const html = await (await admin.request("/handbook/start")).text();
    expect(html).toContain(`<link rel="icon" href="${icon}" />`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="${icon}" />`);
    expect(html).not.toContain("/favicon.svg");
    expect(html.match(/rel="icon"/gu)).toHaveLength(1);
    const login = await (await server.client().request("/login")).text();
    expect(login).toContain(`<link rel="icon" href="${icon}">`);
    expect(login).toContain("--rp-c-brand: #336699;");
    expect(login).toContain('<img src="/brand/mark.svg"');
    await admin.json("PATCH", "/api/v1/site", { favicon: "", brandColor: "", logo: "" });
    const plain = await (await server.client().request("/login")).text();
    expect(plain).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(plain).toContain(`--rp-c-brand: ${DEFAULT_BRAND_COLOR};`);
    expect(plain).toContain('<img src="/logo.svg"');
  });

  it("shows a saved colour on the next page, and costs almost nothing when it has not changed", async () => {
    await admin.json("PATCH", "/api/v1/site", { brandColor: "#336699", customCss: ".rp-nav { height: 80px; }" });
    const first = await server.client().request("/site.css");
    const css = await first.text();
    expect(css).toContain("--rp-c-brand: #336699;");
    expect(css).toContain(".rp-nav { height: 80px; }");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const etag = first.headers.get("etag")!;
    const again = await server.client().request("/site.css", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    await admin.json("PATCH", "/api/v1/site", { brandColor: "#112233", customCss: "" });
    const changed = await server.client().request("/site.css", { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain("--rp-c-brand: #112233;");
    await admin.json("PATCH", "/api/v1/site", { brandColor: "" });
  });
});
