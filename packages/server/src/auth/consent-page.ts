import { t } from "@pandocs/i18n";
import { signInPage, type SiteLook } from "./login-page.js";

const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);

export interface ConsentPageInput {
  readonly clientName: string;
  readonly redirectUri: string;
  readonly userName: string;
  readonly scopes: readonly ("read" | "write")[];
  readonly fields: Readonly<Record<string, string>>;
  readonly look?: SiteLook | undefined;
}

/**
 * No script, and it cannot be framed, so nothing can click "allow" for someone. A browser applies `form-action` to where
 * the form ends up as well, so the app's address has to be on it for the redirect back to work.
 */
export function renderConsentPage(input: ConsentPageInput): { html: string; csp: string } {
  const target = new URL(input.redirectUri);
  const destination = target.protocol === "http:" || target.protocol === "https:" ? target.origin : target.protocol;
  const fields = Object.entries(input.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const abilities = [
    t("Read the documents you can see"),
    ...(input.scopes.includes("write")
      ? [t("Comment and suggest changes, for someone with edit access to review")]
      : [])
  ]
    .map(item => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const html = signInPage(
    t("Authorize an app"),
    `<h1 class="pd-sign-in__title">${t("Authorize {0}", escapeHtml(input.clientName))}</h1>
<p class="pd-sign-in__text">${t("{0}, this app wants to connect to your account as an agent:", escapeHtml(input.userName))}</p>
<ul class="pd-sign-in__list">${abilities}</ul>
<p class="pd-sign-in__text">${t('It cannot change documents directly, and can never do more than you can. Disconnect it at any time under "Account and tokens".')}</p>
<p class="pd-sign-in__text">${t("Afterwards it returns to:")}<br><span class="pd-sign-in__code">${escapeHtml(input.redirectUri)}</span></p>
<p class="pd-sign-in__text">${t("Any app can register itself under any name. Authorize it only if you know where it returns to.")}</p>
<form method="post" action="${input.look?.base ?? ""}/oauth/authorize">
${fields}
<div class="pd-sign-in__actions">
<button class="pd-sign-in__secondary" type="submit" name="decision" value="deny">${t("Deny")}</button>
<button class="pd-sign-in__submit" type="submit" name="decision" value="allow">${t("Authorize")}</button>
</div>
</form>`,
    input.look
  );
  return {
    html,
    csp: `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self' ${destination}; base-uri 'none'; frame-ancestors 'none'`
  };
}
