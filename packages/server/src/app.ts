import { ANONYMOUS_PRINCIPAL, DEFAULT_BRAND_COLOR, PandocsError } from "@pandocs/core";
import { clientAddress } from "./client-address.js";
import { createPandocsHandler, zh as coreZh } from "@pandocs/core";
import { addMessages, inLanguage, pickLanguage } from "@pandocs/i18n";
import { zh as markdownZh } from "@pandocs/markdown/zh";
import { t } from "@pandocs/i18n";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { routePath } from "hono/route";
import { registerAccountRoutes } from "./api/account.js";
import { registerEmbedRoutes } from "./api/embed.js";
import { registerOAuthRoutes } from "./api/oauth.js";
import { errorResponse } from "./api/responses.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { zh as serverZh } from "./i18n/zh.js";
import "./language.js";
import { createMcpHandler, servePublicMcp } from "./mcp.js";
import { createRateLimiter } from "./public-access.js";
import type { Runtime } from "./runtime.js";
import { CSP_REPORT_PATH } from "./web/csp.js";
import { registerPageRoutes } from "./web/pages.js";
import { openApiDocument } from "./api/openapi-document.js";
import { createPageRendering } from "./web/rendering.js";
import { createStaticFiles } from "./web/static.js";
import { servedUnder } from "./web/base-path.js";

export const API_BASE = "/api/v1";

/** Everything is read into memory to be looked at, and by then nobody knows who sent it. */
const FORM_BYTES = 64 * 1024;
const API_BYTES = 8 * 1024 * 1024;
/** Files are limited to 100 MiB, and a form around one takes a little more. */
const UPLOAD_BYTES = 101 * 1024 * 1024;
const UPLOAD_PATH = /^\/api\/v1\/spaces\/[^/]+\/(?:assets|archive|imports|bulk-imports)$/u;
/** Browsers repeat these for every blocked thing on a page, and anyone can send one. */
const POLICY_REPORTS_PER_MINUTE = 60;

const mostBytesFor = (pathname: string) => (UPLOAD_PATH.test(pathname) ? UPLOAD_BYTES : pathname === "/mcp" || pathname.startsWith(`${API_BASE}/`) ? API_BYTES : FORM_BYTES);
const bodyTooLarge = () => new PandocsError(413, "BODY_TOO_LARGE", t("The request body is too large"));

for (const messages of [markdownZh, coreZh, serverZh]) addMessages("zh", messages);

