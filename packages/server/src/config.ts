import { fileURLToPath } from "node:url";

export type Role = "web" | "worker" | "publisher";

export interface LoginProvider {
  /** The URL segment: `/auth/<id>/start`. */
  readonly id: "oidc" | "oauth";
  readonly name: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: string;
  readonly groupsClaim: string;
  /** Members of this group are administrators, and only they. Without it the first person in is the administrator. */
  readonly adminGroup?: string | undefined;
  /** Address domains allowed in. Empty lets anyone the provider vouches for in. */
  readonly allowedDomains: readonly string[];
  /** Only for local development against an identity provider without TLS. */
  readonly allowHttp: boolean;
  readonly protocol:
    | { readonly kind: "oidc"; readonly issuer: string }
    | { readonly kind: "oauth2"; readonly authorizationUrl: string; readonly tokenUrl: string; readonly userinfoUrl: string; readonly subjectClaim: string; readonly emailClaim: string; readonly nameClaim: string };
}

export type StorageConfig =
  | { readonly kind: "local"; readonly dir: string }
  | { readonly kind: "s3"; readonly bucket: string; readonly region: string; readonly prefix: string; readonly endpoint?: string | undefined; readonly forcePathStyle?: boolean | undefined };

export interface LlmConfig {
  readonly protocol: "openai" | "anthropic";
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Sent with every call, for a gateway in front of the models that is told what to do by header. */
  readonly headers: Readonly<Record<string, string>>;
  readonly hourlyLimit: number;
  /** For everyone with no login taken together, on a site that lets them ask. */
  readonly visitorHourlyLimit: number;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  readonly from: string;
}

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly publicUrl: URL;
  /**
   * Where under its host the site lives, from the path of `PANDOCS_URL`: `/docs` for `https://example.com/docs`, empty at
   * the root. Requests carry it, and everything the site says about its own addresses includes it.
   */
  readonly basePath: string;
  /** The site's own address, with its path and no slash at the end, for addresses that leave the browser. */
  readonly siteUrl: string;
  readonly secureCookies: boolean;
  readonly databaseUrl: string;
  readonly databasePool: number;
  /** `LISTEN` and session locks need a real connection. Point this past a pooler that runs in transaction mode. */
  readonly databaseListenUrl: string;
  /** Signs the short-lived cookie of a login in progress, so any replica can finish what another started. Generated and kept in the database when unset. */
  readonly secret?: string | undefined;
  readonly roles: ReadonlySet<Role>;
  /** How long to keep answering after being told to stop, while load balancers catch up. */
  readonly drainMs: number;
  readonly webDir: string;
  readonly siteTitle?: string | undefined;
  readonly storage: StorageConfig;
  readonly passwordLogin: boolean;
  readonly providers: readonly LoginProvider[];
  /** People signed in to the site this one lives beside, by that site's own session cookie. */
  readonly hostSession?: HostSessionConfig | undefined;
  readonly admin?: { readonly email: string; readonly password: string; readonly displayName: string } | undefined;
  readonly llm?: LlmConfig | undefined;
  readonly smtp?: SmtpConfig | undefined;
  /** Whether a space can be opened to people with no login. For sites that must never be, this keeps them all closed. */
  readonly publicSpaces: boolean;
  /** Whether pages leave the server finished. Off, the same app renders them in the browser. */
  readonly renderPages: boolean;
  /** Whether to keep how much pages are read, what is searched for and what the AI is asked. */
  readonly readingStats: boolean;
  /** An app on Feishu or Lark, for importing from there. */
  readonly feishu?: { readonly appId: string; readonly appSecret: string; readonly baseUrl: string } | undefined;
  /** Whether people editing a page share one draft and see each other type. */
  readonly liveEditing: boolean;
  /** How soon someone connected to a draft is sent away after they can no longer edit it. */
  readonly liveRecheckMs: number;
  /** Lets Git sync reach repositories on private networks. */
  readonly gitAllowPrivate: boolean;
  /** Lets hooks reach addresses on private networks, for a site whose other systems are all inside. */
  readonly webhooksAllowPrivate: boolean;
  /** A service that turns files into Markdown, instead of the conversion built in. */
  /** A conversion service, for every file or, with `fallback`, only for what the built-in conversion cannot read. */
  readonly extract?: { readonly url: string; readonly token?: string | undefined; readonly fallback: boolean } | undefined;
  /** Where to keep a read-only copy of spaces as files, for agents on a shared file system. */
  readonly publish?: { readonly dir: string; readonly spaces: readonly string[] | "*"; readonly packIntervalMs: number } | undefined;
  /** Client addresses come from `X-Forwarded-For`, which only means something behind a proxy that sets it. */
  readonly trustProxy: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const text = (env: Env, name: string) => env[name]?.trim() || undefined;
