import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { CSP_HEADER } from "../src/web/csp.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

describe("embedding pages in another system", () => {
  let server: TestServer;
  let admin: Client;
  let secret = "";

  const asBearer = (token: string, method: string, path: string, body?: unknown) => server.client().json(method, path, body, { authorization: `Bearer ${token}` });
  const mint = async (user: object = { id: "u1", displayName: "外部用户" }, extra: object = {}, key = secret) => asBearer(key, "POST", "/api/v1/embed/sessions", { user, ...extra });
  const tokenFor = async (user?: object) => (await mint(user)).data.token as string;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    const created = await admin.json("POST", "/api/v1/admin/embed-apps", { slug: "helpdesk", name: "服务台", allowedOrigins: ["https://helpdesk.example.com"] });
    expect(created.status).toBe(201);
    secret = created.data.secret;
    await admin.json("POST", "/api/v1/spaces", { slug: "shared", name: "给外部看的", defaultRole: "none" });
    await admin.json("POST", "/api/v1/spaces", { slug: "open", name: "内部公开", defaultRole: "viewer" });
    await admin.json("PUT", "/api/v1/spaces/shared/members", { subject: "group:embed:helpdesk", role: "commenter" });
    await admin.json("POST", "/api/v1/spaces/shared/documents", { title: "说明", slug: "guide", markdown: "# 说明\n\n第一段。\n" });
    await admin.json("POST", "/api/v1/spaces/open/documents", { title: "内部", slug: "inside", markdown: "只给这个站的人看\n" });
  });
  afterAll(() => server.close());

  describe("setting up an app", () => {
    it("is for administrators, and shows the secret once", async () => {
      const listed = await admin.json("GET", "/api/v1/admin/embed-apps");
      expect(listed.data).toEqual([expect.objectContaining({ slug: "helpdesk", name: "服务台", allowedOrigins: ["https://helpdesk.example.com"], status: "active", group: "embed:helpdesk" })]);
      expect(JSON.stringify(listed.data)).not.toContain("pda_");
      const { rows } = await server.pool.query(`SELECT secret_hash FROM pandocs.embed_apps WHERE slug = 'helpdesk'`);
      expect(rows[0].secret_hash).not.toContain(secret.slice(4));

      await admin.json("POST", "/api/v1/admin/users", { email: "someone@example.test", displayName: "同事", password: "someone-password-1" });
      const person = server.client();
      await person.form("/login", { email: "someone@example.test", password: "someone-password-1", next: "/" });
      expect((await person.json("GET", "/api/v1/admin/embed-apps")).error.code).toBe("ADMIN_REQUIRED");
      expect((await person.json("POST", "/api/v1/admin/embed-apps", { slug: "mine", name: "我的", allowedOrigins: [] })).error.code).toBe("ADMIN_REQUIRED");
    });

    it("takes only real origins, since they go into a security header", async () => {
      for (const origin of ["helpdesk.example.com", "https://a.example.com/path", "https://a.example.com; script-src *", "*", "https://*", "javascript:alert(1)"]) {
        const result = await admin.json("POST", "/api/v1/admin/embed-apps", { slug: "bad", name: "坏", allowedOrigins: [origin] });
        expect(result.status, origin).toBe(422);
      }
      for (const origin of ["https://a.example.com", "http://localhost:3000", "https://*.example.com"]) {
        const result = await admin.json("POST", "/api/v1/admin/embed-apps", { slug: "good", name: "好", allowedOrigins: [origin] });
        expect(result.status, origin).toBe(201);
        await admin.json("DELETE", "/api/v1/admin/embed-apps/good");
      }
      expect((await admin.json("POST", "/api/v1/admin/embed-apps", { slug: "helpdesk", name: "重复", allowedOrigins: [] })).error.code).toBe("EMBED_APP_TAKEN");
    });
  });

  describe("getting a token", () => {
    it("needs the app's secret", async () => {
      expect((await mint(undefined, {}, "pda_wrong")).error.code).toBe("EMBED_SECRET_INVALID");
      expect((await mint(undefined, {}, "pd_not_even_the_right_kind")).error.code).toBe("EMBED_SECRET_INVALID");
      const result = await mint();
      expect(result.status).toBe(201);
      expect(result.data.token).toMatch(/^pdg_/u);
      expect(new Date(result.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(result.data.app).toBe("helpdesk");
    });

    it("cannot be asked for from a person's session or token, or with too long a life", async () => {
      expect((await admin.json("POST", "/api/v1/embed/sessions", { user: { id: "x", displayName: "x" } })).status).toBe(401);
      expect((await mint(undefined, { ttlSeconds: 13 * 60 * 60 })).status).toBe(422);
      expect((await mint(undefined, { ttlSeconds: 10 })).status).toBe(422);
      expect((await mint({ id: "x", displayName: "x", groups: ["bad group"] })).status).toBe(422);
    });

    it("stops working when the app is disabled, and a new secret replaces the old one", async () => {
      const created = await admin.json("POST", "/api/v1/admin/embed-apps", { slug: "temp", name: "临时", allowedOrigins: [] });
      const first = created.data.secret as string;
      const token = (await mint(undefined, {}, first)).data.token as string;
      expect((await asBearer(token, "GET", "/api/v1/me")).status).toBe(200);

      const rotated = (await admin.json("POST", "/api/v1/admin/embed-apps/temp/secret")).data.secret as string;
      expect((await mint(undefined, {}, first)).status).toBe(401);
      expect((await mint(undefined, {}, rotated)).status).toBe(201);

      expect((await admin.json("PATCH", "/api/v1/admin/embed-apps/temp", { status: "disabled" })).data.status).toBe("disabled");
      expect((await asBearer(token, "GET", "/api/v1/me")).status).toBe(401);
      expect((await mint(undefined, {}, rotated)).status).toBe(401);
      expect((await server.client().request("/embed/temp/shared/guide")).status).toBe(404);

      expect((await admin.json("PATCH", "/api/v1/admin/embed-apps/temp", { status: "active" })).status).toBe(200);
      expect((await asBearer(token, "GET", "/api/v1/me")).status).toBe(200);
      expect((await admin.json("DELETE", "/api/v1/admin/embed-apps/temp")).status).toBe(200);
      expect((await asBearer(token, "GET", "/api/v1/me")).status).toBe(401);
    });

    it("cannot be forged or altered", async () => {
      const token = await tokenFor();
      const [payload = "", signature = ""] = token.slice(4).split(".");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      const altered = Buffer.from(JSON.stringify({ ...claims, groups: ["admins"], sub: "someone-else" })).toString("base64url");
      expect((await asBearer(`pdg_${altered}.${signature}`, "GET", "/api/v1/me")).status).toBe(401);
      expect((await asBearer(`pdg_${payload}.`, "GET", "/api/v1/me")).status).toBe(401);
      expect((await asBearer("pdg_nonsense", "GET", "/api/v1/me")).status).toBe(401);
      const expired = Buffer.from(JSON.stringify({ ...claims, exp: 1 })).toString("base64url");
      expect((await asBearer(`pdg_${expired}.${signature}`, "GET", "/api/v1/me")).status).toBe(401);
    });
  });

  describe("what a guest can do", () => {
    it("sees what was granted to the app by name, and not what everyone here gets", async () => {
      const token = await tokenFor();
      const me = await asBearer(token, "GET", "/api/v1/me");
      expect(me.data).toMatchObject({ id: "embed:helpdesk:u1", displayName: "外部用户", kind: "user", isAdmin: false });
      expect((await asBearer(token, "GET", "/api/v1/spaces")).data.map((space: { slug: string }) => space.slug)).toEqual(["shared"]);
      expect((await asBearer(token, "GET", "/api/v1/spaces/open")).status).toBe(404);
      const open = (await admin.json("GET", "/api/v1/spaces/open/resolve?path=inside")).data;
      expect((await asBearer(token, "GET", `/api/v1/documents/${open.id}`)).status).toBe(404);
      expect((await asBearer(token, "GET", "/api/v1/search?q=只给这个站")).data).toEqual([]);
      const bootstrap = await asBearer(token, "GET", "/api/v1/bootstrap");
      expect(bootstrap.data.spaces.map((space: { slug: string }) => space.slug)).toEqual(["shared"]);
    });

    it("sees nothing at all until something is granted, and does not get past a space's default", async () => {
      const created = await admin.json("POST", "/api/v1/admin/embed-apps", { slug: "nothing", name: "没授权", allowedOrigins: [] });
      const token = (await mint(undefined, {}, created.data.secret)).data.token as string;
      expect((await asBearer(token, "GET", "/api/v1/spaces")).data).toEqual([]);
      await admin.json("DELETE", "/api/v1/admin/embed-apps/nothing");
    });

    it("works within the role granted: comments, but no edits", async () => {
      const token = await tokenFor({ id: "u2", displayName: "评论的人" });
      const page = (await admin.json("GET", "/api/v1/spaces/shared/resolve?path=guide")).data;
      expect((await asBearer(token, "GET", `/api/v1/documents/${page.id}`)).data.markdown).toContain("第一段");
      const thread = await asBearer(token, "POST", `/api/v1/documents/${page.id}/threads`, { anchor: { kind: "quote", quote: "第一段" }, body: "这里要确认" });
      expect(thread.status).toBe(201);
      expect(thread.data.createdName).toBe("评论的人");
      expect((await admin.json("GET", `/api/v1/threads/${thread.data.id}`)).data.comments[0]).toMatchObject({ authorId: "embed:helpdesk:u2", channel: "embed" });
      const saved = await server.client().json("PUT", `/api/v1/documents/${page.id}/content`, { markdown: "改了\n", expectedRevision: 1 }, { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() });
      expect(saved.status).toBe(403);
      expect((await asBearer(token, "POST", "/api/v1/spaces", { slug: "mine", name: "我的" })).status).toBe(403);
    });

    it("cannot claim one of this site's groups, whatever its system says", async () => {
      await admin.json("POST", "/api/v1/spaces", { slug: "editors", name: "编辑组", defaultRole: "none" });
      await admin.json("PUT", "/api/v1/spaces/editors/members", { subject: "group:editors", role: "admin" });
      await admin.json("PUT", "/api/v1/spaces/editors/members", { subject: "group:embed:helpdesk:editors", role: "viewer" });
      const token = await tokenFor({ id: "u3", displayName: "想越权", groups: ["editors"] });
      const space = (await asBearer(token, "GET", "/api/v1/spaces/editors")).data;
      // It reaches what was granted to that group within this app, and no further.
      expect(space.role).toBe("viewer");
    });

    it("is kept out of everything that is about this site rather than its documents", async () => {
      const token = await tokenFor();
      expect((await asBearer(token, "GET", "/api/v1/account")).error.code).toBe("SESSION_REQUIRED");
      expect((await asBearer(token, "GET", "/api/v1/account/tokens")).error.code).toBe("SESSION_REQUIRED");
      expect((await asBearer(token, "POST", "/api/v1/account/tokens", { name: "偷偷", scopes: ["read"] })).error.code).toBe("SESSION_REQUIRED");
      expect((await asBearer(token, "GET", "/api/v1/admin/users")).error.code).toBe("ADMIN_REQUIRED");
      expect((await asBearer(token, "GET", "/api/v1/admin/embed-apps")).error.code).toBe("ADMIN_REQUIRED");
      expect((await asBearer(token, "GET", "/api/v1/directory?q=a")).data).toEqual([]);
      expect((await asBearer(token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    });
  });

  describe("images and event streams, which cannot carry a header", () => {
    let image = "";
    beforeAll(async () => {
      const upload = await admin.request("/api/v1/spaces/shared/assets?filename=a.png", { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
      image = ((await upload.json()) as { data: { sha256: string } }).data.sha256;
    });
    const ticketFor = async (token: string) => (await asBearer(token, "GET", "/api/v1/embed/ticket")).data.ticket as string;

    it("take a ticket in the address, and only those", async () => {
      const ticket = await ticketFor(await tokenFor());
      const visitor = server.client();
      expect((await visitor.request(`/api/v1/spaces/shared/assets/${image}`)).status).toBe(401);
      const shown = await visitor.request(`/api/v1/spaces/shared/assets/${image}?ticket=${ticket}`);
      expect(shown.status).toBe(200);
      expect(shown.headers.get("content-type")).toBe("image/png");
      expect((await visitor.request(`/api/v1/spaces/open/assets/${image}?ticket=${ticket}`)).status).toBe(404);

      // The same ticket opens nothing else: not reads of pages, and not anything that changes something.
      expect((await visitor.request(`/api/v1/me?ticket=${ticket}`)).status).toBe(401);
      expect((await visitor.request(`/api/v1/spaces?ticket=${ticket}`)).status).toBe(401);
      const page = (await admin.json("GET", "/api/v1/spaces/shared/resolve?path=guide")).data;
      expect((await visitor.request(`/api/v1/documents/${page.id}?ticket=${ticket}`)).status).toBe(401);
      expect((await visitor.json("POST", `/api/v1/spaces/shared/assets?ticket=${ticket}`, {})).status).toBe(401);
    });

    it("do not accept a session token in the address, and a ticket is no good as a session", async () => {
      const token = await tokenFor();
      const ticket = await ticketFor(token);
      const visitor = server.client();
      expect((await visitor.request(`/api/v1/spaces/shared/assets/${image}?ticket=${token}`)).status).toBe(401);
      expect((await asBearer(ticket, "GET", "/api/v1/me")).status).toBe(401);
      expect((await asBearer(ticket, "GET", "/api/v1/embed/ticket")).status).toBe(401);
      expect((await asBearer("pd_not_real", "GET", "/api/v1/embed/ticket")).status).toBe(401);
    });

    it("open a live stream with one", async () => {
      const ticket = await ticketFor(await tokenFor());
      const response = await server.client().request(`/api/v1/events?space=shared&ticket=${ticket}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      await response.body!.cancel();
    });
  });

  describe("the page", () => {
    it("loads with no login, and only the listed sites may frame it", async () => {
      const page = await server.client().request("/embed/helpdesk/shared/guide?host=https%3A%2F%2Fhelpdesk.example.com");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const policy = page.headers.get(CSP_HEADER)!;
      expect(policy).toContain("frame-ancestors 'self' https://helpdesk.example.com;");
      expect(policy).toContain("script-src 'self'");
    });

    it("does not exist for an app that does not", async () => {
      expect((await server.client().request("/embed/nobody/shared/guide")).status).toBe(404);
    });

    it("leaves the normal pages closed to framing, and to anyone not logged in", async () => {
      const page = await admin.request("/shared/guide");
      expect(page.headers.get(CSP_HEADER)).toContain("frame-ancestors 'self';");
      expect((await server.client().request("/shared/guide")).status).toBe(302);
    });

    it("gives the Markdown of a page to a guest allowed to read it", async () => {
      const token = await tokenFor();
      const response = await server.client().request("/embed/helpdesk/shared/guide.md", { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("第一段");
      expect((await server.client().request("/embed/helpdesk/open/inside.md", { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
      expect((await server.client().request("/embed/helpdesk/shared/guide.md")).status).toBe(401);
    });
  });
});
