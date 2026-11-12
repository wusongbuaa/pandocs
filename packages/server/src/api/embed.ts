import { t } from "@pandocs/i18n";
import type { Hono } from "hono";
import { z } from "zod";
import { EMBED_SECRET_PREFIX, GUEST_TOKEN_PREFIX, MAX_TTL_SECONDS, validOrigin, type EmbedApp, type EmbedApps } from "../auth/embed.js";
import type { Identity } from "../auth/identity.js";
import type { PandocsServices, Principal } from "@pandocs/core";
import { dataResponse, errorResponse } from "./responses.js";

const origins = z.array(z.string().max(300).refine(validOrigin, { error: () => t("Should be an origin such as https://app.example.com") })).max(50);

const appInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  name: z.string().trim().min(1).max(120),
  allowedOrigins: origins
}).strict();

const appPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  allowedOrigins: origins.optional(),
  status: z.enum(["active", "disabled"]).optional()
}).strict();

const sessionInput = z.object({
  user: z.object({
    id: z.string().min(1).max(200),
    displayName: z.string().trim().min(1).max(120),
    groups: z.array(z.string().regex(/^[\w.@-]{1,100}$/u)).max(50).optional()
  }).strict(),
  ttlSeconds: z.number().int().min(60).max(MAX_TTL_SECONDS).optional()
}).strict();

const publicApp = ({ slug, name, allowedOrigins, status, createdAt, lastUsedAt }: EmbedApp) => ({ slug, name, allowedOrigins, status, createdAt, lastUsedAt, group: `embed:${slug}` });

async function body<Schema extends z.ZodType>(request: Request, schema: Schema): Promise<{ ok: true; value: z.output<Schema> } | { ok: false; response: Response }> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, response: errorResponse(422, "INPUT_INVALID", t("The request is not valid"), parsed.error.issues.map(({ path, message }) => ({ path, message }))) };
}

export function registerEmbedRoutes(app: Hono, deps: { identity: Identity; embedApps: EmbedApps; services: PandocsServices }): void {
  const { identity, embedApps, services } = deps;

  /** Called by the other system's server. Its secret must never reach a browser, so nothing here helps one call this. */
  app.post("/api/v1/embed/sessions", async c => {
    const bearer = /^Bearer\s+(\S+)$/iu.exec(c.req.header("authorization") ?? "")?.[1];
    if (!bearer?.startsWith(EMBED_SECRET_PREFIX)) return errorResponse(401, "EMBED_SECRET_INVALID", t("The app secret is not valid"));
    const embedApp = await embedApps.bySecret(bearer);
    if (!embedApp) return errorResponse(401, "EMBED_SECRET_INVALID", t("The app secret is not valid, or the app is disabled"));
    const input = await body(c.req.raw, sessionInput);
    if (!input.ok) return input.response;
    const { token, expiresAt } = embedApps.issue(embedApp, input.value.user, input.value.ttlSeconds);
    return dataResponse({ token, expiresAt, app: embedApp.slug }, 201);
  });

  /** An image or an event stream cannot carry a header, so a page asks for this to put in their addresses. */
  app.get("/api/v1/embed/ticket", async c => {
    const bearer = /^Bearer\s+(\S+)$/iu.exec(c.req.header("authorization") ?? "")?.[1];
    const claims = bearer?.startsWith(GUEST_TOKEN_PREFIX) ? embedApps.verify(bearer) : null;
    if (claims?.kind !== "session") return errorResponse(401, "TOKEN_INVALID", t("The token is not valid or has expired"));
    const embedApp = await embedApps.bySlug(claims.app);
    if (embedApp?.status !== "active") return errorResponse(401, "TOKEN_INVALID", t("The token is not valid or has expired"));
    return dataResponse({ ticket: embedApps.ticketFor(claims) });
  });

  const asAdmin = async (request: Request) => {
    const auth = await identity.authenticate(request);
    if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
    if (auth.principal.kind !== "user" || !auth.principal.isAdmin) return errorResponse(403, "ADMIN_REQUIRED", t("Only administrators can manage embed apps"));
    if (!auth.principal.scopes.includes("write") && request.method !== "GET") return errorResponse(403, "SCOPE_REQUIRED", t("This token cannot write"));
    return auth.principal;
  };
  const refusal = (answer: Response | Principal): answer is Response => answer instanceof Response;
  const record = (principal: Principal, action: string, slug: string, detail: object = {}) => services.site.record(principal, action, slug, { slug, ...detail });

  app.get("/api/v1/admin/embed-apps", async c => {
    const admin = await asAdmin(c.req.raw);
    return refusal(admin) ? admin : dataResponse((await embedApps.list()).map(publicApp));
  });

  app.post("/api/v1/admin/embed-apps", async c => {
    const admin = await asAdmin(c.req.raw);
    if (refusal(admin)) return admin;
    const input = await body(c.req.raw, appInput);
    if (!input.ok) return input.response;
    const created = await embedApps.create(input.value);
    if (!created) return errorResponse(409, "EMBED_APP_TAKEN", t("There is already an app called {0}", input.value.slug));
    await record(admin, "site.embed_app.create", created.app.slug, { name: created.app.name, allowedOrigins: created.app.allowedOrigins });
    return dataResponse({ app: publicApp(created.app), secret: created.secret }, 201);
  });

  app.patch("/api/v1/admin/embed-apps/:slug", async c => {
    const admin = await asAdmin(c.req.raw);
    if (refusal(admin)) return admin;
    const input = await body(c.req.raw, appPatch);
    if (!input.ok) return input.response;
    const updated = await embedApps.update(c.req.param("slug"), input.value);
    if (!updated) return errorResponse(404, "NOT_FOUND", t("No such app"));
    await record(admin, "site.embed_app.update", updated.slug, input.value);
    return dataResponse(publicApp(updated));
  });

  app.post("/api/v1/admin/embed-apps/:slug/secret", async c => {
    const admin = await asAdmin(c.req.raw);
    if (refusal(admin)) return admin;
    const secret = await embedApps.rotateSecret(c.req.param("slug"));
    if (!secret) return errorResponse(404, "NOT_FOUND", t("No such app"));
    await record(admin, "site.embed_app.secret", c.req.param("slug"));
    return dataResponse({ secret });
  });

  app.delete("/api/v1/admin/embed-apps/:slug", async c => {
    const admin = await asAdmin(c.req.raw);
    if (refusal(admin)) return admin;
    if (!await embedApps.remove(c.req.param("slug"))) return errorResponse(404, "NOT_FOUND", t("No such app"));
    await record(admin, "site.embed_app.delete", c.req.param("slug"));
    return dataResponse({ ok: true });
  });
}
