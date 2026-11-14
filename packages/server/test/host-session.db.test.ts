import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { readConfig } from "../src/config.js";
import { startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const SITE = "http://pandocs.test/docs";
const HOST_LOGIN = "https://example.test/login";

/** The site this one lives beside: it knows its sessions, and wraps what it says the way many do. */
const PEOPLE: Readonly<Record<string, object | number>> = {
  "s-ana": {
    code: 0,
    data: { user: { uid: "u-1", nick: "Ana", mail: "ana@example.test", roles: ["docs-admin", "staff"] } }
  },
  "s-bo": { code: 0, data: { user: { uid: "u-2", nick: "Bo", roles: ["staff"] } } },
  "s-bo-again": { code: 0, data: { user: { uid: "u-2", nick: "Bo", roles: ["staff"] } } },
  "s-gone": 401
};

describe("signing in with the session of the site this one lives beside", () => {
  let host: Server;
  let server: TestServer;
  const asked: string[] = [];

  const person = (session: string): Client => {
    const client = server.client();
    client.cookies.set("main_sid", session);
    client.cookies.set("theirs", "nothing-to-do-with-us");
    return client;
  };

  beforeAll(async () => {
    host = createServer((request, response) => {
      asked.push(request.headers.cookie ?? "");
      const session = /(?:^|;\s*)main_sid=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1];
      const answer = session ? PEOPLE[session] : undefined;
      if (answer === undefined || typeof answer === "number") response.writeHead(answer ?? 401).end();
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
    await new Promise<void>(done => host.listen(0, "127.0.0.1", done));
    server = await startServer(postgres.getConnectionString(), {
      PANDOCS_URL: SITE,
      PANDOCS_PASSWORD_LOGIN: "false",
      PANDOCS_HOST_SESSION_URL: `http://127.0.0.1:${(host.address() as AddressInfo).port}/api/me`,
      PANDOCS_HOST_SESSION_COOKIES: "main_sid",
      PANDOCS_HOST_LOGIN_URL: `${HOST_LOGIN}?back={url}`,
      PANDOCS_HOST_LOGOUT_URL: "https://example.test/logout",
      PANDOCS_HOST_NAME: "主站",
      PANDOCS_HOST_SUBJECT_CLAIM: "data.user.uid",
      PANDOCS_HOST_NAME_CLAIM: "data.user.nick",
      PANDOCS_HOST_EMAIL_CLAIM: "data.user.mail",
      PANDOCS_HOST_GROUPS_CLAIM: "data.user.roles",
      PANDOCS_HOST_ADMIN_GROUP: "docs-admin"
    });
  });
  afterAll(async () => {
    await server.close();
    await new Promise(done => host.close(done));
  });

  it("knows people by the host's session, with an account made for them and no password", async () => {
    const ana = person("s-ana");
    expect((await ana.json("GET", "/docs/api/v1/me")).data).toMatchObject({ displayName: "Ana", isAdmin: true });
    expect(asked).toEqual(["main_sid=s-ana"]);
    await ana.json("GET", "/docs/api/v1/me");
    expect(asked).toHaveLength(1);
    const { rows } = await server.pool.query(
      `SELECT email, groups, password_hash FROM pandocs.users WHERE display_name = 'Ana'`
    );
    expect(rows).toEqual([{ email: "ana@example.test", groups: ["docs-admin", "staff"], password_hash: null }]);
  });

  it("gives someone the host knows without an address one that no mail goes to", async () => {
    const bo = person("s-bo");
    expect((await bo.json("GET", "/docs/api/v1/me")).data).toMatchObject({ displayName: "Bo", isAdmin: false });
    const { rows } = await server.pool.query(`SELECT email FROM pandocs.users WHERE display_name = 'Bo'`);
    expect(rows[0].email).toBe("u-2@127.0.0.1.invalid");
  });

  it("sends someone with no session to sign in at the host, and back to the same page", async () => {
    const visitor = server.client();
    const page = await visitor.request("/docs/_/inbox");
    expect(page.headers.get("location")).toBe(`/docs/login?${new URLSearchParams({ next: "/_/inbox" })}`);
    const login = await visitor.request("/docs/login?next=%2F_%2Finbox");
    expect(login.headers.get("location")).toBe(`${HOST_LOGIN}?back=${encodeURIComponent(`${SITE}/_/inbox`)}`);
    const dialog = await visitor.request("/docs/login", { headers: { accept: "application/json" } });
    expect((await dialog.json()).data).toMatchObject({
      signedIn: false,
      passwordLogin: false,
      providers: [{ id: "host", name: "主站" }]
    });
    const fromDialog = await visitor.request("/docs/auth/host/start?next=%2Fhandbook");
    expect(fromDialog.headers.get("location")).toBe(`${HOST_LOGIN}?back=${encodeURIComponent(`${SITE}/handbook`)}`);
    expect((await person("s-ana").json("GET", "/docs/api/v1/bootstrap")).data.site.logoutUrl).toBe(
      "https://example.test/logout"
    );
  });

  it("turns away sessions the host does not know, and writes other sites ask for", async () => {
    expect((await person("s-gone").json("GET", "/docs/api/v1/me")).status).toBe(401);
    const across = await person("s-ana").json(
      "POST",
      "/docs/api/v1/spaces",
      { slug: "across", name: "Across" },
      { "sec-fetch-site": "cross-site" }
    );
    expect(across.status).toBe(403);
  });

  it("leaves out someone disabled here, whatever the host says", async () => {
    const ana = person("s-ana");
    const { data: people } = await ana.json("GET", "/docs/api/v1/admin/users");
    const bo = (people as { id: string; displayName: string }[]).find(user => user.displayName === "Bo")!;
    expect((await ana.json("PATCH", `/docs/api/v1/admin/users/${bo.id}`, { status: "disabled" })).status).toBe(200);
    expect((await person("s-bo-again").json("GET", "/docs/api/v1/me")).status).toBe(401);
  });

  it("is set up with the cookies to send, which keep their case", () => {
    const env = { DATABASE_URL: "postgres://x/y", PANDOCS_PASSWORD_LOGIN: "false" };
    expect(() => readConfig(env)).toThrow(/nobody could sign in/u);
    expect(
      readConfig({
        ...env,
        PANDOCS_HOST_SESSION_URL: "https://example.test/api/me",
        PANDOCS_HOST_SESSION_COOKIES: "SID, Remember"
      }).hostSession
    ).toMatchObject({ cookies: ["SID", "Remember"], name: "example.test", subjectClaim: "id", cacheSeconds: 60 });
    expect(() => readConfig({ ...env, PANDOCS_HOST_SESSION_URL: "https://example.test/api/me" })).toThrow(
      /PANDOCS_HOST_SESSION_COOKIES/u
    );
    expect(() =>
      readConfig({
        ...env,
        PANDOCS_HOST_SESSION_URL: "https://example.test/api/me",
        PANDOCS_HOST_SESSION_COOKIES: "a b"
      })
    ).toThrow(/no cookie can have/u);
  });
});
