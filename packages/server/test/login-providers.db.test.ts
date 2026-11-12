import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { startFakeIdp } from "./fake-idp.js";
import { startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();

/** Walks the redirects a browser would: to the provider and back to whichever replica answers. */
async function signIn(person: Client, provider: "oidc" | "oauth", next = "/handbook", back: Client = person): Promise<Response> {
  const start = await person.request(`/auth/${provider}/start?next=${encodeURIComponent(next)}`);
  expect(start.status).toBe(302);
  const location = start.headers.get("location")!;
  expect(location).toContain("code_challenge_method=S256");
  const redirected = await fetch(location, { redirect: "manual" });
  const callback = new URL(redirected.headers.get("location")!);
  if (back !== person) for (const [name, value] of person.cookies) back.cookies.set(name, value);
  return back.request(`${callback.pathname}${callback.search}`);
}

describe("signing in through a company's identity provider", () => {
  let idp: Awaited<ReturnType<typeof startFakeIdp>>;
  let server: TestServer;

  beforeAll(async () => {
    idp = await startFakeIdp();
    server = await startServer(postgres.getConnectionString(), {
      PANDOCS_OIDC_ISSUER: idp.issuer,
      PANDOCS_OIDC_NAME: "企业账号",
      PANDOCS_OIDC_CLIENT_ID: "pandocs",
      PANDOCS_OIDC_CLIENT_SECRET: "client-secret",
      PANDOCS_OIDC_ALLOW_HTTP: "true",
      PANDOCS_OIDC_ALLOWED_DOMAINS: "example.test",
      PANDOCS_OAUTH_AUTHORIZATION_URL: `${idp.issuer}/authorize`,
      PANDOCS_OAUTH_TOKEN_URL: `${idp.issuer}/token`,
      PANDOCS_OAUTH_USERINFO_URL: `${idp.issuer}/oauth/user`,
      PANDOCS_OAUTH_NAME: "内部 OAuth",
      PANDOCS_OAUTH_CLIENT_ID: "pandocs",
      PANDOCS_OAUTH_CLIENT_SECRET: "client-secret",
      PANDOCS_OAUTH_ALLOW_HTTP: "true"
    });
  });
  afterAll(async () => {
    await server.close();
    await idp.close();
  });
  beforeEach(async () => {
    await server.pool.query(`TRUNCATE pandocs.users CASCADE`);
  });

  it("lists the providers on the login page, and for the app's sign-in dialog", async () => {
    const page = await (await server.client().request("/login")).text();
    expect(page).toContain("Sign in with 企业账号");
    expect(page).toContain("/auth/oauth/start");
    const options = await (await server.client().request("/login", { headers: { accept: "application/json" } })).json();
    expect(options.data.providers).toEqual([{ id: "oidc", name: "企业账号" }, { id: "oauth", name: "内部 OAuth" }]);
  });

  it("makes the first person the administrator and brings their groups along", async () => {
    idp.signInAs({ sub: "first", email: "first@example.test", email_verified: true, name: "第一位", groups: ["writers"] });
    const person = server.client();
    const back = await signIn(person, "oidc");
    expect(back.headers.get("location")).toBe("/handbook");
    expect((await person.json("GET", "/api/v1/account")).data).toMatchObject({ email: "first@example.test", displayName: "第一位", isAdmin: true, groups: ["writers"], hasPassword: false });
    idp.signInAs({ sub: "second", email: "second@example.test", email_verified: true, name: "第二位" });
    const other = server.client();
    await signIn(other, "oidc");
    expect((await other.json("GET", "/api/v1/account")).data).toMatchObject({ isAdmin: false, groups: [] });
  });

  it("can finish on another replica than the one that started", async () => {
    idp.signInAs({ sub: "roaming", email: "roaming@example.test", email_verified: true, name: "跨副本" });
    const person = server.client();
    const elsewhere = server.client(server.replica());
    const back = await signIn(person, "oidc", "/handbook", elsewhere);
    expect(back.status).toBe(302);
    expect((await elsewhere.json("GET", "/api/v1/me")).data.displayName).toBe("跨副本");
  });

  it("gives group access through the group the provider reports, and takes it away again", async () => {
    idp.signInAs({ sub: "owner", email: "owner@example.test", email_verified: true, name: "站长" });
    const owner = server.client();
    await signIn(owner, "oidc");
    await owner.json("POST", "/api/v1/spaces", { slug: `team-${Date.now().toString(36)}`, name: "团队", defaultRole: "none" });
    const { data: spaces } = await owner.json("GET", "/api/v1/spaces");
    const slug = spaces.at(-1).slug as string;
    await owner.json("PUT", `/api/v1/spaces/${slug}/members`, { subject: "group:writers", role: "editor" });
    idp.signInAs({ sub: "member", email: "member@example.test", email_verified: true, name: "成员", groups: ["writers"] });
    const member = server.client();
    await signIn(member, "oidc");
    expect((await member.json("GET", `/api/v1/spaces/${slug}`)).status).toBe(200);
    idp.signInAs({ sub: "member", email: "member@example.test", email_verified: true, name: "成员", groups: [] });
    await signIn(member, "oidc");
    expect((await member.json("GET", `/api/v1/spaces/${slug}`)).status).toBe(404);
  });

  it("refuses an address outside the allowed domains", async () => {
    idp.signInAs({ sub: "outsider", email: "outsider@elsewhere.test", email_verified: true, name: "外人" });
    const back = await signIn(server.client(), "oidc");
    expect(back.headers.get("location")).toContain("error=domain");
  });

  it("links a verified address to the existing account, and refuses an unverified one", async () => {
    await server.pool.query(`INSERT INTO pandocs.users (email, display_name) VALUES ('kept@example.test', '老账号')`);
    idp.signInAs({ sub: "unverified", email: "kept@example.test", email_verified: false, name: "冒名" });
    expect((await signIn(server.client(), "oidc")).headers.get("location")).toContain("error=email");
    idp.signInAs({ sub: "verified", email: "kept@example.test", email_verified: true, name: "老账号" });
    const person = server.client();
    await signIn(person, "oidc");
    expect((await person.json("GET", "/api/v1/account")).data.email).toBe("kept@example.test");
    const { rows } = await server.pool.query(`SELECT count(*)::int AS count FROM pandocs.users`);
    expect(rows[0].count).toBe(1);
  });

  it("rejects a callback whose state does not match the login in progress", async () => {
    idp.signInAs({ sub: "forged", email: "forged@example.test", email_verified: true, name: "伪造" });
    const person = server.client();
    const start = await person.request("/auth/oidc/start");
    const redirected = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const callback = new URL(redirected.headers.get("location")!);
    callback.searchParams.set("state", "forged-state");
    const back = await person.request(`${callback.pathname}${callback.search}`);
    expect(back.headers.get("location")).toContain("error=provider");
    expect(person.cookies.has("pandocs_session")).toBe(false);
  });

  it("rejects a callback with no login in progress", async () => {
    const back = await server.client().request("/auth/oidc/callback?code=x&state=y");
    expect(back.headers.get("location")).toContain("error=state");
  });

  it("signs in through plain OAuth2 too, reading the profile from its userinfo address", async () => {
    idp.signInAs({ sub: "ignored", email: "oauth@example.test", name: "OAuth 用户", groups: ["ops"] });
    const person = server.client();
    const back = await signIn(person, "oauth");
    expect(back.headers.get("location")).toBe("/handbook");
    expect((await person.json("GET", "/api/v1/account")).data).toMatchObject({ email: "oauth@example.test", displayName: "OAuth 用户", groups: ["ops"] });
  });

  it("does not let plain OAuth2 take over an account by address, since it vouches for nothing", async () => {
    await server.pool.query(`INSERT INTO pandocs.users (email, display_name) VALUES ('kept@example.test', '老账号')`);
    idp.signInAs({ sub: "ignored", email: "kept@example.test", name: "冒名" });
    expect((await signIn(server.client(), "oauth")).headers.get("location")).toContain("error=email");
  });
});

describe("administrators set by a group at the provider", () => {
  it("follows the group on every login, and the first person gets no special treatment", async () => {
    const idp = await startFakeIdp();
    const server = await startServer(postgres.getConnectionString(), {
      PANDOCS_OIDC_ISSUER: idp.issuer,
      PANDOCS_OIDC_CLIENT_ID: "pandocs",
      PANDOCS_OIDC_CLIENT_SECRET: "client-secret",
      PANDOCS_OIDC_ALLOW_HTTP: "true",
      PANDOCS_OIDC_ADMIN_GROUP: "pandocs-admins",
      PANDOCS_PASSWORD_LOGIN: "false"
    });
    try {
      await server.pool.query(`TRUNCATE pandocs.users CASCADE`);
      idp.signInAs({ sub: "plain", email: "plain@example.test", email_verified: true, name: "普通人", groups: [] });
      const plain = server.client();
      await signIn(plain, "oidc");
      expect((await plain.json("GET", "/api/v1/me")).data.isAdmin).toBe(false);
      idp.signInAs({ sub: "plain", email: "plain@example.test", email_verified: true, name: "普通人", groups: ["pandocs-admins"] });
      await signIn(plain, "oidc");
      expect((await plain.json("GET", "/api/v1/me")).data.isAdmin).toBe(true);
      const page = await (await server.client().request("/login")).text();
      expect(page).not.toContain('type="password"');
    } finally {
      await server.close();
      await idp.close();
    }
  });
});
