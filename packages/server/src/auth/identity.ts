import { SHARE_TOKEN_PREFIX } from "@pandocs/core";
import type { Channel, Principal, Scope } from "@pandocs/core";
import type { Config } from "../config.js";
import { GUEST_TOKEN_PREFIX, type EmbedApps, type GuestClaims } from "./embed.js";
import type { HostSessions } from "./host-session.js";
import { SESSION_COOKIE, type SessionStore } from "./sessions.js";
import { TOKEN_PREFIX, type ApiToken, type TokenStore } from "./tokens.js";
import type { User } from "./users.js";
import { t } from "@pandocs/i18n";

export type Authentication =
  | { readonly ok: true; readonly principal: Principal; readonly user: User; readonly via: "session" | "token"; readonly token?: ApiToken | undefined }
  | { readonly ok: true; readonly principal: Principal; readonly user: null; readonly via: "embed" | "share" }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

const unauthenticated = (): Authentication => ({ ok: false, status: 401, code: "UNAUTHENTICATED", message: t("Sign in first") });

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

export const userPrincipal = (user: User, scopes: readonly Scope[], channel: Channel): Principal => ({
  id: user.id,
  kind: "user",
  displayName: user.displayName,
  groups: user.groups,
  isAdmin: user.isAdmin,
  scopes,
  channel
});

/** An agent token reads what its owner can read and never gets more than comment and propose rights. */
function agentPrincipal(user: User, token: ApiToken): Principal {
  return {
    id: `agent:${token.id}`,
    kind: "agent",
    displayName: t("{0} (for {1})", token.name, user.displayName),
    groups: [],
    isAdmin: false,
    scopes: token.scopes,
    channel: "agent",
    onBehalfOf: { id: user.id, groups: user.groups, isAdmin: user.isAdmin }
  };
}

/** Clients name their channel for the revision record only: it changes neither identity nor rights. */
function bearerChannel(request: Request): Channel {
  const declared = request.headers.get("x-pandocs-channel");
  return declared === "cli" || declared === "mcp" ? declared : "api";
}

/**
 * A session cookie goes along with requests other sites trigger, so writes on one have to come from this site.
 * Browsers always send these headers on such requests; a client without them is not a browser and has no ambient cookie to abuse.
 * They leave out the first on plain http, where the site may be reached by an address other than the one it calls its own.
 */
export function fromAnotherSite(request: Request, origin: string): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const from = request.headers.get("origin");
  if (from === null || from === origin) return false;
  return !URL.canParse(from) || new URL(from).host !== request.headers.get("host");
}

/**
 * A visitor from another system. Group names are prefixed with the app, so a system can sort its own people but can never
 * claim a group of this site, and access comes from an administrator granting `group:embed:<app>` a role on a space.
 */
function guestPrincipal(claims: GuestClaims): Principal {
  return {
    id: `embed:${claims.app}:${claims.sub}`,
    kind: "user",
    displayName: claims.name,
    groups: [`embed:${claims.app}`, ...claims.groups.map(group => `embed:${claims.app}:${group}`)],
    isAdmin: false,
    guest: true,
    scopes: claims.kind === "ticket" ? ["read"] : ["read", "write"],
    channel: "embed"
  };
}

/** A page cannot put a header on an image or an event stream, so these two alone take a read-only ticket in the address. */
const TICKET_PATHS = /^\/api\/v1\/(?:events$|spaces\/[^/]+\/assets\/)/u;

function ticketIn(request: Request): string | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  return TICKET_PATHS.test(url.pathname) ? url.searchParams.get("ticket") : null;
}

export function createIdentity(deps: { readonly config: Pick<Config, "publicUrl">; readonly sessions: SessionStore; readonly tokens: TokenStore; readonly embedApps: EmbedApps; readonly shareLink: (token: string) => Promise<Principal | null>; readonly hostSessions?: Pick<HostSessions, "userOf"> | undefined }) {
  const origin = deps.config.publicUrl.origin;

  /** Someone signed in here, or else to the site this one lives beside, whose cookie comes along the same way. */
  const userOfCookies = async (request: Request): Promise<User | null> => {
    const cookie = readCookie(request, SESSION_COOKIE);
    return (cookie ? await deps.sessions.userOf(cookie) : null) ?? await deps.hostSessions?.userOf(request) ?? null;
  };

  const asGuest = async (token: string, kind: GuestClaims["kind"]): Promise<Authentication> => {
    const claims = deps.embedApps.verify(token);
    if (claims?.kind !== kind) return { ok: false, status: 401, code: "TOKEN_INVALID", message: t("The token is not valid or has expired") };
    const app = await deps.embedApps.bySlug(claims.app);
    if (app?.status !== "active") return { ok: false, status: 401, code: "TOKEN_INVALID", message: t("The token is not valid or has expired") };
    return { ok: true, principal: guestPrincipal(claims), user: null, via: "embed" };
  };

  const asVisitorWithLink = async (token: string): Promise<Authentication> => {
    const principal = await deps.shareLink(token);
    return principal ? { ok: true, principal, user: null, via: "share" } : { ok: false, status: 401, code: "TOKEN_INVALID", message: t("This link does not work any more") };
  };

  return {
    async authenticate(request: Request): Promise<Authentication> {
      const authorization = request.headers.get("authorization");
      const ticket = authorization ? null : ticketIn(request);
      if (ticket) return ticket.startsWith(SHARE_TOKEN_PREFIX) ? asVisitorWithLink(ticket) : asGuest(ticket, "ticket");
      if (authorization) {
        const bearer = /^Bearer\s+(\S+)$/iu.exec(authorization)?.[1];
        if (bearer?.startsWith(SHARE_TOKEN_PREFIX)) return asVisitorWithLink(bearer);
        if (bearer?.startsWith(GUEST_TOKEN_PREFIX)) return asGuest(bearer, "session");
        if (!bearer?.startsWith(TOKEN_PREFIX)) return { ok: false, status: 401, code: "TOKEN_INVALID", message: t("The API token is not valid") };
        const found = await deps.tokens.authenticate(bearer);
        if (!found) return { ok: false, status: 401, code: "TOKEN_INVALID", message: t("The API token is not valid or has expired") };
        const principal = found.token.kind === "agent" ? agentPrincipal(found.user, found.token) : userPrincipal(found.user, found.token.scopes, bearerChannel(request));
        return { ok: true, principal, user: found.user, via: "token", token: found.token };
      }
      const user = await userOfCookies(request);
      if (!user) return unauthenticated();
      if (fromAnotherSite(request, origin)) return { ok: false, status: 403, code: "CROSS_SITE_REQUEST", message: t("Requests from other sites are refused") };
      return { ok: true, principal: userPrincipal(user, ["read", "write"], "web"), user, via: "session" };
    },
    /** Pages only ever use the cookie. */
    async userOfCookie(request: Request): Promise<User | null> {
      return userOfCookies(request);
    }
  };
}

export type Identity = ReturnType<typeof createIdentity>;
