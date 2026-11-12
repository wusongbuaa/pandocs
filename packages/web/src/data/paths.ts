import { embedBase } from "../embed/session";
import { SITE_BASE } from "./site-base";
import { randomId } from "../ui/random-id";

/** The app is served here; the theme's router strips it, so everything else in the app works with paths below it. */
export const APP_BASE = `${SITE_BASE}${embedBase ?? "/"}`;
export const HOME_DOCUMENT_PATH = "index";

/** Pages that belong to the product rather than a space. Space slugs cannot start with `_`. */
export const MANAGE_PREFIX = "/_";

export const localePrefix = (lang: string, defaultLang: string) => (lang === defaultLang ? "" : `/${lang}`);

/**
 * Written as it reads, apart from what an address cannot hold as it is: a percent sign, which the site reads as the start
 * of an escape when it compares addresses, and a hash or a question mark, which end the path.
 */
const escapePath = (path: string) => path.replace(/[%#?]/gu, encodeURIComponent);

export function documentRoute(space: string, path: string, prefix = ""): string {
  return `${prefix}/${space}/${path === HOME_DOCUMENT_PATH ? "" : escapePath(path)}`;
}

/**
 * Addresses from the web get pasted into chats, where Chinese turns into a long run of %E4%B8%80. So a title that is not
 * in plain letters gets a short address; the server keeps deriving readable ones for tools, which use them as references.
 */
export function slugForNewPage(title: string): string | undefined {
  return /[^\x20-\x7e]/u.test(title) ? randomId().slice(0, 8) : undefined;
}

/** A full URL for leaving the single-page app, such as after the document tree changed. */
export const pageUrl = (route: string) => `${APP_BASE.slice(0, -1)}${route}`;

/** Moves within the app from outside the router's tree, such as from the theme's page menu, which only takes a callback. */
export function softNavigate(url: string): void {
  history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}
