import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { listen } from "../src/listen.js";
import { ADMIN, signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const hasGo = spawnSync("go", ["version"]).status === 0;
const REDIRECT = "http://127.0.0.1:43123/callback";

const freePort = () =>
  new Promise<number>(done => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });

/** Stands in for an app like an AI assistant: this is the interface the official SDK asks such apps to implement. */
class TestProvider implements OAuthClientProvider {
  info: any;
  saved: any;
  verifier = "";
  authUrl: URL | null = null;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return {
      redirect_uris: [REDIRECT],
      client_name: "测试助手",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: unknown) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: unknown) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const hiddenFields = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)].map(match => [
      match[1]!,
      match[2]!.replace(/&#(\d+);/gu, (_, code) => String.fromCharCode(Number(code)))
    ])
  );

describe("connecting an app by signing in", () => {
  let server: TestServer;
  let admin: Client;
  let http: ReturnType<typeof listen>;
  let origin = "";
  let pageId = "";

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };
  const register = async (body: object = { redirect_uris: [REDIRECT], client_name: "脚本" }) =>
    await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  const newClient = async (body?: object) => {
    await server.pool.query(`DELETE FROM pandocs.login_attempts`);
    return ((await (await register(body)).json()) as { client_id: string }).client_id;
  };
  const authorizePath = (clientId: string, challenge: string, extra: Record<string, string> = {}) =>
    `/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "abc", ...extra })}`;
  const token = (fields: Record<string, string>) =>
    fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString()
    });

  /** Goes through the page and says yes, as the person would. */
  const approve = async (person: Client, path: string, decision = "allow") => {
    const page = await person.request(path);
    expect(page.status).toBe(200);
    const answer = await person.form("/oauth/authorize", { ...hiddenFields(await page.text()), decision });
    expect(answer.status).toBe(303);
    return new URL(answer.headers.get("location")!);
  };
  const signedIn = async (clientId: string, person: Client = admin, extra: Record<string, string> = {}) => {
    const { verifier, challenge } = pkce();
    const back = await approve(person, authorizePath(clientId, challenge, extra));
    const answer = await token({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier
    });
    expect(answer.status).toBe(200);
    return (await answer.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
      token_type: string;
    };
  };
  const whoAmI = (accessToken: string) =>
    fetch(`${origin}/api/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } });

  beforeAll(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    server = await startServer(postgres.getConnectionString(), { PANDOCS_URL: origin });
    admin = await signInFirstAdmin(server);
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port }, () => done());
    });
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "书店", defaultRole: "viewer" });
    pageId = (
      await admin.json("POST", "/api/v1/spaces/shop/documents", {
        title: "页面",
        slug: "page",
        markdown: "# 页面\n\n内容。\n"
      })
    ).data.document.id;
  });
  afterAll(async () => {
    await new Promise(done => http.close(done));
    await server.close();
  });

  it("works from start to finish with the official MCP client", async () => {
    const provider = new TestProvider();
    const first = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
    await expect(new McpClient({ name: "测试", version: "1" }).connect(first as never)).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(provider.info.client_id).toMatch(/^pdc_/u);
    expect(provider.authUrl!.origin).toBe(origin);

    const back = await approve(admin, `${provider.authUrl!.pathname}${provider.authUrl!.search}`);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    await first.finishAuth(back.searchParams.get("code")!);
    expect(provider.saved.access_token).toMatch(/^pd_/u);

    const client = new McpClient({ name: "测试", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider }) as never
    );
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain("doc_get");
    expect(names).toContain("proposal_create");
    // It connects as an agent: it can suggest, and a person decides.
    expect(names).not.toContain("doc_save");
    const read = await client.callTool({ name: "doc_get", arguments: { doc: pageId } });
    expect(read.isError ?? false).toBe(false);
    expect(JSON.stringify(read.structuredContent)).toContain("内容");
    await client.close();
  }, 30_000);

  describe("what a client finds out by itself", () => {
    it("is told where to go when it has no token, or a bad one", async () => {
      for (const headers of [{}, { authorization: "Bearer pd_not_real" }]) {
        const answer = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        });
        expect(answer.status).toBe(401);
        expect(answer.headers.get("www-authenticate")).toBe(
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
        );
      }
    });

    it("can read the published descriptions, from a browser too", async () => {
      const resource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
      expect(await resource.json()).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      expect(resource.headers.get("access-control-allow-origin")).toBe("*");
      const metadata = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<
        string,
        unknown
      >;
      expect(metadata).toMatchObject({
        issuer: origin,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        authorization_response_iss_parameter_supported: true
      });
      expect((await fetch(`${origin}/oauth/token`, { method: "OPTIONS" })).status).toBe(204);
      expect((await fetch(`${origin}/oauth/revoke`, { method: "OPTIONS" })).status).toBe(204);
    });
  });

  describe("registering", () => {
    it("takes web, loopback and an app's own scheme, and nothing that runs code", async () => {
      for (const uri of [
        "https://app.example.com/cb",
        "http://localhost:1234/cb",
        "http://127.0.0.1/cb",
        "http://[::1]:8/cb",
        "cursor://anysphere.cursor-mcp/oauth/callback"
      ]) {
        expect((await register({ redirect_uris: [uri] })).status, uri).toBe(201);
      }
    });

    it("refuses addresses that are not safe to send a code to", async () => {
      for (const uri of [
        "javascript:alert(1)",
        "data:text/html,x",
        "http://app.example.com/cb",
        "file:///etc/passwd",
        "https://app.example.com/cb#fragment",
        "not a url"
      ]) {
        expect((await register({ redirect_uris: [uri] })).status, uri).toBe(400);
      }
      expect(
        (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" })).status
      ).toBe(400);
      expect((await register({ redirect_uris: [] })).status).toBe(400);
    });
  });

  describe("asking", () => {
    it("does not go anywhere for a client or address it does not know", async () => {
      const { challenge } = pkce();
      const unknown = await admin.request(authorizePath("pdc_nobody", challenge));
      expect(unknown.status).toBe(400);
      expect(unknown.headers.get("location")).toBeNull();
      const clientId = await newClient();
      const wrong = await admin.request(
        authorizePath(clientId, challenge, { redirect_uri: "https://evil.example.com/steal" })
      );
      expect(wrong.status).toBe(400);
      expect(wrong.headers.get("location")).toBeNull();
    });

    it("tells the app what is wrong with a request, once it knows where to send that", async () => {
      const clientId = await newClient();
      const { challenge } = pkce();
      const errorOf = async (extra: Record<string, string>) =>
        new URL(
          (await admin.request(authorizePath(clientId, challenge, extra))).headers.get("location")!
        ).searchParams.get("error");
      expect(await errorOf({ code_challenge_method: "plain" })).toBe("invalid_request");
      expect(await errorOf({ code_challenge: "short" })).toBe("invalid_request");
      expect(await errorOf({ response_type: "token" })).toBe("unsupported_response_type");
      expect(await errorOf({ scope: "admin" })).toBe("invalid_scope");
      expect(await errorOf({ resource: "https://other.example.com/mcp" })).toBe("invalid_target");
    });

    it("sends someone not signed in to log in, and back again", async () => {
      const clientId = await newClient();
      const { challenge } = pkce();
      const path = authorizePath(clientId, challenge);
      const visitor = server.client();
      const answer = await visitor.request(path);
      expect(answer.status).toBe(302);
      const login = new URL(answer.headers.get("location")!, origin);
      expect(login.pathname).toBe("/login");
      expect(login.searchParams.get("next")).toBe(path);
      const signed = await visitor.form("/login", {
        email: ADMIN.email,
        password: ADMIN.password,
        next: login.searchParams.get("next")!
      });
      expect(signed.headers.get("location")).toBe(path);
      expect((await visitor.request(path)).status).toBe(200);
    });
  });

  describe("the page where someone says yes", () => {
    it("says plainly who is asking and what for, and cannot be framed or scripted", async () => {
      const clientId = await newClient({ redirect_uris: [REDIRECT], client_name: "<img src=x onerror=alert(1)>" });
      const { challenge } = pkce();
      const page = await admin.request(authorizePath(clientId, challenge));
      const html = await page.text();
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&#60;img src=x");
      expect(html).toContain(REDIRECT);
      expect(html).toContain("someone with edit access");
      // The name is whatever the app said it was.
      expect(html).toContain("Any app can register itself under any name");
      const policy = page.headers.get("content-security-policy")!;
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("default-src 'none'");
      expect(policy).not.toContain("script-src");
      // Browsers hold the redirect after a form to this as well, so the way back has to be on it.
      expect(policy).toContain(`form-action 'self' ${new URL(REDIRECT).origin}`);
    });

    it("allows an app's own scheme to be gone back to", async () => {
      const uri = "cursor://anysphere.cursor-mcp/oauth/callback";
      const clientId = await newClient({ redirect_uris: [uri], client_name: "编辑器" });
      const { challenge } = pkce();
      const page = await admin.request(authorizePath(clientId, challenge, { redirect_uri: uri }));
      expect(page.headers.get("content-security-policy")).toContain("form-action 'self' cursor:");
    });

    it("passes on a no", async () => {
      const clientId = await newClient();
      const { challenge } = pkce();
      const back = await approve(admin, authorizePath(clientId, challenge), "deny");
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("state")).toBe("abc");
      expect(back.searchParams.has("code")).toBe(false);
      expect(back.searchParams.get("iss")).toBe(origin);
    });

    it("says who the answer is from, for an app connected to several servers", async () => {
      const clientId = await newClient();
      const { challenge } = pkce();
      const back = await approve(admin, authorizePath(clientId, challenge));
      expect(back.searchParams.get("code")).toBeTruthy();
      expect(back.searchParams.get("iss")).toBe(origin);
    });

    it("does not take a yes that did not come from that page, for that person", async () => {
      const clientId = await newClient();
      const { challenge } = pkce();
      const fields = hiddenFields(await (await admin.request(authorizePath(clientId, challenge))).text());

      expect((await admin.form("/oauth/authorize", { ...fields, proof: "forged", decision: "allow" })).status).toBe(
        400
      );
      expect((await admin.form("/oauth/authorize", { ...fields, scope: "read", decision: "allow" })).status).toBe(400);
      const fromElsewhere = await admin.request("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
        body: new URLSearchParams({ ...fields, decision: "allow" }).toString()
      });
      expect(fromElsewhere.status).toBe(400);
      expect((await server.client().form("/oauth/authorize", { ...fields, decision: "allow" })).status).toBe(400);

      await admin.json("POST", "/api/v1/admin/users", {
        email: "other@example.test",
        displayName: "另一个人",
        password: "other-password-123"
      });
      const other = server.client();
      await other.form("/login", { email: "other@example.test", password: "other-password-123", next: "/" });
      expect((await other.form("/oauth/authorize", { ...fields, decision: "allow" })).status).toBe(400);
    });
  });

  describe("the code", () => {
    const issueCode = async (clientId: string, extra: Record<string, string> = {}) => {
      const { verifier, challenge } = pkce();
      const back = await approve(admin, authorizePath(clientId, challenge, extra));
      return { code: back.searchParams.get("code")!, verifier };
    };
    const redeem = (clientId: string, code: string, verifier: string, redirect = REDIRECT) =>
      token({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirect,
        code_verifier: verifier
      });

    it("works once", async () => {
      const clientId = await newClient();
      const { code, verifier } = await issueCode(clientId);
      expect((await redeem(clientId, code, verifier)).status).toBe(200);
      const again = await redeem(clientId, code, verifier);
      expect(again.status).toBe(400);
      expect(await again.json()).toEqual({ error: "invalid_grant" });
    });

    it("takes back what it was exchanged for when it comes again", async () => {
      const clientId = await newClient();
      const { code, verifier } = await issueCode(clientId);
      const first = (await (await redeem(clientId, code, verifier)).json()) as {
        access_token: string;
        refresh_token: string;
      };
      expect((await whoAmI(first.access_token)).status).toBe(200);
      expect((await redeem(clientId, code, verifier)).status).toBe(400);
      expect((await whoAmI(first.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId })).status
      ).toBe(400);
    });

    it("needs the secret that only whoever started this has", async () => {
      const clientId = await newClient();
      const { code } = await issueCode(clientId);
      expect((await redeem(clientId, code, pkce().verifier)).status).toBe(400);
      // A wrong guess uses it up, so it cannot be guessed at.
      const second = await issueCode(clientId);
      expect((await redeem(clientId, second.code, "wrong")).status).toBe(400);
      expect((await redeem(clientId, second.code, second.verifier)).status).toBe(400);
    });

    it("is for that client and that address alone", async () => {
      const clientId = await newClient();
      const other = await newClient();
      const forOther = await issueCode(clientId);
      expect((await redeem(other, forOther.code, forOther.verifier)).status).toBe(400);
      const wrongAddress = await issueCode(clientId);
      expect(
        (await redeem(clientId, wrongAddress.code, wrongAddress.verifier, "http://127.0.0.1:43123/other")).status
      ).toBe(400);
    });

    it("runs out quickly", async () => {
      const clientId = await newClient();
      const { code, verifier } = await issueCode(clientId);
      await server.pool.query(`UPDATE pandocs.oauth_codes SET expires_at = now() - interval '1 second'`);
      expect((await redeem(clientId, code, verifier)).status).toBe(400);
    });

    it("lets a native app come back on whatever port it got", async () => {
      const clientId = await newClient({ redirect_uris: ["http://127.0.0.1:1234/callback"], client_name: "本地工具" });
      const { verifier, challenge } = pkce();
      const uri = "http://127.0.0.1:55555/callback";
      const back = await approve(admin, authorizePath(clientId, challenge, { redirect_uri: uri }));
      expect(back.port).toBe("55555");
      expect((await redeem(clientId, back.searchParams.get("code")!, verifier, uri)).status).toBe(200);
      const elsewhere = await admin.request(
        authorizePath(clientId, challenge, { redirect_uri: "http://127.0.0.1:55555/other" })
      );
      expect(elsewhere.status).toBe(400);
    });
  });

  describe("the tokens", () => {
    it("are short-lived agent tokens, and asking for less gets less", async () => {
      const clientId = await newClient();
      const granted = await signedIn(clientId);
      expect(granted).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read write" });
      const me = (await (await whoAmI(granted.access_token)).json()) as { data: { kind: string; displayName: string } };
      expect(me.data.kind).toBe("agent");
      expect(me.data.displayName).toContain("脚本");
      const saved = await fetch(`${origin}/api/v1/documents/${pageId}/content`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${granted.access_token}`,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID()
        },
        body: JSON.stringify({ markdown: "改\n", expectedRevision: 1 })
      });
      expect(saved.status).toBe(403);

      const readOnly = await signedIn(clientId, admin, { scope: "read" });
      expect(readOnly.scope).toBe("read");
      const proposed = await fetch(`${origin}/api/v1/documents/${pageId}/threads`, {
        method: "POST",
        headers: { authorization: `Bearer ${readOnly.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ anchor: { kind: "document" }, body: "只读" })
      });
      expect(proposed.status).toBe(403);
    });

    it("do not clutter the list of tokens someone made by hand", async () => {
      const clientId = await newClient({ redirect_uris: [REDIRECT], client_name: "不在令牌列表里" });
      await signedIn(clientId);
      const listed = (await admin.json("GET", "/api/v1/account/tokens")).data as { name: string }[];
      expect(listed.map(item => item.name)).not.toContain("不在令牌列表里");
      const apps = (await admin.json("GET", "/api/v1/account/connected-apps")).data as { clientName: string }[];
      expect(apps.map(item => item.clientName)).toContain("不在令牌列表里");
    });

    it("can be renewed, which replaces both, and each refresh token works once", async () => {
      const clientId = await newClient();
      const first = await signedIn(clientId);
      const renewed = await token({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: clientId
      });
      expect(renewed.status).toBe(200);
      const second = (await renewed.json()) as { access_token: string; refresh_token: string };
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect((await whoAmI(second.access_token)).status).toBe(200);
      expect((await whoAmI(first.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId })).status
      ).toBe(400);
      expect(
        (
          await token({
            grant_type: "refresh_token",
            refresh_token: second.refresh_token,
            client_id: await newClient()
          })
        ).status
      ).toBe(400);
    });

    it("end for everyone when a refresh token comes back after it was spent, since it must have been copied", async () => {
      const clientId = await newClient({ redirect_uris: [REDIRECT], client_name: "被人复制了令牌" });
      const app = await signedIn(clientId);
      // Someone with a copy renews first, and holds the grant now.
      const copied = (await (
        await token({ grant_type: "refresh_token", refresh_token: app.refresh_token, client_id: clientId })
      ).json()) as { access_token: string; refresh_token: string };
      expect((await whoAmI(copied.access_token)).status).toBe(200);
      // The app renews with what it has, which no longer works, and that ends the grant for whoever has it.
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: app.refresh_token, client_id: clientId })).status
      ).toBe(400);
      expect((await whoAmI(copied.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: copied.refresh_token, client_id: clientId })).status
      ).toBe(400);
      const apps = (await admin.json("GET", "/api/v1/account/connected-apps")).data as { clientName: string }[];
      expect(apps.map(item => item.clientName)).not.toContain("被人复制了令牌");
    });

    it("can be given up by the app itself, by either token, and nothing is said about one that does not fit", async () => {
      const revoke = (fields: Record<string, string>) =>
        fetch(`${origin}/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields)
        });
      const clientId = await newClient();
      const byRefresh = await signedIn(clientId);
      const other = await newClient();
      // Another app cannot end it, and is told nothing either way.
      expect((await revoke({ token: byRefresh.refresh_token, client_id: other })).status).toBe(200);
      expect((await whoAmI(byRefresh.access_token)).status).toBe(200);
      const answer = await revoke({
        token: byRefresh.refresh_token,
        client_id: clientId,
        token_type_hint: "refresh_token"
      });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("access-control-allow-origin")).toBe("*");
      expect((await whoAmI(byRefresh.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: byRefresh.refresh_token, client_id: clientId }))
          .status
      ).toBe(400);

      const byAccess = await signedIn(clientId);
      expect((await revoke({ token: byAccess.access_token, client_id: clientId })).status).toBe(200);
      expect((await whoAmI(byAccess.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: byAccess.refresh_token, client_id: clientId }))
          .status
      ).toBe(400);

      expect((await revoke({ token: "not-a-token", client_id: clientId })).status).toBe(200);
      expect((await revoke({ client_id: clientId })).status).toBe(400);
    });

    it("stop as soon as someone disconnects the app", async () => {
      const clientId = await newClient({ redirect_uris: [REDIRECT], client_name: "要断开" });
      const granted = await signedIn(clientId);
      const apps = (await admin.json("GET", "/api/v1/account/connected-apps")).data as {
        id: string;
        clientName: string;
      }[];
      const app = apps.find(item => item.clientName === "要断开")!;
      expect((await admin.json("DELETE", `/api/v1/account/connected-apps/${app.id}`)).status).toBe(200);
      expect((await whoAmI(granted.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: granted.refresh_token, client_id: clientId })).status
      ).toBe(400);
      expect((await admin.json("DELETE", `/api/v1/account/connected-apps/${app.id}`)).status).toBe(404);
    });

    it("cannot be managed with a token, only by someone signed in", async () => {
      const clientId = await newClient();
      const granted = await signedIn(clientId);
      const answer = await fetch(`${origin}/api/v1/account/connected-apps`, {
        headers: { authorization: `Bearer ${granted.access_token}` }
      });
      expect(answer.status).toBe(403);
    });

    it("stop for someone whose account is disabled", async () => {
      await admin.json("POST", "/api/v1/admin/users", {
        email: "leaving@example.test",
        displayName: "要走的人",
        password: "leaving-password-1"
      });
      const leaving = server.client();
      await leaving.form("/login", { email: "leaving@example.test", password: "leaving-password-1", next: "/" });
      const clientId = await newClient();
      const granted = await signedIn(clientId, leaving);
      const { id } = ((await admin.json("GET", "/api/v1/admin/users?q=leaving")).data as { id: string }[])[0]!;
      await admin.json("PATCH", `/api/v1/admin/users/${id}`, { status: "disabled" });
      expect((await whoAmI(granted.access_token)).status).toBe(401);
      expect(
        (await token({ grant_type: "refresh_token", refresh_token: granted.refresh_token, client_id: clientId })).status
      ).toBe(400);
    });

    it("refuses a kind of grant it does not do", async () => {
      expect(await (await token({ grant_type: "password", username: "a", password: "b" })).json()).toEqual({
        error: "unsupported_grant_type"
      });
    });
  });

  describe("the command line", () => {
    it("is announced, so it knows it can sign in through the browser here", async () => {
      const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
      expect(metadata.pandocs_cli_client_id).toBe("pandocs-cli");
    });

    it("signs the person in as themselves, so their edits save rather than become suggestions", async () => {
      const granted = await signedIn("pandocs-cli");
      expect(granted).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read write" });
      const me = await (await whoAmI(granted.access_token)).json() as { data: { kind: string; scopes: string[] } };
      expect(me.data).toMatchObject({ kind: "user", scopes: ["read", "write"] });
      const { revision } = (await admin.json("GET", `/api/v1/documents/${pageId}`)).data as { revision: { no: number } };
      const saved = await fetch(`${origin}/api/v1/documents/${pageId}/content`, { method: "PUT", headers: { authorization: `Bearer ${granted.access_token}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ markdown: "# 页面\n\n命令行改的。\n", expectedRevision: revision.no }) });
      expect(saved.status).toBe(200);

      // Renewed, it stays the person.
      const renewed = await (await token({ grant_type: "refresh_token", refresh_token: granted.refresh_token, client_id: "pandocs-cli" })).json() as { access_token: string };
      expect(((await (await whoAmI(renewed.access_token)).json()) as { data: { kind: string } }).data.kind).toBe("user");
      const apps = (await admin.json("GET", "/api/v1/account/connected-apps")).data as { clientName: string; kind: string }[];
      expect(apps.find(app => app.clientName === "Pandocs command line")?.kind).toBe("user");
      expect(apps.filter(app => app.clientName !== "Pandocs command line").every(app => app.kind === "agent")).toBe(true);
    });

    it("says on the page that it acts as the person, and asks for a yes only from whoever just ran it", async () => {
      const { challenge } = pkce();
      const html = await (await admin.request(authorizePath("pandocs-cli", challenge))).text();
      expect(html).toContain("Pandocs command line");
      expect(html).toContain("Save, publish and delete as you");
      expect(html).toContain("you just ran pandocs login yourself");
      expect(html).not.toContain("as an agent");
    });

    it("only ever goes back to loopback", async () => {
      const { challenge } = pkce();
      for (const redirect of ["https://evil.example/callback", "http://localhost:4000/callback", "http://127.0.0.1:4000/elsewhere"]) {
        const page = await admin.request(authorizePath("pandocs-cli", challenge, { redirect_uri: redirect }));
        expect(page.status).toBe(400);
      }
    });

    describe.skipIf(!hasGo)("the real binary", () => {
      let home = "";
      let binary = "";
      beforeAll(() => {
        home = mkdtempSync(join(tmpdir(), "pandocs-login-"));
        binary = join(home, process.platform === "win32" ? "pandocs.exe" : "pandocs");
        execFileSync("go", ["build", "-o", binary, "."], { cwd: resolve(import.meta.dirname, "../../../cli"), stdio: "pipe" });
      }, 180_000);
      afterAll(() => rmSync(home, { recursive: true, force: true }));
      const config = () => join(home, "config.json");
      const run = (args: readonly string[], onError?: (text: string) => void) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
        const child = spawn(binary, args, { env: { PATH: process.env.PATH ?? "", HOME: home, PANDOCS_CONFIG: config() } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => { stdout += String(chunk); });
        child.stderr.on("data", chunk => {
          stderr += String(chunk);
          onError?.(stderr);
        });
        child.on("error", fail);
        child.on("close", code => done({ code, stdout, stderr }));
        child.stdin.end();
      });

      it("signs in through the browser, renews itself, and gives the sign-in back on logout", async () => {
        let approving: Promise<void> | null = null;
        const login = await run(["login", "--web", "--no-browser", "--server", origin], text => {
          const address = /(http:\/\/\S+\/oauth\/authorize\?\S+)/u.exec(text)?.[1];
          if (!address || approving) return;
          const asked = new URL(address);
          // The person says yes, and their browser goes back to the port the command line is waiting on.
          approving = approve(admin, `${asked.pathname}${asked.search}`).then(async back => {
            const page = await fetch(back);
            expect(await page.text()).toContain("Signed in");
          });
        });
        await approving;
        expect(login.stderr).toContain("open this in a browser");
        expect(login.code).toBe(0);
        expect(login.stdout).toContain("as 站长");
        const saved = JSON.parse(readFileSync(config(), "utf8")) as { token: string; session: { refreshToken: string; clientId: string } };
        expect(saved.session.clientId).toBe("pandocs-cli");
        expect(login.stdout + login.stderr).not.toContain(saved.token);
        expect((await run(["whoami"])).stdout).toContain("user, read+write");

        // An hour later the server no longer takes the token. The command line gets the next one by itself.
        await server.pool.query(`UPDATE pandocs.api_tokens SET expires_at = now() WHERE token_hash = $1`, [createHash("sha256").update(saved.token).digest("hex")]);
        const later = await run(["whoami"]);
        expect(later.stderr).toBe("");
        expect(later.stdout).toContain("站长");
        const renewed = JSON.parse(readFileSync(config(), "utf8")) as typeof saved;
        expect(renewed.token).not.toBe(saved.token);
        expect(renewed.session.refreshToken).not.toBe(saved.session.refreshToken);

        expect((await run(["logout"])).stdout).toContain("Logged out");
        expect((await whoAmI(renewed.token)).status).toBe(401);
        expect((await token({ grant_type: "refresh_token", refresh_token: renewed.session.refreshToken, client_id: "pandocs-cli" })).status).toBe(400);
      }, 60_000);

      it("still takes a token, for scripts and CI", async () => {
        const made = (await admin.json("POST", "/api/v1/account/tokens", { name: "CI", scopes: ["read"] })).data.token as string;
        const child = spawn(binary, ["login", "--server", origin], { env: { PATH: process.env.PATH ?? "", HOME: home, PANDOCS_CONFIG: config() } });
        child.stdin.end(`${made}\n`);
        const code = await new Promise(done => child.on("close", done));
        expect(code).toBe(0);
        expect(JSON.parse(readFileSync(config(), "utf8"))).toEqual({ server: origin, token: made });
      });
    });

    it("cannot be taken over by registering, and is never cleared out", async () => {
      await server.pool.query(`UPDATE pandocs.oauth_clients SET created_at = now() - interval '8 days' WHERE client_id = 'pandocs-cli'`);
      await server.pool.query(`DELETE FROM pandocs.oauth_grants WHERE client_id = 'pandocs-cli'`);
      await server.runtime.oauth.sweep();
      expect((await server.runtime.oauth.client("pandocs-cli"))?.redirectUris).toEqual(["http://127.0.0.1/callback"]);
      const registered = await newClient({ redirect_uris: [REDIRECT], client_name: "Pandocs command line" });
      expect(registered).not.toBe("pandocs-cli");
      const granted = await signedIn(registered);
      expect(((await (await whoAmI(granted.access_token)).json()) as { data: { kind: string } }).data.kind).toBe("agent");
    });
  });

  it("clears out what was never used, since registering takes no login", async () => {
    const unused = await newClient({ redirect_uris: [REDIRECT], client_name: "没用过" });
    const used = await newClient({ redirect_uris: [REDIRECT], client_name: "用过" });
    await signedIn(used);
    await server.pool.query(
      `UPDATE pandocs.oauth_clients SET created_at = now() - interval '8 days' WHERE client_id = ANY($1)`,
      [[unused, used]]
    );
    await server.runtime.oauth.sweep();
    const { rows } = await server.pool.query<{ client_id: string }>(
      `SELECT client_id FROM pandocs.oauth_clients WHERE client_id = ANY($1)`,
      [[unused, used]]
    );
    expect(rows.map(row => row.client_id)).toEqual([used]);
  });

  it("stops one address registering without end", async () => {
    let refused = false;
    for (let attempt = 0; attempt < 80 && !refused; attempt += 1) refused = (await register()).status === 429;
    expect(refused).toBe(true);
    await server.pool.query(`DELETE FROM pandocs.login_attempts`);
  });
});
