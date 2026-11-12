import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { readConfig } from "../src/config.js";
import { insidePath } from "../src/web/base-path.js";
import { placeBelow } from "../src/web/static.js";
import { ADMIN, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const SITE = "http://pandocs.test/docs";

describe("a site below a path of another site's", () => {
  let server: TestServer;
  let admin: Client;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString(), { PANDOCS_URL: SITE });
    admin = server.client();
    const made = await admin.form("/docs/setup", { ...ADMIN, next: "/" });
    expect(made.status).toBe(303);
    expect(made.headers.get("location")).toBe("/docs/");
    expect(made.headers.get("set-cookie")).toContain("Path=/docs;");
  });
  afterAll(() => server.close());

  it("answers below its path, and outside it only what runs it and apps looking for how to sign in", async () => {
    const visitor = server.client();
    expect((await visitor.json("GET", "/docs/api/v1/me")).status).toBe(401);
    expect((await admin.json("GET", "/docs/api/v1/me")).data).toMatchObject({ displayName: ADMIN.displayName });
    expect((await admin.request("/api/v1/me")).status).toBe(404);
    expect((await visitor.request("/healthz")).status).toBe(200);
    expect((await visitor.request("/docs/readyz")).status).toBe(200);
    const root = await visitor.request("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/docs/");
    for (const path of ["/.well-known/oauth-authorization-server/docs", "/docs/.well-known/oauth-authorization-server"]) {
      expect((await (await visitor.request(path)).json()).issuer).toBe(SITE);
    }
    expect((await (await visitor.request("/.well-known/oauth-protected-resource/docs/mcp")).json())).toMatchObject({ resource: `${SITE}/mcp`, authorization_servers: [SITE] });
    const mcp = await visitor.request("/docs/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(mcp.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("sends people to sign in and back below its path", async () => {
    await admin.json("POST", "/docs/api/v1/spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
    await admin.json("POST", "/docs/api/v1/spaces/handbook/documents", { title: "Guide", slug: "guide", markdown: "Words.\n" });
    const visitor = server.client();
    const page = await visitor.request("/docs/handbook/guide");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/docs/login?${new URLSearchParams({ next: "/handbook/guide" })}`);
    const login = await (await visitor.request("/docs/login?next=%2Fhandbook%2Fguide")).text();
    for (const address of ['action="/docs/login"', 'href="/docs/forgot-password"', 'href="/docs/favicon.ico"', 'src="/docs/logo.svg"']) expect(login).toContain(address);
    const signedIn = await visitor.form("/docs/login", { email: ADMIN.email, password: ADMIN.password, next: "/handbook/guide" });
    expect(signedIn.headers.get("location")).toBe("/docs/handbook/guide");
    expect(signedIn.headers.get("set-cookie")).toContain("Path=/docs;");
    expect((await visitor.json("GET", "/docs/api/v1/bootstrap")).data.site.logoutUrl).toBe("/docs/logout");
    const out = await visitor.request("/docs/logout", { method: "POST" });
    expect(out.headers.get("set-cookie")).toMatch(/pandocs_session=;.*Path=\/docs/u);
  });

  it("names its own addresses with its path wherever they leave the browser", async () => {
    const invited = await admin.json("POST", "/docs/api/v1/admin/users", { email: "new@example.test", displayName: "新人" });
    const link = invited.data.passwordLink.url as string;
    expect(link.startsWith(`${SITE}/set-password/`)).toBe(true);
    const choose = await (await server.client().request(new URL(link).pathname)).text();
    expect(choose).toContain(`action="${new URL(link).pathname}"`);
    const robots = await (await server.client().request("/docs/robots.txt")).text();
    expect(robots).toContain("Disallow: /docs/");
    const page = await admin.request("/docs/handbook/guide");
    expect(page.headers.get("content-security-policy")).toContain("report-uri /docs/api/csp-report");
    const html = await page.text();
    expect(html).toContain('href="/docs/favicon.ico"');
    expect(html).not.toContain('href="/favicon.ico"');
    expect((await admin.request("/docs/assets/app-abc.js")).status).toBe(200);
  });
});

describe("where the site's files are named from", () => {
  const built = `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="pandocs-math-styles" content="/assets/katex-1.css">
    <link rel="icon" href="./favicon.ico" sizes="32x32" />
    <script src="./theme-init.js"></script>
    <script type="module" crossorigin src="./assets/index-1.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/app-1.css">
    <link rel="stylesheet" href="https://cdn.example.test/x.css">
  </head>`;

  it("is the site's path, at any depth of page", () => {
    const below = placeBelow(built, "/docs");
    for (const address of ['content="/docs/assets/katex-1.css"', 'href="/docs/favicon.ico"', 'src="/docs/theme-init.js"', 'src="/docs/assets/index-1.js"', 'href="/docs/assets/app-1.css"', 'href="https://cdn.example.test/x.css"', '<meta name="pandocs-base" content="/docs" />']) {
      expect(below).toContain(address);
    }
    const atRoot = placeBelow(built, "");
    expect(atRoot).toContain('src="/assets/index-1.js"');
    expect(atRoot).toContain('content="width=device-width, initial-scale=1"');
    expect(atRoot).not.toContain("pandocs-base");
  });

  it("takes the path off what comes in, and leaves other addresses alone", () => {
    expect(insidePath("/docs", "/docs")).toBe("/");
    expect(insidePath("/docs/handbook/guide", "/docs")).toBe("/handbook/guide");
    expect(insidePath("/docsy/guide", "/docs")).toBeNull();
    expect(insidePath("/handbook", "/docs")).toBeNull();
    expect(insidePath("/readyz", "/docs")).toBe("/readyz");
    expect(insidePath("/.well-known/oauth-protected-resource/docs/mcp", "/docs")).toBe("/.well-known/oauth-protected-resource/mcp");
  });

  it("comes from PANDOCS_URL, which can only have plain segments", () => {
    const env = { DATABASE_URL: "postgres://x/y" };
    expect(readConfig({ ...env, PANDOCS_URL: "https://example.test/docs/" })).toMatchObject({ basePath: "/docs", siteUrl: "https://example.test/docs" });
    expect(readConfig({ ...env, PANDOCS_URL: "https://example.test" })).toMatchObject({ basePath: "", siteUrl: "https://example.test" });
    expect(() => readConfig({ ...env, PANDOCS_URL: "https://example.test/docs?x=1" })).toThrow(/no query/u);
    expect(() => readConfig({ ...env, PANDOCS_URL: "https://example.test/my docs" })).toThrow(/plain segments/u);
  });
});
