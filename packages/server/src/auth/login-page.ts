import { brandStyles, DEFAULT_BRAND_COLOR } from "@pandocs/core";
import { currentLanguage, t } from "@pandocs/i18n";
import { SIGN_IN_PAGE_STYLE, SIGN_IN_STYLE } from "./sign-in-look.js";

/** What these pages take from the site's settings besides its name. */
export interface SiteLook {
  readonly brand: string;
  /** The site's own favicon, or empty for Pandocs' icons. */
  readonly icon: string;
  /** The site's own logo, or empty for Pandocs' panda. */
  readonly logo: string;
  /** What the site says about itself, under the sign-in heading. */
  readonly description: string;
  /** The site's path below its host, such as `/docs`, which its own addresses here start with. Empty at the root. */
  readonly base: string;
}

const DEFAULT_LOOK: SiteLook = { brand: DEFAULT_BRAND_COLOR, icon: "", logo: "", description: "", base: "" };

/** The same icons as every other page, which the browser keeps showing between them. */
export const iconLinks = (icon: string, base = "") => (icon
  ? `<link rel="icon" href="${escapeHtml(icon)}">`
  : `<link rel="icon" href="${base}/favicon.ico" sizes="32x32"><link rel="icon" href="${base}/favicon.svg" type="image/svg+xml">`);

export interface LoginPageInput {
  readonly title: string;
  readonly next: string;
  readonly error?: string | undefined;
  readonly passwordLogin: boolean;
  /** No account exists yet, so the form makes the first administrator. */
  readonly setup: boolean;
  readonly providers: readonly { readonly id: string; readonly name: string }[];
  readonly look?: SiteLook | undefined;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);

/** A page holding the sign-in card, which is also what the app's dialog shows: the same parts, by the same names. */
export const signInPage = (title: string, card: string, look: SiteLook = DEFAULT_LOOK) => `<!doctype html>
<html lang="${currentLanguage()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${iconLinks(look.icon, look.base)}<title>${escapeHtml(title)}</title><style>${SIGN_IN_PAGE_STYLE}${brandStyles(look.brand)}${SIGN_IN_STYLE}</style></head>
<body><main class="pd-sign-in">
<div class="pd-sign-in__logo"><img src="${escapeHtml(look.logo || `${look.base}/logo.svg`)}" alt="" width="64" height="64"></div>
${card}
</main></body></html>`;

/** The label above the field, with room beside it for a link that belongs to it. */
const field = (id: string, label: string, attributes: string, aside = "") => {
  const labelled = `<label class="pd-sign-in__label" for="pd-${id}">${label}</label>`;
  return `<div class="pd-sign-in__field">${aside ? `<div class="pd-sign-in__label-row">${labelled}${aside}</div>` : labelled}<input class="pd-sign-in__input" id="pd-${id}" ${attributes}></div>`;
};

const loginText = () => ({
  signIn: t("Sign in"), setupTitle: t("Create the administrator"), setupHint: t("This is the first account, and it becomes the site administrator."), email: t("Email"), password: t("Password"), name: t("Name"), create: t("Create and sign in"),
  with: (name: string) => t("Sign in with {0}", name), or: t("or"),
  errors: {
    credentials: t("Wrong email or password"), throttled: t("Too many attempts. Try again in 15 minutes."), provider: t("Sign-in did not finish. Please try again."), state: t("This sign-in expired. Please try again."), domain: t("This email domain cannot sign in to this site."),
    disabled: t("This account is disabled. Contact an administrator."), email: t("The identity provider returned no email, so no account can be created."), setup: t("This site already has an administrator. Please sign in."), invalid: t("Enter a valid email and a password of at least 8 characters.")
  } as Record<string, string>
});

/** What the page says about a sign-in that did not work, for the app's dialog to say the same. */
export const loginErrorMessage = (error: string): string => loginText().errors[error] ?? t("Sign-in did not finish. Please try again.");

