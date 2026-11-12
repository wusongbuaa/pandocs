import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { safeNext } from "../src/auth/routes.js";
import { ADMIN, signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();

/** How the app's sign-in dialog talks to the sign-in routes: it asks for data, and posts the same form as the page. */
const askingForData = (client: Client, path: string, fields?: Record<string, string>) => client.request(path, fields
  ? { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }
  : { headers: { accept: "application/json" } });

describe("signing in", () => {
  let server: TestServer;
  let admin: Client;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
  });
  afterAll(() => server.close());

  it("offers to create the administrator while there is nobody, and only then", async () => {
    const visitor = server.client();
    const page = await (await visitor.request("/login")).text();
    expect(page).toContain('action="/setup"');
    admin = await signInFirstAdmin(server);
    expect((await admin.json("GET", "/api/v1/me")).data).toMatchObject({ displayName: ADMIN.displayName, isAdmin: true });
    const second = await visitor.form("/setup", { email: "late@example.test", displayName: "后来者", password: "password-long", next: "/" });
    expect(second.headers.get("location")).toContain("error=setup");
    expect((await (await visitor.request("/login")).text())).toContain('action="/login"');
  });

  it("keeps a page behind the login and returns to it afterwards", async () => {
    const visitor = server.client();
    const page = await visitor.request("/handbook/guide?mode=edit");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/handbook/guide?mode=edit")}`);
    const login = await visitor.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/handbook/guide?mode=edit" });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/handbook/guide?mode=edit");
    expect((await visitor.request("/handbook/guide")).status).toBe(200);
  });

  it("never sends someone off the site after signing in", () => {
    expect(safeNext("https://evil.test/")).toBe("/");
    expect(safeNext("//evil.test/")).toBe("/");
    expect(safeNext("/\\evil.test")).toBe("/");
    expect(safeNext("/login?next=/x")).toBe("/");
    expect(safeNext("/handbook")).toBe("/handbook");
  });

  it("does not say whether the address exists, and stops a guesser", async () => {
    const guesser = server.client();
    const wrong = await guesser.form("/login", { email: ADMIN.email, password: "not the password", next: "/" });
    const unknown = await guesser.form("/login", { email: "nobody@example.test", password: "not the password", next: "/" });
    expect(wrong.headers.get("location")).toBe(unknown.headers.get("location"));
    expect(wrong.headers.get("location")).toContain("error=credentials");
    for (let attempt = 0; attempt < 9; attempt += 1) await guesser.form("/login", { email: ADMIN.email, password: "still wrong", next: "/" });
    // A second replica counts the same failures.
    const elsewhere = server.client(server.replica());
    const blocked = await elsewhere.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/" });
    expect(blocked.headers.get("location")).toContain("error=throttled");
    await server.pool.query(`DELETE FROM pandocs.login_attempts`);
  });

  it("answers the app's sign-in dialog with data, where the page gets somewhere to go", async () => {
    const visitor = server.client();
    const options = await askingForData(visitor, "/login");
    expect(options.headers.get("cache-control")).toBe("no-store");
    expect(await options.json()).toEqual({ version: 1, data: { signedIn: false, passwordLogin: true, setup: false, providers: [] } });
    const wrong = await askingForData(visitor, "/login", { email: ADMIN.email, password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("location")).toBeNull();
    expect(await wrong.json()).toEqual({ version: 1, error: { code: "LOGIN_FAILED", message: "Wrong email or password" } });
    expect(visitor.cookies.size).toBe(0);
    const right = await askingForData(visitor, "/login", { email: ADMIN.email, password: ADMIN.password });
    expect(await right.json()).toEqual({ version: 1, data: { ok: true } });
    expect((await visitor.json("GET", "/api/v1/me")).data).toMatchObject({ displayName: ADMIN.displayName });
    expect((await (await askingForData(visitor, "/login")).json()).data.signedIn).toBe(true);
    await server.pool.query(`DELETE FROM pandocs.login_attempts`);
  });

  it("gives the app's dialog the sign-in pages' own stylesheet, and says when it has not changed", async () => {
    const visitor = server.client();
    const sheet = await visitor.request("/sign-in.css");
    expect(sheet.headers.get("content-type")).toContain("text/css");
    expect(await sheet.text()).toContain(".pd-sign-in__submit");
    const again = await visitor.request("/sign-in.css", { headers: { "if-none-match": sheet.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect(await (await visitor.request("/login")).text()).toContain('<main class="pd-sign-in">');
  });

  it("tells the dialog when a guesser is stopped, as the page does", async () => {
    const guesser = server.client();
    for (let attempt = 0; attempt < 10; attempt += 1) await askingForData(guesser, "/login", { email: "guessed@example.test", password: "a guess" });
    const blocked = await askingForData(guesser, "/login", { email: "guessed@example.test", password: "a guess" });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("LOGIN_THROTTLED");
    const fromElsewhere = await guesser.request("/login", { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" }, body: new URLSearchParams({ email: ADMIN.email, password: ADMIN.password }).toString() });
    expect(fromElsewhere.status).toBe(403);
    expect(guesser.cookies.size).toBe(0);
    await server.pool.query(`DELETE FROM pandocs.login_attempts`);
  });

  it("works on any replica, because sessions are in the database", async () => {
    const person = server.client();
    await person.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/" });
    const elsewhere = server.client(server.replica());
    for (const [name, value] of person.cookies) elsewhere.cookies.set(name, value);
    expect((await elsewhere.json("GET", "/api/v1/me")).status).toBe(200);
  });

  it("ends the session on sign-out", async () => {
    const person = server.client();
    await person.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/" });
    const stolen = new Map(person.cookies);
    expect((await person.json("POST", "/logout", {})).status).toBe(200);
    expect(person.cookies.size).toBe(0);
    const replay = server.client();
    for (const [name, value] of stolen) replay.cookies.set(name, value);
    expect((await replay.json("GET", "/api/v1/me")).status).toBe(401);
  });

  it("refuses writes another site triggers with the session cookie", async () => {
    const body = { slug: "from-elsewhere", name: "别处" };
    expect((await admin.json("POST", "/api/v1/spaces", body, { "sec-fetch-site": "cross-site" })).error.code).toBe("CROSS_SITE_REQUEST");
    expect((await admin.json("POST", "/api/v1/spaces", body, { origin: "https://evil.test" })).error.code).toBe("CROSS_SITE_REQUEST");
    expect((await admin.json("POST", "/api/v1/spaces", { slug: "same-site", name: "本站" }, { "sec-fetch-site": "same-origin" })).status).toBe(201);
  });

  it("keeps a space from taking an address the server answers itself", async () => {
    const { status, error } = await admin.json("POST", "/api/v1/spaces", { slug: "login", name: "登录" });
    expect(status).toBe(422);
    expect(error.code).toBe("SPACE_SLUG_RESERVED");
  });
});

describe("API tokens", () => {
  let server: TestServer;
  let admin: Client;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    await server.pool.query(`DROP SCHEMA pandocs CASCADE`);
    await (await import("../src/app.js")).migrate(server.pool);
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
  });
  afterAll(() => server.close());

  const createToken = async (input: object) => (await admin.json("POST", "/api/v1/account/tokens", input)).data as { token: string; record: { id: string } };

  it("shows a token once and stores only its hash", async () => {
    const { token, record } = await createToken({ name: "笔记本", scopes: ["read", "write"] });
    expect(token).toMatch(/^pd_/u);
    const listed = (await admin.json("GET", "/api/v1/account/tokens")).data;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);
    const { rows } = await server.pool.query(`SELECT token_hash FROM pandocs.api_tokens WHERE id = $1`, [record.id]);
    expect(rows[0].token_hash).not.toContain(token);
  });

  it("acts as its owner, records the channel, and stops when revoked", async () => {
    const { token, record } = await createToken({ name: "脚本", scopes: ["read", "write"] });
    const client = server.client();
    const created = await client.json("POST", "/api/v1/spaces/handbook/documents", { title: "令牌写的", markdown: "正文\n" }, { ...bearer(token), "x-pandocs-channel": "cli" });
    expect(created.status).toBe(201);
    const { rows } = await server.pool.query(`SELECT channel, actor_name FROM pandocs.revisions WHERE document_id = $1`, [created.data.document.id]);
    expect(rows[0]).toEqual({ channel: "cli", actor_name: ADMIN.displayName });
    expect((await admin.json("DELETE", `/api/v1/account/tokens/${record.id}`)).status).toBe(200);
    expect((await client.json("GET", "/api/v1/me", undefined, bearer(token))).status).toBe(401);
  });

  it("holds a read-only token to reading", async () => {
    const { token } = await createToken({ name: "只读", scopes: ["read"] });
    const client = server.client();
    expect((await client.json("GET", "/api/v1/spaces", undefined, bearer(token))).status).toBe(200);
    const write = await client.json("POST", "/api/v1/spaces/handbook/documents", { title: "不该成功", markdown: "x\n" }, bearer(token));
    expect(write.status).toBe(403);
  });

  it("caps an agent token at comments and proposals, whatever its owner may do", async () => {
    const { token } = await createToken({ name: "写作助手", kind: "agent", scopes: ["read", "write"] });
    const client = server.client();
    const doc = (await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "给智能体看的", markdown: "第一段内容。\n" })).data.document;
    expect((await client.json("GET", `/api/v1/documents/${doc.id}`, undefined, bearer(token))).status).toBe(200);
    expect((await client.json("PUT", `/api/v1/documents/${doc.id}/content`, { markdown: "改了\n", expectedRevision: 1 }, { ...bearer(token), "idempotency-key": "agent-write-1" })).status).toBe(403);
    const proposal = await client.json("POST", `/api/v1/documents/${doc.id}/proposals`, { baseRevision: 1, ops: [{ op: "str_replace", pattern: "第一段", content: "开头" }], rationale: "更清楚" }, bearer(token));
    expect(proposal.status).toBe(201);
    const { rows } = await server.pool.query(`SELECT author_kind, author_name FROM pandocs.proposals WHERE id = $1`, [proposal.data.id]);
    expect(rows[0].author_kind).toBe("agent");
    expect(rows[0].author_name).toContain(ADMIN.displayName);
  });

  it("cannot mint more tokens or manage accounts' passwords", async () => {
    const { token } = await createToken({ name: "全权", scopes: ["read", "write"] });
    const client = server.client();
    expect((await client.json("POST", "/api/v1/account/tokens", { name: "再来一个" }, bearer(token))).error.code).toBe("SESSION_REQUIRED");
    expect((await client.json("POST", "/api/v1/account/password", { next: "another-password" }, bearer(token))).error.code).toBe("SESSION_REQUIRED");
  });
});