const flag = (env: Env, name: string, fallback: boolean) => {
  const value = text(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
};
/** How many proxies stand in front. `true` is the usual one. */
const proxyCount = (env: Env) => {
  const value = text(env, "PANDOCS_TRUST_PROXY")?.toLowerCase();
  if (value !== undefined && /^\d+$/u.test(value)) return Number(value);
  return flag(env, "PANDOCS_TRUST_PROXY", false) ? 1 : 0;
};
const list = (env: Env, name: string) => (text(env, name) ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);

function required(env: Env, name: string, because: string): string {
  const value = text(env, name);
  if (!value) throw new Error(`${name} is required ${because}`);
  return value;
}

function nonNegativeInt(env: Env, name: string, fallback: number): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be zero or more, got ${raw}`);
  return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`);
  return value;
}

function readRoles(env: Env): ReadonlySet<Role> {
  const roles = list(env, "PANDOCS_ROLES");
  for (const role of roles) if (role !== "web" && role !== "worker" && role !== "publisher") throw new Error(`PANDOCS_ROLES has an unknown role: ${role}`);
  if (roles.includes("publisher") && !text(env, "PANDOCS_PUBLISH_DIR")) throw new Error("PANDOCS_ROLES has publisher, which needs PANDOCS_PUBLISH_DIR");
  return new Set<Role>(roles.length > 0 ? roles as Role[] : ["web", "worker"]);
}

function readStorage(env: Env): StorageConfig {
  const kind = text(env, "PANDOCS_STORAGE") ?? (text(env, "PANDOCS_S3_BUCKET") ? "s3" : "local");
  if (kind === "local") return { kind, dir: text(env, "PANDOCS_DATA_DIR") ?? "./data" };
  if (kind !== "s3") throw new Error(`PANDOCS_STORAGE must be local or s3, got ${kind}`);
  const forcePathStyle = text(env, "PANDOCS_S3_FORCE_PATH_STYLE");
  return {
    kind,
    bucket: required(env, "PANDOCS_S3_BUCKET", "for S3 storage"),
    region: text(env, "PANDOCS_S3_REGION") ?? "us-east-1",
    prefix: text(env, "PANDOCS_S3_PREFIX") ?? "pandocs/",
    endpoint: text(env, "PANDOCS_S3_ENDPOINT"),
    ...(forcePathStyle === undefined ? {} : { forcePathStyle: flag(env, "PANDOCS_S3_FORCE_PATH_STYLE", false) })
  };
}

/**
 * Signing in by the session of the site this one lives beside, such as the site whose `/docs` this is, which has its own
 * login and says who a session belongs to when asked with its cookie. Nothing here keeps a password or a session for them.
 */
export interface HostSessionConfig {
  /** Asked who a session belongs to, with the cookies named below and no others. Its answer is JSON. */
  readonly url: string;
  readonly cookies: readonly string[];
  /** As in "Sign in with …". */
  readonly name: string;
  /** Where people sign in there, with `{url}` for the address to come back to. */
  readonly loginUrl?: string | undefined;
  /** The host's sign-out endpoint, which takes a POST, for the site's own setting to start from. */
  readonly logoutUrl?: string | undefined;
  /** Where in the answer each thing is, such as `id` or `data.user.id`. */
  readonly subjectClaim: string;
  readonly emailClaim: string;
  readonly nameClaim: string;
  readonly groupsClaim: string;
  /** Someone in this group administers the site, and nobody else does. Without one, the first person to come does. */
  readonly adminGroup?: string | undefined;
  /** How long an answer counts before the host is asked again, which is also how long someone signed out there stays in here. */
  readonly cacheSeconds: number;
}

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

