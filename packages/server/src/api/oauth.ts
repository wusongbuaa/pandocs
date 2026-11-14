import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { renderConsentPage } from "../auth/consent-page.js";
import type { Identity } from "../auth/identity.js";
import type { SiteLook } from "../auth/login-page.js";
import type { LoginThrottle } from "../auth/throttle.js";
import { ACCESS_TTL_SECONDS, CLI_CLIENT_ID, matchesRedirect, scopesFrom, validRedirectUri, type IssuedTokens, type OAuthClient, type OAuthStore } from "../auth/oauth.js";
import { clientAddress } from "../client-address.js";
import type { Config } from "../config.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
/** In a throttle window. Generous, since a whole office can share one address, but registering takes no login. */
const MAX_REGISTRATIONS = 60;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", ...headers } });
const oauthError = (status: number, error: string, description?: string) => json(status, { error, ...(description ? { error_description: description } : {}) }, NO_STORE);
const plainError = (message: string) => new Response(message, { status: 400, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });

const registration = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(120).optional(),
  token_endpoint_auth_method: z.string().optional()
}).loose();

interface AuthorizeRequest {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes: readonly ("read" | "write")[];
  readonly scope: string;
}

/**
 * The flow MCP clients use: they find this server from a 401 on `/mcp`, register themselves, and send the person here to
 * say yes. What they get is an agent token, so a connected tool can read, comment and propose, but a person still decides.
 */