describe("managing people", () => {
  let server: TestServer;
  let admin: Client;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    await server.pool.query(`DROP SCHEMA pandocs CASCADE`);
    await (await import("../src/app.js")).migrate(server.pool);
    admin = await signInFirstAdmin(server);
  });
  afterAll(() => server.close());

  it("creates an account that can sign in, and is found for mentions", async () => {
    const created = await admin.json("POST", "/api/v1/admin/users", { email: "new@example.test", displayName: "新同事", password: "welcome-password" });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.data)).not.toContain("password_hash");
    expect((await admin.json("POST", "/api/v1/admin/users", { email: "NEW@example.test", displayName: "重复" })).error.code).toBe("EMAIL_TAKEN");
    const person = server.client();
    await person.form("/login", { email: "new@example.test", password: "welcome-password", next: "/" });
    expect((await person.json("GET", "/api/v1/me")).data).toMatchObject({ displayName: "新同事", isAdmin: false });
    expect((await person.json("GET", "/api/v1/admin/users")).error.code).toBe("ADMIN_REQUIRED");
    expect((await person.json("GET", "/api/v1/directory?q=新同")).data).toEqual([{ id: created.data.id, name: "新同事" }]);
    // An address finds its person only whole, so part of one, such as the domain, lists nobody.
    expect((await person.json("GET", "/api/v1/directory?q=NEW%40example.test")).data).toEqual([{ id: created.data.id, name: "新同事" }]);
    expect((await person.json("GET", "/api/v1/directory?q=example.test")).data).toEqual([]);
    expect((await person.json("GET", "/api/v1/directory?q=new%40")).data).toEqual([]);
  });

  it("disabling an account ends its sessions at once", async () => {
    const created = (await admin.json("POST", "/api/v1/admin/users", { email: "leaving@example.test", displayName: "离职", password: "leaving-password" })).data;
    const person = server.client();
    await person.form("/login", { email: "leaving@example.test", password: "leaving-password", next: "/" });
    expect((await admin.json("PATCH", `/api/v1/admin/users/${created.id}`, { status: "disabled" })).data.status).toBe("disabled");
    expect((await person.json("GET", "/api/v1/me")).status).toBe(401);
    const again = await server.client().form("/login", { email: "leaving@example.test", password: "leaving-password", next: "/" });
    expect(again.headers.get("location")).toContain("error=disabled");
    const inDialog = await askingForData(server.client(), "/login", { email: "leaving@example.test", password: "leaving-password" });
    expect(inDialog.status).toBe(403);
    expect((await inDialog.json()).error.code).toBe("ACCOUNT_DISABLED");
  });

  it("does not let the administrator lock themselves out", async () => {
    const me = (await admin.json("GET", "/api/v1/account")).data;
    expect((await admin.json("PATCH", `/api/v1/admin/users/${me.id}`, { isAdmin: false })).error.code).toBe("CANNOT_DEMOTE_SELF");
  });

  it("always leaves an administrator who can sign in, even when two take each other's rights at the same moment", async () => {
    const me = (await admin.json("GET", "/api/v1/account")).data;
    const other = (await admin.json("POST", "/api/v1/admin/users", { email: "second-admin@example.test", displayName: "第二管理员", password: "second-admin-password", isAdmin: true })).data;
    const second = server.client();
    await second.form("/login", { email: "second-admin@example.test", password: "second-admin-password", next: "/" });
    try {
      const answers = await Promise.all([
        admin.json("PATCH", `/api/v1/admin/users/${other.id}`, { isAdmin: false }),
        second.json("PATCH", `/api/v1/admin/users/${me.id}`, { status: "disabled" })
      ]);
      expect(answers.filter(answer => answer.status === 200)).toHaveLength(1);
      expect(answers.find(answer => answer.status !== 200)?.error.code).toMatch(/^(LAST_ADMIN|ADMIN_REQUIRED)$/u);
      const admins = (await Promise.all([me.id, other.id].map(id => server.runtime.users.findById(id)))).filter(user => user?.isAdmin && user.status === "active");
      expect(admins).toHaveLength(1);
    } finally {
      await server.runtime.users.update(me.id, { isAdmin: true, status: "active" });
      // Disabling an account ends its sessions, so when that side won, the administrator signs in again for what follows.
      await admin.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/" });
    }
  });

  it("changes a password only with the current one", async () => {
    expect((await admin.json("POST", "/api/v1/account/password", { current: "wrong", next: "brand-new-password" })).error.code).toBe("PASSWORD_WRONG");
    expect((await admin.json("POST", "/api/v1/account/password", { current: ADMIN.password, next: "brand-new-password" })).status).toBe(200);
    const person = server.client();
    const login = await person.form("/login", { email: ADMIN.email, password: "brand-new-password", next: "/" });
    expect(login.headers.get("location")).toBe("/");
  });
});

describe("the signing secret", () => {
  it("is generated once, and every replica reads the same one", async () => {
    const server = await startServer(postgres.getConnectionString());
    try {
      const { loadSigningSecret } = await import("../src/app.js");
      const first = await loadSigningSecret(server.pool);
      expect(first).toHaveLength(64);
      expect(await loadSigningSecret(server.pool)).toBe(first);
    } finally {
      await server.close();
    }
  });
});