function readHostSession(env: Env): HostSessionConfig | undefined {
  const url = text(env, "PANDOCS_HOST_SESSION_URL");
  if (!url) return undefined;
  if (!URL.canParse(url)) throw new Error(`PANDOCS_HOST_SESSION_URL must be an address, got ${url}`);
  // Names keep their case, unlike the lists of domains and groups.
  const cookies = (text(env, "PANDOCS_HOST_SESSION_COOKIES") ?? "").split(",").map(name => name.trim()).filter(Boolean);
  if (cookies.length === 0) throw new Error("PANDOCS_HOST_SESSION_COOKIES is required with PANDOCS_HOST_SESSION_URL, to say which of the host's cookies to send it");
  const unusable = cookies.find(name => !COOKIE_NAME.test(name));
  if (unusable) throw new Error(`PANDOCS_HOST_SESSION_COOKIES has a name no cookie can have: ${unusable}`);
  const loginUrl = text(env, "PANDOCS_HOST_LOGIN_URL");
  if (loginUrl && !URL.canParse(loginUrl.replace("{url}", ""))) throw new Error(`PANDOCS_HOST_LOGIN_URL must be an address, got ${loginUrl}`);
  return {
    url,
    cookies,
    name: text(env, "PANDOCS_HOST_NAME") ?? new URL(loginUrl?.replace("{url}", "") ?? url).hostname,
    loginUrl,
    logoutUrl: text(env, "PANDOCS_HOST_LOGOUT_URL"),
    subjectClaim: text(env, "PANDOCS_HOST_SUBJECT_CLAIM") ?? "id",
    emailClaim: text(env, "PANDOCS_HOST_EMAIL_CLAIM") ?? "email",
    nameClaim: text(env, "PANDOCS_HOST_NAME_CLAIM") ?? "name",
    groupsClaim: text(env, "PANDOCS_HOST_GROUPS_CLAIM") ?? "roles",
    adminGroup: text(env, "PANDOCS_HOST_ADMIN_GROUP"),
    cacheSeconds: nonNegativeInt(env, "PANDOCS_HOST_SESSION_SECONDS", 60)
  };
}

function readProviders(env: Env): LoginProvider[] {
  const providers: LoginProvider[] = [];
  const issuer = text(env, "PANDOCS_OIDC_ISSUER");
  if (issuer) {
    providers.push({
      id: "oidc",
      name: text(env, "PANDOCS_OIDC_NAME") ?? "SSO",
      clientId: required(env, "PANDOCS_OIDC_CLIENT_ID", "with PANDOCS_OIDC_ISSUER"),
      clientSecret: required(env, "PANDOCS_OIDC_CLIENT_SECRET", "with PANDOCS_OIDC_ISSUER"),
      scopes: text(env, "PANDOCS_OIDC_SCOPES") ?? "openid profile email",
      groupsClaim: text(env, "PANDOCS_OIDC_GROUPS_CLAIM") ?? "groups",
      adminGroup: text(env, "PANDOCS_OIDC_ADMIN_GROUP"),
      allowedDomains: list(env, "PANDOCS_OIDC_ALLOWED_DOMAINS"),
      allowHttp: flag(env, "PANDOCS_OIDC_ALLOW_HTTP", false),
      protocol: { kind: "oidc", issuer }
    });
  }
  const authorizationUrl = text(env, "PANDOCS_OAUTH_AUTHORIZATION_URL");
  if (authorizationUrl) {
    providers.push({
      id: "oauth",
      name: text(env, "PANDOCS_OAUTH_NAME") ?? "OAuth",
      clientId: required(env, "PANDOCS_OAUTH_CLIENT_ID", "with PANDOCS_OAUTH_AUTHORIZATION_URL"),
      clientSecret: required(env, "PANDOCS_OAUTH_CLIENT_SECRET", "with PANDOCS_OAUTH_AUTHORIZATION_URL"),
      scopes: text(env, "PANDOCS_OAUTH_SCOPES") ?? "",
      groupsClaim: text(env, "PANDOCS_OAUTH_GROUPS_CLAIM") ?? "groups",
      adminGroup: text(env, "PANDOCS_OAUTH_ADMIN_GROUP"),
      allowedDomains: list(env, "PANDOCS_OAUTH_ALLOWED_DOMAINS"),
      allowHttp: flag(env, "PANDOCS_OAUTH_ALLOW_HTTP", false),
      protocol: {
        kind: "oauth2",
        authorizationUrl,
        tokenUrl: required(env, "PANDOCS_OAUTH_TOKEN_URL", "with PANDOCS_OAUTH_AUTHORIZATION_URL"),
        userinfoUrl: required(env, "PANDOCS_OAUTH_USERINFO_URL", "with PANDOCS_OAUTH_AUTHORIZATION_URL"),
        subjectClaim: text(env, "PANDOCS_OAUTH_SUBJECT_CLAIM") ?? "id",
        emailClaim: text(env, "PANDOCS_OAUTH_EMAIL_CLAIM") ?? "email",
        nameClaim: text(env, "PANDOCS_OAUTH_NAME_CLAIM") ?? "name"
      }
    });
  }
  return providers;
}