export function renderLoginPage(input: LoginPageInput): string {
  const text = loginText();
  const look = input.look ?? DEFAULT_LOOK;
  const error = input.error ? text.errors[input.error] : undefined;
  const nextField = `<input type="hidden" name="next" value="${escapeHtml(input.next)}">`;
  const providers = input.providers.map(provider =>
    `<a class="pd-sign-in__provider" href="${escapeHtml(look.base)}/auth/${escapeHtml(provider.id)}/start?next=${encodeURIComponent(input.next)}">${escapeHtml(text.with(provider.name))}</a>`).join("");
  const showSetup = input.setup && input.passwordLogin;
  const setupForm = `<form class="pd-sign-in__form" method="post" action="${escapeHtml(look.base)}/setup">${nextField}
${field("name", text.name, `name="displayName" required maxlength="120" autocomplete="name" autofocus`)}
${field("email", text.email, `name="email" type="email" required autocomplete="username"`)}
${field("password", text.password, `name="password" type="password" required minlength="8" autocomplete="new-password"`)}
<button class="pd-sign-in__submit" type="submit">${text.create}</button></form>`;
  const loginForm = `<form class="pd-sign-in__form" method="post" action="${escapeHtml(look.base)}/login">${nextField}
${field("email", text.email, `name="email" type="email" required autocomplete="username" autofocus`)}
${field("password", text.password, `name="password" type="password" required autocomplete="current-password"`, `<a class="pd-sign-in__aside" href="${escapeHtml(look.base)}/forgot-password">${t("Forgot your password?")}</a>`)}
<button class="pd-sign-in__submit" type="submit">${text.signIn}</button></form>`;
  const form = showSetup ? setupForm : input.passwordLogin ? loginForm : "";
  const lead = showSetup ? text.setupHint : look.description;
  // Accounts come from the company's provider when there is one, so only a site of passwords needs telling who makes them.
  const noAccount = providers || showSetup ? "" : `<p class="pd-sign-in__note">${t("No account yet? Ask an administrator of this site.")}</p>`;
  return signInPage(input.title, `<h1 class="pd-sign-in__title">${escapeHtml(showSetup ? text.setupTitle : t("Sign in to {0}", input.title))}</h1>
${lead ? `<p class="pd-sign-in__lead">${escapeHtml(lead)}</p>` : ""}
${error ? `<p class="pd-sign-in__problem" role="alert">${escapeHtml(error)}</p>` : ""}
${providers ? `<div class="pd-sign-in__providers">${providers}</div>` : ""}${providers && form ? `<p class="pd-sign-in__or">${text.or}</p>` : ""}
${form}
${noAccount}`, look);
}

const backToLogin = (look: SiteLook = DEFAULT_LOOK) => `<p class="pd-sign-in__note"><a href="${escapeHtml(look.base)}/login">${t("Back to sign in")}</a></p>`;

export function renderForgotPasswordPage(input: { readonly title: string; readonly selfService: boolean; readonly sent?: boolean; readonly look?: SiteLook | undefined }): string {
  const heading = `<h1 class="pd-sign-in__title">${t("Forgot your password?")}</h1>`;
  const said = (words: string) => `<p class="pd-sign-in__lead">${words}</p>`;
  if (!input.selfService) return signInPage(input.title, `${heading}${said(t("Ask an administrator of this site to send you a link for choosing a new one."))}${backToLogin(input.look)}`, input.look);
  if (input.sent) return signInPage(input.title, `${heading}${said(t("If that email has an account here, a link for choosing a new password is on its way. It works for an hour."))}${backToLogin(input.look)}`, input.look);
  return signInPage(input.title, `${heading}${said(t("Enter your email, and we will send a link for choosing a new one."))}
<form class="pd-sign-in__form" method="post" action="${escapeHtml(input.look?.base ?? "")}/forgot-password">
${field("email", t("Email"), `name="email" type="email" required autocomplete="username" autofocus`)}
<button class="pd-sign-in__submit" type="submit">${t("Send the link")}</button></form>${backToLogin(input.look)}`, input.look);
}

export function renderSetPasswordPage(input: { readonly title: string; readonly look?: SiteLook | undefined; readonly action: string; readonly person: { readonly displayName: string; readonly email: string }; readonly tooShort?: boolean }): string {
  return signInPage(input.title, `<h1 class="pd-sign-in__title">${t("Choose a password")}</h1>
<p class="pd-sign-in__lead">${escapeHtml(input.person.displayName)} · ${escapeHtml(input.person.email)}</p>
${input.tooShort ? `<p class="pd-sign-in__problem" role="alert">${t("A password has at least 8 characters.")}</p>` : ""}
<form class="pd-sign-in__form" method="post" action="${escapeHtml(input.action)}">
<input type="email" name="username" value="${escapeHtml(input.person.email)}" autocomplete="username" hidden>
${field("password", t("Password (at least 8 characters)"), `name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password" autofocus`)}
<button class="pd-sign-in__submit" type="submit">${t("Save and sign in")}</button></form>`, input.look);
}

export function renderPasswordLinkGonePage(input: { readonly title: string; readonly look?: SiteLook | undefined }): string {
  return signInPage(input.title, `<h1 class="pd-sign-in__title">${t("This link no longer works")}</h1>
<p class="pd-sign-in__lead">${t("It may have been used already, expired, or been replaced by a newer one. Ask an administrator for another, or ask for one from the sign-in page.")}</p>${backToLogin(input.look)}`, input.look);
}