export function registerOAuthRoutes(app: Hono, deps: { config: Pick<Config, "siteUrl" | "trustProxy"> & { readonly secret: string }; identity: Identity; oauth: OAuthStore; throttle: LoginThrottle; siteLook: () => Promise<SiteLook> }): void {
  const { config, identity, oauth, throttle } = deps;
  // The site's address, with its path when it has one, which apps know it by.
  const issuer = config.siteUrl;
  const consentKey = createHmac("sha256", config.secret).update("pandocs-oauth-consent-v1").digest();

  const protectedResource = () => json(200, { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"], resource_name: "Pandocs" });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  app.get("/.well-known/oauth-authorization-server", () => json(200, {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
    // Not a standard field: it tells the command line this server signs it in through the browser.
    pandocs_cli_client_id: CLI_CLIENT_ID
  }));
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token", "/oauth/revoke"]) {
    app.options(path, () => new Response(null, { status: 204, headers: CORS }));
  }

  app.post("/oauth/register", async c => {
    const key = `oauth-register:${clientAddress(c, config.trustProxy)}`;
    if (await throttle.blocked(key, MAX_REGISTRATIONS)) return oauthError(429, "too_many_requests");
    const input = registration.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return oauthError(400, "invalid_client_metadata");
    if (!input.data.redirect_uris.every(validRedirectUri)) return oauthError(400, "invalid_redirect_uri", "Redirect URIs must be https, loopback, or a scheme of the app's own");
    if (input.data.token_endpoint_auth_method && input.data.token_endpoint_auth_method !== "none") return oauthError(400, "invalid_client_metadata", "Only public clients with PKCE are supported");
    await throttle.fail(key);
    const client = await oauth.registerClient({ clientName: input.data.client_name ?? "MCP client", redirectUris: input.data.redirect_uris });
    return json(201, {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    }, NO_STORE);
  });

  /**
   * Sent back to the app. Only ever after the client and its address have checked out, or it would be an open redirect.
   * It says who it is from, since an app connected to several servers could otherwise be sent this one's code by
   * another (RFC 9207).
   */
  const backToClient = (redirectUri: string, params: Record<string, string>, state: string) => {
    const target = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
    if (state) target.searchParams.set("state", state);
    target.searchParams.set("iss", issuer);
    return new Response(null, { status: 303, headers: { ...NO_STORE, Location: target.toString() } });
  };

  const readRequest = async (values: { get(name: string): string | null }): Promise<{ request: AuthorizeRequest } | { response: Response }> => {
    const client = await oauth.client(values.get("client_id") ?? "");
    if (!client) return { response: plainError("This application is not registered here.") };
    const redirectUri = values.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
    if (!matchesRedirect(client.redirectUris, redirectUri)) return { response: plainError("This address was not registered for this application.") };
    const state = values.get("state") ?? "";
    if (values.get("response_type") !== "code") return { response: backToClient(redirectUri, { error: "unsupported_response_type" }, state) };
    const codeChallenge = values.get("code_challenge") ?? "";
    if (values.get("code_challenge_method") !== "S256" || !/^[\w-]{43,128}$/u.test(codeChallenge)) return { response: backToClient(redirectUri, { error: "invalid_request", error_description: "PKCE with S256 is required" }, state) };
    const resource = values.get("resource");
    if (resource && resource.replace(/\/$/u, "") !== `${issuer}/mcp` && resource.replace(/\/$/u, "") !== issuer) return { response: backToClient(redirectUri, { error: "invalid_target" }, state) };
    const scope = values.get("scope") ?? "read write";
    const scopes = scopesFrom(scope);
    if (!scopes) return { response: backToClient(redirectUri, { error: "invalid_scope" }, state) };
    return { request: { client, redirectUri, state, codeChallenge, scopes, scope } };
  };

  /** Ties the yes to this person and this request, so another site cannot post one on their behalf. */
  const consentProof = (userId: string, request: AuthorizeRequest) => createHmac("sha256", consentKey)
    .update(JSON.stringify([userId, request.client.clientId, request.redirectUri, request.codeChallenge, request.scope, request.state]))
    .digest("base64url");

  app.get("/oauth/authorize", async c => {
    const url = new URL(c.req.url);
    const read = await readRequest(url.searchParams);
    if ("response" in read) return read.response;
    const user = await identity.userOfCookie(c.req.raw);
    if (!user) return c.redirect(`/login?${new URLSearchParams({ next: `${url.pathname}${url.search}` })}`);
    const { request } = read;
    const page = renderConsentPage({
      look: await deps.siteLook(),
      clientName: request.client.clientName,
      asPerson: request.client.clientId === CLI_CLIENT_ID,
      redirectUri: request.redirectUri,
      userName: user.displayName,
      scopes: request.scopes,
      fields: {
        client_id: request.client.clientId,
        redirect_uri: request.redirectUri,
        response_type: "code",
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        scope: request.scope,
        state: request.state,
        proof: consentProof(user.id, request)
      }
    });
    return new Response(page.html, { headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": page.csp } });
  });

  app.post("/oauth/authorize", async c => {
    const form = new URLSearchParams(await c.req.text());
    const read = await readRequest(form);
    if ("response" in read) return read.response;
    const user = await identity.userOfCookie(c.req.raw);
    if (!user) return plainError("Please sign in and try again.");
    const { request } = read;
    const site = c.req.header("sec-fetch-site");
    const expected = Buffer.from(consentProof(user.id, request));
    const given = Buffer.from(form.get("proof") ?? "");
    if ((site && site !== "same-origin") || expected.length !== given.length || !timingSafeEqual(expected, given)) return plainError("This request could not be verified. Please try again from the application.");
    if (form.get("decision") !== "allow") return backToClient(request.redirectUri, { error: "access_denied" }, request.state);
    const code = await oauth.issueCode({ clientId: request.client.clientId, userId: user.id, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, scopes: request.scopes });
    return backToClient(request.redirectUri, { code }, request.state);
  });

  const tokensResponse = (issued: IssuedTokens) => json(200, {
    access_token: issued.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: issued.refreshToken,
    scope: issued.scopes.join(" ")
  }, NO_STORE);

  app.post("/oauth/token", async c => {
    const form = new URLSearchParams(await c.req.text());
    const clientId = form.get("client_id") ?? "";
    switch (form.get("grant_type")) {
      case "authorization_code": {
        const issued = await oauth.exchangeCode({ code: form.get("code") ?? "", clientId, redirectUri: form.get("redirect_uri") ?? "", verifier: form.get("code_verifier") ?? "" });
        return issued ? tokensResponse(issued) : oauthError(400, "invalid_grant");
      }
      case "refresh_token": {
        const issued = await oauth.refresh({ refreshToken: form.get("refresh_token") ?? "", clientId });
        return issued ? tokensResponse(issued) : oauthError(400, "invalid_grant");
      }
      default:
        return oauthError(400, "unsupported_grant_type");
    }
  });

  /** The same answer whether or not the token was one, so it cannot be used to find out (RFC 7009, 2.2). */
  app.post("/oauth/revoke", async c => {
    const form = new URLSearchParams(await c.req.text());
    const tokenToRevoke = form.get("token");
    if (!tokenToRevoke) return oauthError(400, "invalid_request");
    await oauth.revokeToken({ token: tokenToRevoke, clientId: form.get("client_id") ?? "" });
    return new Response(null, { status: 200, headers: { ...CORS, ...NO_STORE } });
  });
}
