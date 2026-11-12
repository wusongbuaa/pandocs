import { clientAddress } from "../client-address.js";
import { t } from "@pandocs/i18n";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { onSite, type Config } from "../config.js";
import { loginErrorMessage, renderForgotPasswordPage, renderLoginPage, renderPasswordLinkGonePage, renderSetPasswordPage, type SiteLook } from "./login-page.js";
import type { PasswordLinks } from "./password-links.js";
import { DUMMY_PASSWORD_HASH, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./passwords.js";
import { openLoginState, type LoginFlow } from "./providers.js";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, type SessionStore } from "./sessions.js";
import type { LoginThrottle } from "./throttle.js";
import type { User, UserStore } from "./users.js";
import { LOGIN_CSP, CSP_HEADER } from "../web/csp.js";
import { SIGN_IN_STYLE, SIGN_IN_STYLE_TAG } from "./sign-in-look.js";
import { fromAnotherSite, type Identity } from "./identity.js";
import { LONGEST_EMAIL, userFromProfile, validEmail } from "./provision.js";

const STATE_COOKIE = "pandocs_login";
const STATE_MAX_AGE_SECONDS = 600;

const NOWHERE = "http://nowhere.invalid";

/**
 * Only ever a path on this site, so a crafted link cannot send someone elsewhere after they sign in. Read the way a browser
 * will read it: tabs and line breaks left out, and a backslash as a slash, which is how `/<tab>/elsewhere` is another site.
 */
export function safeNext(next: string | undefined): string {
  if (!next?.startsWith("/") || !URL.canParse(next, NOWHERE)) return "/";
  const url = new URL(next, NOWHERE);
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (url.origin !== NOWHERE || path.startsWith("//")) return "/";
  return /^\/(login|logout|setup|auth|forgot-password|set-password)(\/|\?|$)/u.test(path) ? "/" : path;
}

export interface AuthRouteDeps {
  readonly config: Pick<Config, "publicUrl" | "basePath" | "siteUrl" | "secureCookies" | "passwordLogin" | "siteTitle" | "trustProxy"> & { readonly secret: string };
  readonly users: UserStore;
  readonly sessions: SessionStore;
  readonly throttle: LoginThrottle;
  readonly passwordLinks: PasswordLinks;
  readonly identity: Identity;
  readonly flows: readonly LoginFlow[];
  readonly siteTitle: () => Promise<string>;
  /** The site's colour and icon, which these pages use too. */
  readonly siteLook: () => Promise<SiteLook>;
  /** The site this one lives beside, when people sign in there: what it is called, and where its login is. */
  readonly host?: { readonly name: string; readonly loginUrl: (address: string) => string | null } | undefined;
}

/**
 * On top of the limit for one address trying one account, in the same window. Trying many accounts from one place, or one
 * account from many, costs the same work per try and gets as far. An office sharing an address does not fail this often.
 */
const MAX_FAILURES_FROM_ADDRESS = 100;
const MAX_FAILURES_ON_ACCOUNT = 100;
/** Enough for a mistyped address and a second try, and few enough that this cannot be used to flood a mailbox. */
const FORGOTTEN_ASKS_PER_EMAIL = 3;
const FORGOTTEN_ASKS_PER_ADDRESS = 20;

/** Whatever arrives is not always a form, and that should come to the same as an empty one. */
const formOf = (c: Parameters<typeof deleteCookie>[0]) => c.req.parseBody().catch(() => ({} as Record<string, unknown>));

/** The app's own sign-in dialog asks for an answer it can read, where the page needs somewhere to go. */
const wantsData = (c: Parameters<typeof deleteCookie>[0]) => (c.req.header("accept") ?? "").includes("application/json");
const NO_STORE = { "Cache-Control": "no-store" };

/** The same words the page shows, with a status a program can tell apart. */
const LOGIN_REFUSALS: Readonly<Record<string, { readonly status: 401 | 403 | 429; readonly code: string }>> = {
  credentials: { status: 401, code: "LOGIN_FAILED" },
  throttled: { status: 429, code: "LOGIN_THROTTLED" },
  disabled: { status: 403, code: "ACCOUNT_DISABLED" }
};

