import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { hashPassword } from "../src/auth/passwords.js";
import { CSP_HEADER, PAGE_CSP } from "../src/web/csp.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const PASSWORD = "correct horse battery";
const postgres = usePostgresFixture();
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

describe("someone following a share link", () => {
  let server: TestServer;
  let admin: Client;
  let visitor: Client;
  let page = "";
  let token = "";
  let sha = "";

  const withLink = (path: string, method = "GET", extra: object = {}) => visitor.request(path, { method, headers: { authorization: `Bearer ${token}` }, ...extra });

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    visitor = server.client();
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "书店", defaultRole: "none" });
    const upload = await admin.request("/api/v1/spaces/shop/assets?filename=a.png", { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    const { path, sha256 } = ((await upload.json()) as { data: { path: string; sha256: string } }).data;
    sha = sha256;
    page = (await admin.json("POST", "/api/v1/spaces/shop/documents", { title: "退货", slug: "returns", markdown: `七天。\n\n![图](${path})\n` })).data.document.id;
    await admin.json("POST", "/api/v1/spaces/shop/documents", { title: "进货价", slug: "cost", markdown: "保密。\n" });
    token = (await admin.json("POST", `/api/v1/documents/${page}/share-links`, { expiresInDays: 1 })).data.token;
  });
  afterAll(() => server.close());

  it("gets the page on a site with nothing public, marked as nothing for search engines", async () => {
    const response = await visitor.request(`/s/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get(CSP_HEADER)).toBe(PAGE_CSP);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await visitor.request(`/s/${token}/shop/returns`)).status).toBe(200);
  });

  it("stops working when whoever made it is disabled, and stays stopped when they are back", async () => {
    const user = await server.runtime.users.create({ email: "lin@example.test", displayName: "林", passwordHash: await hashPassword(PASSWORD) });
    await admin.json("PUT", "/api/v1/spaces/shop/members", { subject: `user:${user.id}`, role: "editor" });
    const editor = server.client();
    await editor.form("/login", { email: "lin@example.test", password: PASSWORD, next: "/" });
    const theirs = (await editor.json("POST", `/api/v1/documents/${page}/share-links`, {})).data.token as string;
    expect((await visitor.request(`/s/${theirs}`)).status).toBe(200);

    expect((await admin.json("PATCH", `/api/v1/admin/users/${user.id}`, { status: "disabled" })).status).toBe(200);
    expect((await visitor.request(`/s/${theirs}`)).status).toBe(404);
    expect((await visitor.request(`/s/${token}`)).status).toBe(200);
    expect((await admin.json("PATCH", `/api/v1/admin/users/${user.id}`, { status: "active" })).status).toBe(200);
    expect((await visitor.request(`/s/${theirs}`)).status).toBe(404);
    const { data: links } = await admin.json("GET", `/api/v1/documents/${page}/share-links`);
    expect(links.map((link: { token: string }) => link.token)).toEqual([token]);
  });

  it("gives an agent the shared page as Markdown, and the index the page offers it, at the addresses the page names", async () => {
    const markdown = await visitor.request(`/s/${token}/shop/returns.md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    const text = await markdown.text();
    expect(text).toContain("七天。");
    expect(text).toContain(`/s/${token}/llms.txt`);
    const index = await visitor.request(`/s/${token}/llms.txt`);
    expect([index.status, index.headers.get("content-type")]).toEqual([200, "text/plain; charset=utf-8"]);
    const listed = await index.text();
    expect(listed).toContain(`/s/${token}/shop/returns.md`);
    expect(listed).not.toContain("进货价");
    expect(await (await visitor.request(`/s/${token}/llms-full.txt`)).text()).toContain("七天。");
    expect((await visitor.request(`/s/${token}/shop/cost.md`)).status).toBe(404);
    expect((await visitor.request("/s/pds_nothing-like-this/shop/returns.md")).status).toBe(404);
  });

  it("hears plainly when the link has stopped working, and is not sent to log in", async () => {
    const response = await visitor.request("/s/pds_nothing-like-this");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("does not work any more");
  });

  it("is someone the API recognises, for reading only", async () => {
    expect(((await (await withLink(`/api/v1/documents/${page}`)).json()) as { data: { markdown: string } }).data.markdown).toContain("七天");
    expect((await withLink("/api/v1/spaces")).status).toBe(404);
    expect((await visitor.request(`/api/v1/documents/${page}`)).status).toBe(401);
    expect((await visitor.request(`/api/v1/documents/${page}`, { headers: { authorization: "Bearer pds_nothing-like-this" } })).status).toBe(401);
  });

  it("sees the page's images through the address, which is all an image can carry", async () => {
    const image = await visitor.request(`/api/v1/spaces/shop/assets/${sha}?ticket=${token}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect((await visitor.request(`/api/v1/documents/${page}?ticket=${token}`)).status).toBe(401);
  });

  it("can copy the page as Markdown, and only this page", async () => {
    const markdown = await withLink(`/s/${token}/shop/returns.md`);
    expect(markdown.status).toBe(200);
    expect(await markdown.text()).toContain("七天");
    expect((await withLink(`/s/${token}/shop/cost.md`)).status).toBe(404);
  });

  it("gets no event stream, which would tell of other pages, and cannot connect an agent", async () => {
    expect((await withLink("/api/v1/events")).status).toBe(404);
    expect((await visitor.request(`/api/v1/events?ticket=${token}`)).status).toBe(404);
    expect((await withLink("/mcp", "POST", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status).toBe(403);
  });

  it("stops at once when the link is revoked", async () => {
    const { data: links } = await admin.json("GET", `/api/v1/documents/${page}/share-links`);
    expect((await admin.json("DELETE", `/api/v1/share-links/${links[0].id as string}`)).status).toBe(200);
    expect((await visitor.request(`/s/${token}`)).status).toBe(404);
    expect((await withLink(`/api/v1/documents/${page}`)).status).toBe(401);
  });
});

describe("on a site that must never be open", () => {
  it("is not there at all", async () => {
    const server = await startServer(postgres.getConnectionString(), { PANDOCS_PUBLIC_SPACES: "false" });
    try {
      expect((await server.client().request("/s/pds_something")).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
