import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { LOGIN_CSP, CSP_HEADER } from "../src/web/csp.js";
import { startFakeSmtp } from "./fake-smtp.js";
import { PUBLIC_URL, signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const PASSWORD = "a-new-password-1";

const pathOf = (url: string) => new URL(url).pathname;

describe("handing someone an account", () => {
  let server: TestServer;
  let admin: Client;
  let count = 0;

  const invite = async (name = "新同事") => {
    count += 1;
    const created = await admin.json("POST", "/api/v1/admin/users", { email: `person${count}@example.test`, displayName: name });
    expect(created.status).toBe(201);
    return created.data as { id: string; email: string; passwordLink: { url: string; expiresAt: string; emailed: boolean } };
  };
  const signsIn = async (email: string, password: string) => {
    const person = server.client();
    await person.form("/login", { email, password, next: "/" });
    return (await person.json("GET", "/api/v1/me")).status === 200 && (await person.json("GET", "/api/v1/me")).data.anonymous !== true;
  };

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    await server.pool.query(`DROP SCHEMA pandocs CASCADE`);
    await (await import("../src/app.js")).migrate(server.pool);
    admin = await signInFirstAdmin(server);
  });
  afterAll(() => server.close());

  it("gives the administrator a link for someone added without a password", async () => {
    const person = await invite();
    expect(person.passwordLink.url.startsWith(`${PUBLIC_URL}/set-password/`)).toBe(true);
    expect(person.passwordLink.emailed).toBe(false);
    expect(new Date(person.passwordLink.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    expect(JSON.stringify((await admin.json("GET", "/api/v1/admin/users")).data)).not.toContain("passwordLink");
    const given = await admin.json("POST", "/api/v1/admin/users", { email: "given@example.test", displayName: "已有密码", password: "welcome-password" });
    expect(given.data.passwordLink).toBeUndefined();
  });

  it("keeps only a hash of the link, which is no way in on its own", async () => {
    const person = await invite();
    const { rows } = await server.pool.query(`SELECT token_hash FROM pandocs.password_links WHERE user_id = $1`, [person.id]);
    expect(rows).toHaveLength(1);
    expect(person.passwordLink.url).not.toContain(rows[0].token_hash);
  });

  it("lets them set a password and be signed in, once", async () => {
    const person = await invite();
    const visitor = server.client();
    const path = pathOf(person.passwordLink.url);
    const page = await visitor.request(path);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get(CSP_HEADER)).toBe(LOGIN_CSP);
    const form = await page.text();
    expect(form).toContain(person.email);
    expect(form).toContain('type="password"');
    // Chat apps open links to preview them, so looking must not use it up.
    expect((await visitor.request(path)).status).toBe(200);

    const done = await visitor.form(path, { password: PASSWORD });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/");
    expect((await visitor.json("GET", "/api/v1/me")).data).toMatchObject({ displayName: "新同事" });
    expect(await signsIn(person.email, PASSWORD)).toBe(true);

    expect((await server.client().request(path)).status).toBe(410);
    const again = await server.client().form(path, { password: "someone-elses-password" });
    expect(again.status).toBe(410);
    expect(await signsIn(person.email, "someone-elses-password")).toBe(false);
  });

  it("asks again for a password too short, and the link still works", async () => {
    const person = await invite();
    const visitor = server.client();
    const path = pathOf(person.passwordLink.url);
    const short = await visitor.form(path, { password: "short" });
    expect(short.status).toBe(422);
    expect(await short.text()).toContain("8");
    expect(visitor.cookies.size).toBe(0);
    expect((await visitor.form(path, { password: PASSWORD })).status).toBe(303);
  });

  it("escapes a person's name on the page", async () => {
    const person = await invite("<script>alert(1)</script>");
    const form = await (await server.client().request(pathOf(person.passwordLink.url))).text();
    expect(form).not.toContain("<script>alert");
  });

  it("stops working when it expires, or when a newer one is made", async () => {
    const person = await invite();
    const path = pathOf(person.passwordLink.url);
    const newer = await admin.json("POST", `/api/v1/admin/users/${person.id}/password-link`);
    expect(newer.status).toBe(201);
    expect((await server.client().request(path)).status).toBe(410);
    const newPath = pathOf(newer.data.url);
    expect((await server.client().request(newPath)).status).toBe(200);
    await server.pool.query(`UPDATE pandocs.password_links SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [person.id]);
    expect((await server.client().request(newPath)).status).toBe(410);
    expect((await server.client().form(newPath, { password: PASSWORD })).status).toBe(410);
  });

  it("does not work for an account that has been disabled", async () => {
    const person = await invite();
    await admin.json("PATCH", `/api/v1/admin/users/${person.id}`, { status: "disabled" });
    expect((await server.client().request(pathOf(person.passwordLink.url))).status).toBe(410);
    expect((await server.client().form(pathOf(person.passwordLink.url), { password: PASSWORD })).status).toBe(410);
    expect((await admin.json("POST", `/api/v1/admin/users/${person.id}/password-link`)).status).toBe(409);
  });

  it("signs out everywhere when a password is reset this way", async () => {
    const person = await invite();
    const first = server.client();
    await first.form(pathOf(person.passwordLink.url), { password: PASSWORD });
    expect((await first.json("GET", "/api/v1/account")).status).toBe(200);
    const link = (await admin.json("POST", `/api/v1/admin/users/${person.id}/password-link`)).data;
    const second = server.client();
    await second.form(pathOf(link.url), { password: "another-password-2" });
    expect((await first.json("GET", "/api/v1/account")).status).toBe(401);
    expect((await second.json("GET", "/api/v1/account")).status).toBe(200);
    expect(await signsIn(person.email, PASSWORD)).toBe(false);
  });

  it("leaves making links to administrators using the website or a token that can write", async () => {
    const person = await invite();
    const other = await invite("普通同事");
    const someone = server.client();
    await someone.form(pathOf(other.passwordLink.url), { password: PASSWORD });
    expect((await someone.json("POST", `/api/v1/admin/users/${person.id}/password-link`)).error.code).toBe("ADMIN_REQUIRED");
    expect((await server.client().json("POST", `/api/v1/admin/users/${person.id}/password-link`)).status).toBe(401);
    const reader = (await admin.json("POST", "/api/v1/account/tokens", { name: "只读", scopes: ["read"] })).data.token as string;
    expect((await server.client().json("POST", `/api/v1/admin/users/${person.id}/password-link`, undefined, { authorization: `Bearer ${reader}` })).error.code).toBe("SCOPE_REQUIRED");
    expect((await admin.json("POST", "/api/v1/admin/users/00000000-0000-0000-0000-000000000000/password-link")).status).toBe(404);
  });

  describe("on a site with no mail", () => {
    it("says who to ask, and makes nothing", async () => {
      const login = await (await server.client().request("/login")).text();
      expect(login).toContain('href="/forgot-password"');
      const page = await server.client().request("/forgot-password");
      expect(page.status).toBe(200);
      const text = await page.text();
      expect(text).not.toContain("<form");
      const person = await invite();
      await server.pool.query(`DELETE FROM pandocs.password_links WHERE user_id = $1`, [person.id]);
      expect((await server.client().form("/forgot-password", { email: person.email })).status).toBe(404);
      expect((await server.pool.query(`SELECT 1 FROM pandocs.password_links WHERE user_id = $1`, [person.id])).rows).toHaveLength(0);
    });
  });
});

describe("handing someone an account, by mail", () => {
  let server: TestServer;
  let admin: Client;
  let mail: Awaited<ReturnType<typeof startFakeSmtp>>;

  const mailFor = async (to: string) => {
    await vi.waitFor(() => expect(mail.inbox.some(item => item.to === to)).toBe(true));
    return mail.inbox.filter(item => item.to === to).at(-1)!;
  };
  const linkIn = (body: string) => new RegExp(`${PUBLIC_URL}/set-password/[A-Za-z0-9_-]+`, "u").exec(body)?.[0] ?? "";

  beforeAll(async () => {
    mail = await startFakeSmtp();
    server = await startServer(postgres.getConnectionString(), mail.env);
    await server.pool.query(`DROP SCHEMA pandocs CASCADE`);
    await (await import("../src/app.js")).migrate(server.pool);
    admin = await signInFirstAdmin(server);
  });
  afterEach(() => { mail.inbox.length = 0; });
  afterAll(async () => {
    await server.close();
    await mail.close();
  });

  it("mails the invitation, and says so", async () => {
    const created = await admin.json("POST", "/api/v1/admin/users", { email: "invited@example.test", displayName: "受邀人" });
    expect(created.data.passwordLink.emailed).toBe(true);
    const sent = await mailFor("invited@example.test");
    expect(linkIn(sent.body)).toBe(created.data.passwordLink.url);
    expect(sent.body).toContain("站长");
  });

  it("still gives the link if the mail cannot go out", async () => {
    await mail.close();
    try {
      const created = await admin.json("POST", "/api/v1/admin/users", { email: "unlucky@example.test", displayName: "没收到" });
      expect(created.status).toBe(201);
      expect(created.data.passwordLink.emailed).toBe(false);
      expect(created.data.passwordLink.url).toContain("/set-password/");
    } finally {
      const fresh = await startFakeSmtp();
      mail = fresh;
    }
  }, 60_000);
});

describe("forgetting a password", () => {
  let server: TestServer;
  let admin: Client;
  let mail: Awaited<ReturnType<typeof startFakeSmtp>>;

  const linkIn = (body: string) => new RegExp(`${PUBLIC_URL}/set-password/[A-Za-z0-9_-]+`, "u").exec(body)?.[0] ?? "";

  beforeAll(async () => {
    mail = await startFakeSmtp();
    server = await startServer(postgres.getConnectionString(), mail.env);
    await server.pool.query(`DROP SCHEMA pandocs CASCADE`);
    await (await import("../src/app.js")).migrate(server.pool);
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/admin/users", { email: "forgetful@example.test", displayName: "健忘", password: "the-old-password" });
    await admin.json("POST", "/api/v1/admin/users", { email: "gone@example.test", displayName: "离职", password: "the-old-password" });
    const { data } = await admin.json("GET", "/api/v1/admin/users?q=gone");
    await admin.json("PATCH", `/api/v1/admin/users/${data[0].id}`, { status: "disabled" });
    mail.inbox.length = 0;
  });
  afterEach(() => { mail.inbox.length = 0; });
  afterAll(async () => {
    await server.close();
    await mail.close();
  });

  it("answers the same whoever is asked about, and only an active account gets mail", async () => {
    const asked = async (email: string) => {
      const response = await server.client().form("/forgot-password", { email });
      return { status: response.status, text: await response.text() };
    };
    const known = await asked("forgetful@example.test");
    const unknown = await asked("nobody@example.test");
    const disabled = await asked("gone@example.test");
    expect(known.status).toBe(200);
    expect(unknown).toEqual(known);
    expect(disabled).toEqual(known);
    await vi.waitFor(() => expect(mail.inbox.map(item => item.to)).toEqual(["forgetful@example.test"]));
  });

  it("sends a link that lasts an hour and replaces the password", async () => {
    await server.client().form("/forgot-password", { email: "FORGETFUL@example.test" });
    await vi.waitFor(() => expect(mail.inbox).toHaveLength(1));
    const { rows } = await server.pool.query<{ left: number }>(`SELECT extract(epoch FROM expires_at - now()) AS left FROM pandocs.password_links ORDER BY created_at DESC LIMIT 1`);
    expect(Number(rows[0]!.left)).toBeLessThanOrEqual(3600);
    const person = server.client();
    expect((await person.form(new URL(linkIn(mail.inbox[0]!.body)).pathname, { password: "the-new-password" })).status).toBe(303);
    expect((await person.json("GET", "/api/v1/account")).status).toBe(200);
  });

  it("stops after a few asks, so it cannot be used to flood someone's mailbox", async () => {
    const asks = await Promise.all(Array.from({ length: 8 }, () => server.client().form("/forgot-password", { email: "flooded@example.test" })));
    expect(asks.every(response => response.status === 200)).toBe(true);
    await server.client().form("/forgot-password", { email: "forgetful@example.test" });
    await vi.waitFor(() => expect(mail.inbox.length).toBeGreaterThan(0));
    for (let ask = 0; ask < 8; ask += 1) await server.client().form("/forgot-password", { email: "forgetful@example.test" });
    await new Promise(done => setTimeout(done, 300));
    expect(mail.inbox.length).toBeLessThanOrEqual(5);
  });
});

describe("a site where accounts come from the company", () => {
  it("has no passwords to set", async () => {
    const provider = { PANDOCS_OIDC_ISSUER: "https://idp.example.test", PANDOCS_OIDC_CLIENT_ID: "pandocs", PANDOCS_OIDC_CLIENT_SECRET: "client-secret" };
    const server = await startServer(postgres.getConnectionString(), { ...provider, PANDOCS_PASSWORD_LOGIN: "false" });
    try {
      await server.pool.query(`DROP SCHEMA pandocs CASCADE`);
      await (await import("../src/app.js")).migrate(server.pool);
      const user = await server.runtime.users.create({ email: "root@example.test", displayName: "管理员", isAdmin: true });
      const { token } = await server.runtime.tokens.create(user.id, { name: "写", kind: "user", scopes: ["read", "write"] });
      const auth = { authorization: `Bearer ${token}` };
      const added = await server.client().json("POST", "/api/v1/admin/users", { email: "someone@example.test", displayName: "同事" }, auth);
      expect(added.status).toBe(201);
      expect(added.data.passwordLink).toBeUndefined();
      expect((await server.client().json("POST", `/api/v1/admin/users/${added.data.id}/password-link`, undefined, auth)).status).toBe(409);
      expect((await server.client().request("/forgot-password")).status).toBe(404);
      expect((await server.client().form("/forgot-password", { email: "someone@example.test" })).status).toBe(404);
      expect(await (await server.client().request("/login")).text()).not.toContain("forgot-password");
    } finally {
      await server.close();
    }
  });
});