function readPublish(env: Env): Config["publish"] {
  const dir = text(env, "PANDOCS_PUBLISH_DIR");
  if (!dir) return undefined;
  const spaces = required(env, "PANDOCS_PUBLISH_SPACES", "with PANDOCS_PUBLISH_DIR: list the spaces, or * for all of them. Anyone with the mount can read what is published");
  return { dir, spaces: spaces === "*" ? "*" : list(env, "PANDOCS_PUBLISH_SPACES"), packIntervalMs: positiveInt(env, "PANDOCS_PUBLISH_PACK_SECONDS", 300) * 1000 };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/** A JSON object of header names and values, such as `{"x-portkey-provider":"anthropic"}`. */
function readHeaders(env: Env, name: string): Readonly<Record<string, string>> {
  const value = text(env, name);
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  const valid = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    && Object.entries(parsed).every(([header, content]) => HEADER_NAME.test(header) && typeof content === "string" && !/[\r\n]/u.test(content));
  if (!valid) throw new Error(`${name} must be a JSON object of header names and their values, such as {"x-gateway-route":"docs"}`);
  return parsed as Record<string, string>;
}

function readLlm(env: Env): LlmConfig | undefined {
  const apiKey = text(env, "PANDOCS_LLM_API_KEY");
  if (!apiKey) return undefined;
  const protocol = text(env, "PANDOCS_LLM_PROTOCOL") ?? "openai";
  if (protocol !== "openai" && protocol !== "anthropic") throw new Error(`PANDOCS_LLM_PROTOCOL must be openai or anthropic, got ${protocol}`);
  return {
    protocol,
    apiKey,
    baseUrl: (text(env, "PANDOCS_LLM_BASE_URL") ?? (protocol === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com")).replace(/\/+$/u, ""),
    model: required(env, "PANDOCS_LLM_MODEL", "with PANDOCS_LLM_API_KEY"),
    headers: readHeaders(env, "PANDOCS_LLM_HEADERS"),
    hourlyLimit: positiveInt(env, "PANDOCS_LLM_HOURLY_LIMIT", 60),
    visitorHourlyLimit: positiveInt(env, "PANDOCS_LLM_VISITOR_HOURLY_LIMIT", 60)
  };
}

function readSmtp(env: Env): SmtpConfig | undefined {
  const host = text(env, "PANDOCS_SMTP_HOST");
  if (!host) return undefined;
  const port = positiveInt(env, "PANDOCS_SMTP_PORT", 587);
  return { host, port, secure: flag(env, "PANDOCS_SMTP_SECURE", port === 465), user: text(env, "PANDOCS_SMTP_USER"), password: text(env, "PANDOCS_SMTP_PASSWORD"), from: required(env, "PANDOCS_SMTP_FROM", "with PANDOCS_SMTP_HOST") };
}

/**
 * Behind another site's load balancer, which sends one path of its own here as it is, such as `/docs`. Plain segments
 * only, since the path goes into addresses, cookies and pages as it is.
 */
function basePathOf(publicUrl: URL): string {
  if (publicUrl.search || publicUrl.hash) throw new Error(`PANDOCS_URL is the site's address, with no query or fragment, got ${publicUrl.href}`);
  const path = publicUrl.pathname.replace(/\/+$/u, "");
  if (path && !/^(?:\/[A-Za-z0-9._~-]+)+$/u.test(path)) throw new Error(`PANDOCS_URL can have a path of plain segments, such as https://example.com/docs, got ${publicUrl.href}`);
  return path;
}

/** An address on the site, below its path when it has one: `/a` on `https://example.com/docs` is `https://example.com/docs/a`. */
export const onSite = (publicUrl: URL, path: string) => `${publicUrl.origin}${basePathOf(publicUrl)}${path}`;

export function readConfig(env: Env): Config {
  const publicUrl = new URL(text(env, "PANDOCS_URL") ?? "http://localhost:8080");
  const basePath = basePathOf(publicUrl);
  const adminEmail = text(env, "PANDOCS_ADMIN_EMAIL");
  const providers = readProviders(env);
  const hostSession = readHostSession(env);
  const passwordLogin = flag(env, "PANDOCS_PASSWORD_LOGIN", true);
  if (!passwordLogin && providers.length === 0 && !hostSession) throw new Error("PANDOCS_PASSWORD_LOGIN is off and no OIDC or OAuth provider or host session is set, so nobody could sign in");
  return {
    host: text(env, "HOST") ?? "0.0.0.0",
    port: positiveInt(env, "PORT", 8080),
    publicUrl,
    basePath,
    siteUrl: `${publicUrl.origin}${basePath}`,
    secureCookies: publicUrl.protocol === "https:",
    databaseUrl: required(env, "DATABASE_URL", "to reach PostgreSQL"),
    databaseListenUrl: text(env, "PANDOCS_DATABASE_LISTEN_URL") ?? required(env, "DATABASE_URL", "to reach PostgreSQL"),
    databasePool: positiveInt(env, "PANDOCS_DATABASE_POOL", 10),
    secret: text(env, "PANDOCS_SECRET"),
    roles: readRoles(env),
    drainMs: nonNegativeInt(env, "PANDOCS_DRAIN_SECONDS", 5) * 1000,
    webDir: text(env, "PANDOCS_WEB_DIR") ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    siteTitle: text(env, "PANDOCS_SITE_TITLE"),
    storage: readStorage(env),
    passwordLogin,
    providers,
    ...(hostSession ? { hostSession } : {}),
    ...(adminEmail ? { admin: { email: adminEmail, password: required(env, "PANDOCS_ADMIN_PASSWORD", "with PANDOCS_ADMIN_EMAIL"), displayName: text(env, "PANDOCS_ADMIN_NAME") ?? "Admin" } } : {}),
    llm: readLlm(env),
    smtp: readSmtp(env),
    publish: readPublish(env),
    publicSpaces: flag(env, "PANDOCS_PUBLIC_SPACES", true),
    renderPages: flag(env, "PANDOCS_RENDER_PAGES", true),
    readingStats: flag(env, "PANDOCS_READING_STATS", true),
    webhooksAllowPrivate: flag(env, "PANDOCS_WEBHOOK_ALLOW_PRIVATE", false),
    gitAllowPrivate: flag(env, "PANDOCS_GIT_ALLOW_PRIVATE", false),
    liveEditing: flag(env, "PANDOCS_LIVE_EDITING", true),
    liveRecheckMs: nonNegativeInt(env, "PANDOCS_LIVE_RECHECK_SECONDS", 30) * 1000,
    ...(text(env, "PANDOCS_FEISHU_APP_ID") ? { feishu: { appId: text(env, "PANDOCS_FEISHU_APP_ID")!, appSecret: required(env, "PANDOCS_FEISHU_APP_SECRET", "with PANDOCS_FEISHU_APP_ID"), baseUrl: text(env, "PANDOCS_FEISHU_BASE_URL") ?? "https://open.feishu.cn" } } : {}),
    ...(text(env, "PANDOCS_EXTRACT_URL") ? { extract: { url: text(env, "PANDOCS_EXTRACT_URL")!, token: text(env, "PANDOCS_EXTRACT_TOKEN"), fallback: flag(env, "PANDOCS_EXTRACT_FALLBACK", false) } } : {}),
    trustProxy: proxyCount(env)
  };
}
