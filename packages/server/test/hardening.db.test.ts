import { connect } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { safeNext } from "../src/auth/routes.js";
import { listen } from "../src/listen.js";
import { startFakeSmtp } from "./fake-smtp.js";
import { ADMIN, PUBLIC_URL, signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const fresh = async (server: TestServer) => {
  await server.pool.query(`DROP SCHEMA pandocs CASCADE`);
  await (await import("../src/app.js")).migrate(server.pool);
};
const formOf = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** Everything a request can say is said by someone nobody knows yet. */
describe("what anyone can send to a server", () => {
  let server: TestServer;
  let admin: Client;
  let http: ReturnType<typeof listen>;
  let port = 0;

  /** A body of this many bytes, with no length given up front. Says whether it got to finish sending it, and what came back. */
  const chunked = (path: string, megabytes: number) =>
    new Promise<{ finished: boolean; answer: string }>(done => {
      let got = "";
      let finished = false;
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST ${path} HTTP/1.1\r\nHost: pandocs.test\r\nContent-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`
        );
        const chunk = Buffer.alloc(1024 * 1024, 97);
        let sent = 0;
        const push = () => {
          if (socket.destroyed) return;
          if (sent >= megabytes) {
            finished = true;
            socket.write("0\r\n\r\n");
            return;
          }
          sent += 1;
          socket.write(`${chunk.length.toString(16)}\r\n`);
          socket.write(chunk);
          socket.write("\r\n", () => setImmediate(push));
        };
        push();
      });
      socket.on("data", data => {
        got += String(data);
      });
      socket.on("close", () => done({ finished, answer: got }));
      // Being cut off on the way is the point.
      socket.on("error", () => undefined);
    });

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    await fresh(server);
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "open", name: "公开", defaultRole: "viewer" });
    await admin.json("POST", "/api/v1/spaces/open/documents", { title: "页", slug: "page", markdown: "正文\n" });
    await admin.json("PATCH", "/api/v1/spaces/open", { publicRead: true });
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port: 0 }, info => {
        port = info.port;
        done();
      });
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    http.closeAllConnections();
    await new Promise(done => http.close(done));
    await server.close();
  });

  describe("a body too long to keep in memory", () => {
    it("is refused from its stated length, before anything reads it", async () => {
      for (const path of [
        "/api/csp-report",
        "/login",
        "/setup",
        "/forgot-password",
        "/oauth/register",
        "/oauth/token",
        "/mcp/public",
        "/api/v1/stats/views",
        "/api/v1/ask"
      ]) {
        const answer = await new Promise<string>(done => {
          let got = "";
          const socket = connect(port, "127.0.0.1", () =>
            socket.write(
              `POST ${path} HTTP/1.1\r\nHost: pandocs.test\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 2147483648\r\nConnection: close\r\n\r\n`
            )
          );
          socket.on("data", data => {
            got += String(data);
            socket.destroy();
          });
          socket.on("close", () => done(got));
        });
        expect(answer.split("\r\n")[0], path).toContain("413");
      }
    });

    it("is cut off where it passes the limit, when it does not say how long it is", async () => {
      for (const [path, megabytes] of [
        ["/api/csp-report", 64],
        ["/login", 64],
        ["/oauth/token", 64],
        ["/api/v1/stats/views", 256]
      ] as const) {
        const { finished, answer } = await chunked(path, megabytes);
        // The connection may be gone before the answer is read, which is as good as hearing it.
        expect(finished, path).toBe(false);
        if (answer) expect(answer.split("\r\n")[0], path).toContain("413");
      }
      // Small ones get the same as with a length.
      expect((await chunked("/api/csp-report", 0)).answer.split("\r\n")[0]).toContain("204");
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    }, 60_000);

    it("still lets through what the site is for", async () => {
      const page = "第一段。\n\n".repeat(100_000);
      expect(
        (await admin.json("POST", "/api/v1/spaces/open/documents", { title: "长页面", slug: "long", markdown: page }))
          .status
      ).toBe(201);
      const picture = await admin.request("/api/v1/spaces/open/assets?filename=a.bin", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(12 * 1024 * 1024)
      });
      expect(picture.status).toBe(201);
      const tooBig = await admin.request("/api/v1/spaces/open/assets?filename=b.bin", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(200 * 1024 * 1024) }
      });
      expect(tooBig.status).toBe(413);
    }, 60_000);

    it("takes a large call to the public MCP endpoint, up to what that layer itself allows", async () => {
      // Past the 64 KiB kept for forms, within the 8 MiB the MCP layer takes: the gate must not refuse it first.
      const response = await fetch(`http://127.0.0.1:${port}/mcp/public`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { padding: "x".repeat(200 * 1024) }
        })
      });
      expect(response.status).not.toBe(413);
      expect(response.headers.get("content-type")).toContain("json");
    });
  });

  describe("an address or form that makes no sense", () => {
    it("gets an answer saying so, and nothing in the error log", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      for (const path of ["/api/v1/%", "/api/v1/documents/%", "/api/v1/spaces/%E0%A4%A/tree"])
        expect((await server.client().request(path)).status, path).toBe(404);
      for (const path of ["/login", "/setup"]) {
        for (const type of ["multipart/form-data", "multipart/form-data; boundary=x"]) {
          const answer = await server
            .client()
            .request(path, { method: "POST", headers: { "content-type": type }, body: "--x\r\nbroken" });
          expect(answer.status, `${path} ${type}`).toBe(303);
        }
      }
      expect(logged).not.toHaveBeenCalled();
    });
  });

  describe("what browsers report about a page's policy", () => {
    it("keeps secrets in addresses out of the log, and only so many of them", async () => {
      const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const report = (uri: string) =>
        server.client().request("/api/csp-report", {
          method: "POST",
          headers: { "content-type": "application/csp-report" },
          body: JSON.stringify({ "csp-report": { "document-uri": uri } })
        });
      expect((await report(`${PUBLIC_URL}/s/pds_abcdefghijklmnop/guide`)).status).toBe(204);
      // A guest's ticket travels in the address of an image or an event stream, and is as much a secret.
      expect((await report(`${PUBLIC_URL}/api/v1/events?ticket=pdg_eyJhIjoxfQ.c2lnbmF0dXJl`)).status).toBe(204);
      expect(logged.mock.calls.flat().join("\n")).toContain("web.csp_violation");
      expect(logged.mock.calls.flat().join("\n")).not.toContain("pds_abcdefghijklmnop");
      expect(logged.mock.calls.flat().join("\n")).not.toContain("eyJhIjoxfQ");
      logged.mockClear();
      for (let count = 0; count < 200; count += 1) await report(`${PUBLIC_URL}/open/page`);
      expect(logged.mock.calls.length).toBeLessThan(100);
    });
  });

  describe("somewhere to go after signing in", () => {
    it("is only ever on this site, however it is spelled", () => {
      for (const next of [
        "https://evil.example",
        "//evil.example",
        "/\\evil.example",
        "/\t/evil.example",
        "/..//evil.example",
        "/.//evil.example",
        "/a/..//evil.example",
        "/\n/evil.example",
        "\t//evil.example",
        "/\r\n/evil.example",
        " //evil.example",
        "/\\/evil.example",
        "javascript:alert(1)",
        ""
      ])
        expect(safeNext(next), JSON.stringify(next)).toBe("/");
      for (const next of [
        "/login",
        "/logout",
        "/setup",
        "/auth/x/start",
        "/forgot-password",
        "/set-password/x",
        "/\t/login"
      ])
        expect(safeNext(next), next).toBe("/");
      expect(safeNext("/handbook/guide?mode=edit#part")).toBe("/handbook/guide?mode=edit#part");
      expect(safeNext("/oauth/authorize?client_id=a&state=b%20c")).toBe("/oauth/authorize?client_id=a&state=b%20c");
    });

    it("does not send someone elsewhere who follows a crafted link while signed in", async () => {
      const crafted = await admin.request(`/login?next=${encodeURIComponent("/\t/evil.example")}`);
      expect(crafted.status).toBe(302);
      expect(crafted.headers.get("location")).toBe("/");
    });
  });

  describe("signing in from another site's page", () => {
    it("is refused, so nobody ends up working in an account someone else chose", async () => {
      const visitor = server.client();
      for (const headers of [
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
        { origin: "https://evil.example" }
      ]) {
        const answer = await visitor.request("/login", {
          method: "POST",
          headers: { ...FORM, host: "pandocs.test", ...headers },
          body: formOf({ email: ADMIN.email, password: ADMIN.password, next: "/" })
        });
        expect(answer.status, JSON.stringify(headers)).toBe(403);
        expect(visitor.cookies.size).toBe(0);
      }
      const signedIn = server.client();
      const out = await signedIn.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/" });
      expect(out.status).toBe(303);
      expect(
        (await signedIn.request("/logout", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status
      ).toBe(403);
      expect((await signedIn.json("GET", "/api/v1/account")).status).toBe(200);
    });

    it("works from this site, whichever address it is reached by", async () => {
      for (const headers of [
        { "sec-fetch-site": "same-origin" },
        { origin: PUBLIC_URL },
        { origin: "http://192.168.1.20:8080", host: "192.168.1.20:8080" }
      ]) {
        const person = server.client();
        const answer = await person.request("/login", {
          method: "POST",
          headers: { ...FORM, ...headers },
          body: formOf({ email: ADMIN.email, password: ADMIN.password, next: "/" })
        });
        expect(answer.status, JSON.stringify(headers)).toBe(303);
        expect(person.cookies.size).toBe(1);
      }
    });
  });

  describe("changing a password", () => {
    it("signs out everywhere else, and not here", async () => {
      await admin.json("POST", "/api/v1/admin/users", {
        email: "changer@example.test",
        displayName: "改密码的人",
        password: "the-first-password"
      });
      const here = server.client();
      const elsewhere = server.client();
      await here.form("/login", { email: "changer@example.test", password: "the-first-password", next: "/" });
      await elsewhere.form("/login", { email: "changer@example.test", password: "the-first-password", next: "/" });
      expect(
        (
          await here.json("POST", "/api/v1/account/password", {
            current: "the-first-password",
            next: "the-second-password"
          })
        ).status
      ).toBe(200);
      expect((await here.json("GET", "/api/v1/account")).status).toBe(200);
      expect((await elsewhere.json("GET", "/api/v1/account")).status).toBe(401);
    });
  });

  describe("a token that can only read", () => {
    it("reads what its administrator can, and changes nothing about the site", async () => {
      const { token } = (await admin.json("POST", "/api/v1/account/tokens", { name: "只读", scopes: ["read"] }))
        .data as { token: string };
      const auth = { authorization: `Bearer ${token}` };
      const tool = server.client();
      expect((await tool.json("GET", "/api/v1/spaces/open", undefined, auth)).status).toBe(200);
      expect((await tool.json("GET", "/api/v1/audit", undefined, auth)).status).toBe(200);
      const attempts: [string, string, unknown][] = [
        ["PATCH", "/api/v1/site", { title: "改掉" }],
        ["POST", "/api/v1/spaces", { slug: "made-by-reader", name: "只读令牌建的" }],
        ["DELETE", "/api/v1/spaces/open", undefined],
        ["POST", "/api/v1/webhooks", { name: "钩子", kind: "generic", url: "https://hooks.example.test/x" }],
        ["POST", "/api/v1/deleted-spaces/00000000-0000-0000-0000-000000000000/restore", undefined]
      ];
      for (const [method, path, body] of attempts)
        expect((await tool.json(method, path, body, auth)).status, `${method} ${path}`).toBe(403);
      const hook = await admin.json("POST", "/api/v1/webhooks", {
        name: "已有的钩子",
        kind: "generic",
        url: "https://hooks.example.test/x"
      });
      expect((await tool.json("DELETE", `/api/v1/webhooks/${hook.data.id}`, undefined, auth)).status).toBe(403);
      expect((await tool.json("GET", `/api/v1/webhooks/${hook.data.id}/deliveries`, undefined, auth)).status).toBe(200);
      expect((await admin.json("GET", "/api/v1/spaces/open")).status).toBe(200);
      expect((await tool.json("GET", "/api/v1/site", undefined, auth)).data.title).not.toBe("改掉");
    });
  });

  describe("the record of what happened", () => {
    it("says who added, changed and let in whom, and never any password", async () => {
      const made = await admin.json("POST", "/api/v1/admin/users", {
        email: "recorded@example.test",
        displayName: "被记录的人",
        isAdmin: true,
        password: "secret-password-1"
      });
      await admin.json("PATCH", `/api/v1/admin/users/${made.data.id}`, {
        isAdmin: false,
        password: "secret-password-2"
      });
      await admin.json("POST", `/api/v1/admin/users/${made.data.id}/password-link`);
      await admin.json("PATCH", `/api/v1/admin/users/${made.data.id}`, { status: "disabled" });
      const app = await admin.json("POST", "/api/v1/admin/embed-apps", {
        slug: "helpdesk",
        name: "服务台",
        allowedOrigins: ["https://helpdesk.example.test"]
      });
      await admin.json("POST", "/api/v1/admin/embed-apps/helpdesk/secret");
      await admin.json("DELETE", "/api/v1/admin/embed-apps/helpdesk");
      expect(app.status).toBe(201);
      const { data } = await admin.json("GET", "/api/v1/audit?category=space&limit=50");
      const actions = (data as { action: string; actorName: string; detail: object }[]).map(event => event.action);
      for (const action of [
        "site.user.create",
        "site.user.update",
        "site.user.password_link",
        "site.embed_app.create",
        "site.embed_app.secret",
        "site.embed_app.delete"
      ])
        expect(actions, action).toContain(action);
      const text = JSON.stringify(data);
      expect(text).toContain("recorded@example.test");
      expect(text).not.toContain("secret-password");
      expect(text).not.toContain("pda_");
      expect(text).not.toContain("/set-password/");
    });
  });
});

