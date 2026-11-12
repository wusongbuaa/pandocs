import { t } from "@pandocs/i18n";
import type { Hono } from "hono";
import { z } from "zod";
import { readCookie, type Identity } from "../auth/identity.js";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "../auth/passwords.js";
import type { OAuthStore } from "../auth/oauth.js";
import type { PasswordLinks } from "../auth/password-links.js";
import { SESSION_COOKIE, type SessionStore } from "../auth/sessions.js";
import type { TokenStore } from "../auth/tokens.js";
import type { User, UserStore } from "../auth/users.js";
import type { PandocsServices, Principal } from "@pandocs/core";
import { dataResponse, errorResponse } from "./responses.js";

const tokenInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["user", "agent"]).default("user"),
    scopes: z
      .array(z.enum(["read", "write"]))
      .min(1)
      .default(["read"]),
    expiresInDays: z.number().int().min(1).max(3650).optional()
  })
  .strict();

const passwordInput = z
  .object({ current: z.string().optional(), next: z.string().min(MIN_PASSWORD_LENGTH).max(200) })
  .strict();

const userInput = z
  .object({
    email: z.string().trim().email().max(320),
    displayName: z.string().trim().min(1).max(120),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(200).optional(),
    isAdmin: z.boolean().optional()
  })
  .strict();

const userPatch = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    isAdmin: z.boolean().optional(),
    status: z.enum(["active", "disabled"]).optional(),
    password: z.string().min(MIN_PASSWORD_LENGTH).max(200).optional()
  })
  .strict();

const publicUser = ({
  id,
  email,
  displayName,
  isAdmin,
  groups,
  status,
  hasPassword,
  createdAt,
  lastLoginAt
}: User) => ({ id, email, displayName, isAdmin, groups, status, hasPassword, createdAt, lastLoginAt });

async function body<Schema extends z.ZodType>(
  request: Request,
  schema: Schema
): Promise<{ ok: true; value: z.output<Schema> } | { ok: false; response: Response }> {
  const raw = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    response: errorResponse(
      422,
      "INPUT_INVALID",
      t("The request is not valid"),
      parsed.error.issues.map(({ path, message }) => ({ path, message }))
    )
  };
}