export function createApp(runtime: Runtime, options: { readonly cacheHtml?: boolean } = {}): Hono {
  const { config, identity, services, users, sessions, tokens, throttle, passwordLinks, flows, pool, events, embedApps, oauth, publicAccess } = runtime;
  const app = new Hono();

  app.use("*", (c, next) => inLanguage(pickLanguage(c.req.header("accept-language")), next));

  app.use("*", async (c, next) => {
    const { raw } = c.req;
    const most = mostBytesFor(c.req.path);
    const declared = c.req.header("content-length");
    const refuse = () => errorResponse(413, "BODY_TOO_LARGE", t("The request body is too large"));
    if (declared !== undefined && Number(declared) > most) return refuse();
    if (declared !== undefined || !raw.body) return next();
    // No length given, as with a chunked request, so it is counted on its way in and stops where it passes the limit.
    let size = 0;
    let exceeded = false;
    // Not from the request itself: what the HTTP library hands over only looks like a `Request` to anything but its own class.
    c.req.raw = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      signal: raw.signal,
      duplex: "half",
      body: raw.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size <= most) {
            controller.enqueue(chunk);
          } else {
            exceeded = true;
            controller.error(bodyTooLarge());
          }
        }
      }))
    } as RequestInit);
    await next();
    if (exceeded) {
      // Otherwise it keeps the headers of whatever was going to be answered.
      c.res = undefined;
      c.res = refuse();
    }
    return undefined;
  });

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
  });

  app.get("/healthz", c => c.json({ ok: true }));
  /** Readiness needs the database; a replica without it should get no traffic. */
  app.get("/readyz", async c => {
    // Shutting down: anything looking for somewhere to send traffic should look elsewhere.
    if (runtime.lifecycle.draining) return c.json({ ok: false, reason: "draining" }, 503);
    try {
      await pool.query("SELECT 1");
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  const policyReports = createRateLimiter(POLICY_REPORTS_PER_MINUTE);
  app.post(CSP_REPORT_PATH, async c => {
    const report = await c.req.text().catch(() => "");
    // A report says which page it is about, and the address of a shared one is what lets anyone read it.
    if (policyReports.allow(clientAddress(c, config.trustProxy))) console.warn(JSON.stringify({ event: "web.csp_violation", report: report.slice(0, 2000).replace(/(pd[sg]_)[\w.-]+/gu, "$1…") }));
    return c.body(null, 204);
  });

  /** What the pages for signing in and authorizing take from the site's settings. */
  const siteLook = async () => {
    const site = await services.site.get();
    return { brand: site.brandColor || DEFAULT_BRAND_COLOR, icon: site.favicon, logo: site.logo, description: site.description, base: config.basePath };
  };
  registerAuthRoutes(app, {
    config,
    users,
    sessions,
    throttle,
    passwordLinks,
    identity,
    flows,
    siteTitle: async () => (await services.site.get()).title,
    siteLook,
    host: runtime.hostSessions && config.hostSession ? { name: config.hostSession.name, loginUrl: runtime.hostSessions.loginUrl } : undefined
  });

  const mcp = createMcpHandler({ identity, services, siteUrl: config.siteUrl });
  app.all("/mcp", c => mcp(c.req.raw));
  app.all("/mcp/public", async c => {
    if (!await publicAccess.open()) return errorResponse(404, "NOT_FOUND", t("No such page"));
    // Any call can be a search, so all of them count as one.
    if (!publicAccess.allowRequest(clientAddress(c, config.trustProxy), "/search")) {
      const limited = errorResponse(429, "RATE_LIMITED", t("Too many requests. Try again later."));
      limited.headers.set("Retry-After", "60");
      return limited;
    }
    return servePublicMcp(services, c.req.raw);
  });
  registerOAuthRoutes(app, { config, identity, oauth, throttle, siteLook });

  app.use(`${API_BASE}/*`, compress());
  registerAccountRoutes(app, { identity, users, sessions, tokens, oauth, passwordLinks, services });
  registerEmbedRoutes(app, { identity, embedApps, services });

  app.get(`${API_BASE}/events`, c => events.handle(c.req.raw));

  // Not behind a login: the address itself is the secret, the host calling it has no account here, and all it does is make the next look come sooner.
  app.post(`${API_BASE}/git-hooks/:token`, async c => {
    if (!publicAccess.allowRequest(clientAddress(c, config.trustProxy), "/git-hooks")) return errorResponse(429, "RATE_LIMITED", t("Too many requests. Try again later."));
    return await services.gitSync.hook(c.req.param("token")) ? c.json({ version: 1, data: { queued: true } }, 202) : errorResponse(404, "NOT_FOUND", t("Endpoint"));
  });

  app.get(`${API_BASE}/openapi.yaml`, c => {
    const document = openApiDocument();
    return document === null ? errorResponse(404, "NOT_FOUND", t("Endpoint")) : new Response(document, { headers: { "Content-Type": "application/yaml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  });

  const handle = createPandocsHandler(services, {
    basePath: API_BASE,
    onError: error => console.error(JSON.stringify({ event: "api.internal_error", name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "" }))
  });
  app.all(`${API_BASE}/*`, async c => {
    const auth = await identity.authenticate(c.req.raw);
    if (auth.ok && auth.via !== "share") return handle(c.req.raw, auth.principal);
    if (auth.ok) {
      if (publicAccess.allowRequest(clientAddress(c, config.trustProxy), new URL(c.req.url).pathname)) return handle(c.req.raw, auth.principal);
      const limited = errorResponse(429, "RATE_LIMITED", t("Too many requests. Try again later."));
      limited.headers.set("Retry-After", "60");
      return limited;
    }
    // No login at all, as opposed to a wrong one, on a site with something public. The handler keeps this to what is meant for them.
    if (auth.code !== "UNAUTHENTICATED" || !await publicAccess.open()) return errorResponse(auth.status, auth.code, auth.message);
    // Another site could otherwise spend this site's budget through its own visitors' browsers.
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("sec-fetch-site") === "cross-site") return errorResponse(auth.status, auth.code, auth.message);
    if (!publicAccess.allowRequest(clientAddress(c, config.trustProxy), new URL(c.req.url).pathname)) {
      const limited = errorResponse(429, "RATE_LIMITED", t("Too many requests. Try again later."));
      limited.headers.set("Retry-After", "60");
      return limited;
    }
    return handle(c.req.raw, ANONYMOUS_PRINCIPAL);
  });

  const rendering = createPageRendering({ webDir: config.webDir, enabled: config.renderPages, origin: config.publicUrl.origin, base: config.basePath, api: handle });
  runtime.onDestroy(() => rendering.stop());
  registerPageRoutes(app, { identity, services, embedApps, publicAccess, rendering, origin: config.siteUrl, base: config.basePath, trustProxy: config.trustProxy, files: createStaticFiles(config.webDir, { cacheHtml: options.cacheHtml ?? false, base: config.basePath }) });

  app.onError((error, c) => {
    if (error instanceof PandocsError) return errorResponse(error.status, error.code, error.message);
    // The pattern rather than the address: some addresses are themselves what lets someone in.
    console.error(JSON.stringify({ event: "http.unhandled", route: routePath(c), name: error.name, message: error.message }));
    return errorResponse(500, "INTERNAL_ERROR", t("The service is temporarily unavailable"));
  });
  return servedUnder(config.basePath, app);
}

export { createRuntime, type Runtime } from "./runtime.js";
export { readConfig, type Config } from "./config.js";
export { loadSigningSecret, migrate } from "./migrate.js";
export { createChangeListener } from "./change-listener.js";
export { createPublisher, runPublisher } from "./publisher.js";