describe("guessing at passwords through a proxy", () => {
  let server: TestServer;

  const attempt = (email: string, forwardedFor: string) =>
    server.client().request("/login", {
      method: "POST",
      headers: { ...FORM, "x-forwarded-for": forwardedFor },
      body: formOf({ email, password: "wrong-password", next: "/" })
    });
  const throttled = (answer: Response) => (answer.headers.get("location") ?? "").includes("error=throttled");
  const failures = async (key: string) =>
    (await server.pool.query<{ failures: number }>(`SELECT failures FROM pandocs.login_attempts WHERE key = $1`, [key]))
      .rows[0]?.failures ?? 0;

  afterEach(async () => {
    await server.close();
  });

  const start = async (env: Record<string, string>) => {
    server = await startServer(postgres.getConnectionString(), env);
    await fresh(server);
    await signInFirstAdmin(server);
  };

  it("counts by the address the proxy saw, not one the client wrote in the header", async () => {
    await start({ PANDOCS_TRUST_PROXY: "true" });
    for (let count = 0; count < 3; count += 1) await attempt(ADMIN.email, `10.0.0.${count}, 203.0.113.9`);
    expect(await failures(`password:${ADMIN.email}:203.0.113.9`)).toBe(3);
    expect(await failures(`password:${ADMIN.email}:10.0.0.1`)).toBe(0);
  });

  it("can be told there are more proxies in front", async () => {
    await start({ PANDOCS_TRUST_PROXY: "2" });
    await attempt(ADMIN.email, "10.0.0.1, 203.0.113.9, 198.51.100.7");
    expect(await failures(`password:${ADMIN.email}:203.0.113.9`)).toBe(1);
    // Fewer than it was told: nothing it can say is any better than the first.
    await attempt(ADMIN.email, "203.0.113.10");
    expect(await failures(`password:${ADMIN.email}:203.0.113.10`)).toBe(1);
  });

  it("ignores the header when nothing says a proxy is there", async () => {
    await start({});
    await attempt(ADMIN.email, "203.0.113.9");
    expect(await failures(`password:${ADMIN.email}:203.0.113.9`)).toBe(0);
  });

  it("stops someone trying many accounts from one address, or one account from many", async () => {
    await start({ PANDOCS_TRUST_PROXY: "true" });
    await server.pool.query(
      `INSERT INTO pandocs.login_attempts (key, failures, window_start) VALUES ($1, 100, now())`,
      ["password-address:203.0.113.9"]
    );
    expect(throttled(await attempt("anyone@example.test", "203.0.113.9"))).toBe(true);
    expect(throttled(await attempt("anyone@example.test", "203.0.113.10"))).toBe(false);
    await server.pool.query(
      `INSERT INTO pandocs.login_attempts (key, failures, window_start) VALUES ($1, 100, now())`,
      ["password-account:victim@example.test"]
    );
    expect(throttled(await attempt("VICTIM@example.test", "203.0.113.11"))).toBe(true);
  });

  it("keeps nothing for an address too long to be one", async () => {
    await start({ PANDOCS_TRUST_PROXY: "true" });
    const answer = await attempt(`${"x".repeat(5000)}@example.test`, "203.0.113.9");
    expect(answer.headers.get("location") ?? "").toContain("error=credentials");
    expect(
      (await server.pool.query(`SELECT 1 FROM pandocs.login_attempts WHERE length(key) > 1000`)).rows
    ).toHaveLength(0);
  });
});

describe("forgetting a password, with a company account", () => {
  it("does not hand a password to someone whose way in is the company's login", async () => {
    const mail = await startFakeSmtp();
    const server = await startServer(postgres.getConnectionString(), mail.env);
    try {
      await fresh(server);
      await signInFirstAdmin(server);
      const company = await server.runtime.users.create({ email: "company@example.test", displayName: "企业账号的人" });
      await server.runtime.users.linkIdentity("https://idp.example.test", "sub-1", company.id);
      await server.runtime.users.create({ email: "invited@example.test", displayName: "还没设密码的人" });
      await server.client().form("/forgot-password", { email: "company@example.test" });
      await server.client().form("/forgot-password", { email: "invited@example.test" });
      await vi.waitFor(() => expect(mail.inbox.map(item => item.to)).toEqual(["invited@example.test"]));
      await new Promise(done => setTimeout(done, 200));
      expect(mail.inbox.map(item => item.to)).toEqual(["invited@example.test"]);
    } finally {
      await server.close();
      await mail.close();
    }
  });
});