export function registerAccountRoutes(
  app: Hono,
  deps: {
    identity: Identity;
    users: UserStore;
    sessions: SessionStore;
    tokens: TokenStore;
    oauth: OAuthStore;
    passwordLinks: PasswordLinks;
    services: PandocsServices;
  }
): void {
  const { identity, users, sessions, tokens, oauth, passwordLinks, services } = deps;

  app.get("/api/v1/account", async c => {
    const auth = await identity.authenticate(c.req.raw);
    if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
    if (!auth.user) return errorResponse(403, "SESSION_REQUIRED", t("This needs signing in on the website"));
    return dataResponse(publicUser(auth.user));
  });

  /** A token that could mint tokens would outlive its own revocation, so these take a signed-in person. */
  const withSession = async (request: Request) => {
    const auth = await identity.authenticate(request);
    if (!auth.ok) return { response: errorResponse(auth.status, auth.code, auth.message) };
    if (auth.via !== "session")
      return { response: errorResponse(403, "SESSION_REQUIRED", t("This needs signing in on the website")) };
    return { user: auth.user };
  };

  app.get("/api/v1/account/tokens", async c => {
    const { user, response } = await withSession(c.req.raw);
    return user ? dataResponse(await tokens.list(user.id)) : response;
  });

  app.post("/api/v1/account/tokens", async c => {
    const { user, response } = await withSession(c.req.raw);
    if (!user) return response;
    const input = await body(c.req.raw, tokenInput);
    if (!input.ok) return input.response;
    const scopes = input.value.scopes.includes("write") ? (["read", "write"] as const) : (["read"] as const);
    return dataResponse(await tokens.create(user.id, { ...input.value, scopes }), 201);
  });

  app.delete("/api/v1/account/tokens/:id", async c => {
    const { user, response } = await withSession(c.req.raw);
    if (!user) return response;
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/iu.test(id) || !(await tokens.revoke(user.id, id)))
      return errorResponse(404, "NOT_FOUND", t("No such token"));
    return dataResponse({ ok: true });
  });

  app.get("/api/v1/account/connected-apps", async c => {
    const { user, response } = await withSession(c.req.raw);
    return user ? dataResponse(await oauth.grants(user.id)) : response;
  });

  app.delete("/api/v1/account/connected-apps/:id", async c => {
    const { user, response } = await withSession(c.req.raw);
    if (!user) return response;
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/iu.test(id) || !(await oauth.revokeGrant(user.id, id)))
      return errorResponse(404, "NOT_FOUND", t("No such app"));
    return dataResponse({ ok: true });
  });

  app.post("/api/v1/account/password", async c => {
    const { user, response } = await withSession(c.req.raw);
    if (!user) return response;
    const input = await body(c.req.raw, passwordInput);
    if (!input.ok) return input.response;
    const stored = await users.passwordHashOf(user.id);
    // Someone who only ever signed in through a provider has no current password to give.
    if (stored && !(await verifyPassword(input.value.current ?? "", stored)))
      return errorResponse(403, "PASSWORD_WRONG", t("The current password is wrong"));
    await users.update(user.id, { passwordHash: await hashPassword(input.value.next) });
    // Often the reason for changing it is someone else having it.
    await sessions.destroyOthers(user.id, readCookie(c.req.raw, SESSION_COOKIE) ?? "");
    return dataResponse({ ok: true });
  });

  const asAdmin = async (request: Request) => {
    const auth = await identity.authenticate(request);
    if (!auth.ok) return { response: errorResponse(auth.status, auth.code, auth.message) };
    if (auth.principal.kind !== "user" || !auth.principal.isAdmin || !auth.user)
      return { response: errorResponse(403, "ADMIN_REQUIRED", t("Only administrators can manage users")) };
    if (!auth.principal.scopes.includes("write") && request.method !== "GET")
      return { response: errorResponse(403, "SCOPE_REQUIRED", t("This token cannot write")) };
    return { admin: auth.user, principal: auth.principal };
  };
  const record = (principal: Principal, action: string, id: string, detail: object) =>
    services.site.record(principal, action, id, detail);

  app.get("/api/v1/admin/users", async c => {
    const { admin, response } = await asAdmin(c.req.raw);
    return admin ? dataResponse((await users.list(c.req.query("q"))).map(publicUser)) : response;
  });

  app.post("/api/v1/admin/users", async c => {
    const { admin, principal, response } = await asAdmin(c.req.raw);
    if (!admin) return response;
    const input = await body(c.req.raw, userInput);
    if (!input.ok) return input.response;
    if (await users.findByEmail(input.value.email))
      return errorResponse(409, "EMAIL_TAKEN", t("This email already has an account"));
    const created = await users.create({
      email: input.value.email,
      displayName: input.value.displayName,
      isAdmin: input.value.isAdmin,
      passwordHash: input.value.password ? await hashPassword(input.value.password) : null
    });
    await record(principal, "site.user.create", created.id, {
      email: created.email,
      name: created.displayName,
      isAdmin: created.isAdmin
    });
    // Without a password or a company account they would have no way in, and nothing would say so.
    const passwordLink =
      !input.value.password && passwordLinks.enabled ? await passwordLinks.invite(created, admin.displayName) : null;
    return dataResponse({ ...publicUser(created), ...(passwordLink ? { passwordLink } : {}) }, 201);
  });

  app.post("/api/v1/admin/users/:id/password-link", async c => {
    const { admin, principal, response } = await asAdmin(c.req.raw);
    if (!admin) return response;
    const id = c.req.param("id");
    const person = /^[0-9a-f-]{36}$/iu.test(id) ? await users.findById(id) : null;
    if (!person) return errorResponse(404, "NOT_FOUND", t("No such user"));
    if (!passwordLinks.enabled) return errorResponse(409, "PASSWORD_LOGIN_OFF", t("This site does not use passwords"));
    if (person.status !== "active") return errorResponse(409, "USER_DISABLED", t("This account is disabled"));
    await record(principal, "site.user.password_link", person.id, { email: person.email });
    return dataResponse(await passwordLinks.reissue(person, admin.displayName), 201);
  });

  app.patch("/api/v1/admin/users/:id", async c => {
    const { admin, principal, response } = await asAdmin(c.req.raw);
    if (!admin) return response;
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/iu.test(id)) return errorResponse(404, "NOT_FOUND", t("No such user"));
    const input = await body(c.req.raw, userPatch);
    if (!input.ok) return input.response;
    // The last way into the administration should not be something a single click can close.
    if (id === admin.id && (input.value.isAdmin === false || input.value.status === "disabled"))
      return errorResponse(
        409,
        "CANNOT_DEMOTE_SELF",
        t("You cannot disable yourself or remove your own administrator rights")
      );
    const { password, ...patch } = input.value;
    const change = { ...patch, ...(password ? { passwordHash: await hashPassword(password) } : {}) };
    const demoting = input.value.isAdmin === false || input.value.status === "disabled";
    const updated = demoting ? await users.updateKeepingAnAdministrator(id, change) : await users.update(id, change);
    if (updated === "last-administrator")
      return errorResponse(
        409,
        "LAST_ADMIN",
        t("Someone has to stay an administrator who can sign in. Make someone else one first.")
      );
    if (!updated) return errorResponse(404, "NOT_FOUND", t("No such user"));
    if (input.value.status === "disabled" || password) await sessions.destroyAllFor(id);
    if (input.value.status === "disabled") await services.shareLinks.revokeMadeBy(principal, id);
    await record(principal, "site.user.update", id, {
      email: updated.email,
      ...patch,
      ...(password ? { passwordChanged: true } : {})
    });
    return dataResponse(publicUser(updated));
  });
}