export function registerAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
  const { config, users, sessions, throttle, passwordLinks, identity, flows } = deps;
  // Below the site's path, so the cookies stay out of whatever else answers on the same host.
  const cookieOptions = { httpOnly: true, sameSite: "Lax" as const, secure: config.secureCookies, path: config.basePath || "/" };

  const startSession = async (c: Parameters<typeof deleteCookie>[0], user: User) => {
    const token = await sessions.create(user.id);
    await users.recordLogin(user.id);
    setCookie(c, SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_MAX_AGE_SECONDS });
  };

  const loginUrl = (next: string, error?: string) => `/login?${new URLSearchParams({ next, ...(error ? { error } : {}) })}`;

  /** Signing someone in or out from another site's page would leave them working in an account they did not choose. */
  const refusedFromElsewhere = (c: Parameters<typeof deleteCookie>[0]) => (fromAnotherSite(c.req.raw, config.publicUrl.origin) ? c.text(t("Requests from other sites are refused"), 403) : null);

  /** The app's sign-in dialog looks like these pages because it loads the same stylesheet. */
  app.get("/sign-in.css", c => {
    const headers = { ETag: SIGN_IN_STYLE_TAG, "Cache-Control": "no-cache" };
    if (c.req.header("if-none-match") === SIGN_IN_STYLE_TAG) return c.body(null, 304, headers);
    return c.body(SIGN_IN_STYLE, 200, { ...headers, "Content-Type": "text/css; charset=utf-8" });
  });

  /** Signing in at the host comes back to the same page here, by its whole address. */
  const hostLogin = (next: string) => deps.host?.loginUrl(`${config.siteUrl}${next}`) ?? null;
  const atTheHost = deps.host && hostLogin("/") ? [{ id: "host", name: deps.host.name }] : [];

  app.get("/login", async c => {
    const next = safeNext(c.req.query("next"));
    const signedIn = Boolean(await identity.userOfCookie(c.req.raw));
    const providers = [...flows.map(({ provider }) => ({ id: provider.id, name: provider.name })), ...atTheHost];
    const setup = (await users.count()) === 0;
    if (wantsData(c)) return c.json({ version: 1, data: { signedIn, passwordLogin: config.passwordLogin, setup, providers } }, 200, NO_STORE);
    if (signedIn) return c.redirect(next);
    // With nothing to choose between, the page would only hold the one link.
    if (atTheHost.length > 0 && !config.passwordLogin && flows.length === 0) return c.redirect(hostLogin(next)!);
    const html = renderLoginPage({
      title: await deps.siteTitle(),
      look: await deps.siteLook(),
      next,
      error: c.req.query("error"),
      passwordLogin: config.passwordLogin,
      setup,
      providers
    });
    return c.html(html, 200, { [CSP_HEADER]: LOGIN_CSP, "Cache-Control": "no-store" });
  });

  app.post("/login", async c => {
    const refused = refusedFromElsewhere(c);
    if (refused) return refused;
    const form = await formOf(c);
    const next = safeNext(String(form.next ?? ""));
    const refuse = (error: keyof typeof LOGIN_REFUSALS) => {
      if (!wantsData(c)) return c.redirect(loginUrl(next, error), 303);
      const { status, code } = LOGIN_REFUSALS[error]!;
      return c.json({ version: 1, error: { code, message: loginErrorMessage(error) } }, status, NO_STORE);
    };
    if (!config.passwordLogin) {
      return wantsData(c) ? c.json({ version: 1, error: { code: "PASSWORD_LOGIN_OFF", message: t("This site does not sign in with passwords.") } }, 404, NO_STORE) : c.redirect(loginUrl(next), 303);
    }
    const email = String(form.email ?? "").trim();
    const password = String(form.password ?? "");
    if (email.length > LONGEST_EMAIL) return refuse("credentials");
    const address = clientAddress(c, config.trustProxy);
    const account = email.toLowerCase();
    const key = `password:${account}:${address}`;
    const fromAddress = `password-address:${address}`;
    const onAccount = `password-account:${account}`;
    const blocked = await Promise.all([throttle.blocked(key), throttle.blocked(fromAddress, MAX_FAILURES_FROM_ADDRESS), throttle.blocked(onAccount, MAX_FAILURES_ON_ACCOUNT)]);
    if (blocked.includes(true)) return refuse("throttled");
    const found = email ? await users.findForLogin(email) : null;
    const matches = await verifyPassword(password, found?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!found?.passwordHash || !matches) {
      await Promise.all([throttle.fail(key), throttle.fail(fromAddress), throttle.fail(onAccount)]);
      return refuse("credentials");
    }
    if (found.user.status !== "active") return refuse("disabled");
    await throttle.clear(key);
    await startSession(c, found.user);
    // The session cookie is set on this context, so only an answer made from it carries the cookie.
    return wantsData(c) ? c.json({ version: 1, data: { ok: true } }, 200, NO_STORE) : c.redirect(next, 303);
  });

  app.post("/setup", async c => {
    const refused = refusedFromElsewhere(c);
    if (refused) return refused;
    const form = await formOf(c);
    const next = safeNext(String(form.next ?? ""));
    // Working out a password's hash is the slow part, and once there is an administrator nobody should be able to ask for it.
    if ((await users.count()) > 0) return c.redirect(loginUrl(next, "setup"), 303);
    const email = String(form.email ?? "").trim();
    const displayName = String(form.displayName ?? "").trim();
    const password = String(form.password ?? "");
    if (!config.passwordLogin) return c.redirect(loginUrl(next), 303);
    if (!validEmail(email) || !displayName || displayName.length > 120 || password.length < MIN_PASSWORD_LENGTH) return c.redirect(loginUrl(next, "invalid"), 303);
    const user = await users.createFirstAdmin({ email, displayName, passwordHash: await hashPassword(password) });
    if (!user) return c.redirect(loginUrl(next, "setup"), 303);
    await startSession(c, user);
    return c.redirect(next, 303);
  });

  const noSuchPage = (c: Parameters<typeof deleteCookie>[0]) => c.text(t("No such page"), 404);
  const authPage = (c: Parameters<typeof deleteCookie>[0], html: string, status: 200 | 410 | 422 = 200) => c.html(html, status, { [CSP_HEADER]: LOGIN_CSP, "Cache-Control": "no-store" });

  app.get("/forgot-password", async c => {
    if (!config.passwordLogin) return noSuchPage(c);
    return authPage(c, renderForgotPasswordPage({ title: await deps.siteTitle(), look: await deps.siteLook(), selfService: passwordLinks.selfService }));
  });

  app.post("/forgot-password", async c => {
    if (!passwordLinks.selfService) return noSuchPage(c);
    const form = await formOf(c);
    const email = String(form.email ?? "").trim().toLowerCase();
    const address = clientAddress(c, config.trustProxy);
    // After answering, so how long this takes says nothing about whether the account exists.
    void (async () => {
      if (!validEmail(email)) return;
      const allowed = await throttle.spend(`forgotten:${email}`, FORGOTTEN_ASKS_PER_EMAIL) && await throttle.spend(`forgotten:${address}`, FORGOTTEN_ASKS_PER_ADDRESS);
      const person = allowed ? await users.findByEmail(email) : null;
      // Someone whose way in is the company's login should not get a second one by asking: leaving the company would not end it.
      if (person?.status === "active" && (person.hasPassword || !await users.hasIdentity(person.id))) await passwordLinks.forgotten(person);
    })().catch((error: unknown) => {
      console.error(JSON.stringify({ event: "auth.forgotten_password_failed", name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "" }));
    });
    return authPage(c, renderForgotPasswordPage({ title: await deps.siteTitle(), look: await deps.siteLook(), selfService: true, sent: true }));
  });

  // Chat apps open a link to preview it, so only sending the form uses it up.
  app.get("/set-password/:token", async c => {
    if (!config.passwordLogin) return noSuchPage(c);
    const person = await passwordLinks.userOf(c.req.param("token"));
    const title = await deps.siteTitle();
    const look = await deps.siteLook();
    if (!person) return authPage(c, renderPasswordLinkGonePage({ title, look }), 410);
    return authPage(c, renderSetPasswordPage({ title, look, action: `${config.basePath}${c.req.path}`, person }));
  });

  app.post("/set-password/:token", async c => {
    if (!config.passwordLogin) return noSuchPage(c);
    const token = c.req.param("token");
    const title = await deps.siteTitle();
    const look = await deps.siteLook();
    const person = await passwordLinks.userOf(token);
    if (!person) return authPage(c, renderPasswordLinkGonePage({ title, look }), 410);
    const password = String((await formOf(c)).password ?? "");
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) return authPage(c, renderSetPasswordPage({ title, look, action: `${config.basePath}${c.req.path}`, person, tooShort: true }), 422);
    const user = await passwordLinks.use(token, await hashPassword(password));
    if (!user) return authPage(c, renderPasswordLinkGonePage({ title, look }), 410);
    await startSession(c, user);
    return c.redirect("/", 303);
  });

  /** The app posts here and reloads; coming back without a session lands on the login page. */
  app.post("/logout", async c => {
    const refused = refusedFromElsewhere(c);
    if (refused) return refused;
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await sessions.destroy(token);
    deleteCookie(c, SESSION_COOKIE, { path: cookieOptions.path });
    return c.json({ version: 1, data: { ok: true } });
  });

  const callbackUrlOf = (id: string) => onSite(config.publicUrl, `/auth/${id}/callback`);

  if (atTheHost.length > 0) app.get("/auth/host/start", c => c.redirect(hostLogin(safeNext(c.req.query("next")))!));

  for (const flow of flows) {
    const { id } = flow.provider;
    app.get(`/auth/${id}/start`, async c => {
      const next = safeNext(c.req.query("next"));
      try {
        const { url, cookie } = await flow.start(next);
        setCookie(c, STATE_COOKIE, cookie, { ...cookieOptions, maxAge: STATE_MAX_AGE_SECONDS });
        return c.redirect(url.toString());
      } catch (error) {
        console.error(JSON.stringify({ event: "auth.provider_start_failed", provider: id, name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "" }));
        return c.redirect(loginUrl(next, "provider"));
      }
    });
    app.get(`/auth/${id}/callback`, async c => {
      const login = openLoginState(config.secret, getCookie(c, STATE_COOKIE));
      deleteCookie(c, STATE_COOKIE, { path: cookieOptions.path });
      if (!login) return c.redirect(loginUrl("/", "state"));
      const current = new URL(callbackUrlOf(id));
      current.search = new URL(c.req.url).search;
      try {
        const result = await userFromProfile(users, flow.provider, await flow.finish(current, login));
        if ("error" in result) return c.redirect(loginUrl(login.next, result.error));
        await startSession(c, result);
        return c.redirect(login.next);
      } catch (error) {
        const reference = randomUUID();
        console.error(JSON.stringify({ event: "auth.provider_callback_failed", provider: id, reference, name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "" }));
        return c.redirect(loginUrl(login.next, "provider"));
      }
    });
  }
}
