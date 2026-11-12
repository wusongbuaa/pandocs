/**
 * Where the site lives below its host, such as `/docs` behind another site's load balancer, and empty at the root. The
 * server says so in the page, and to the thread rendering one. Everything inside the app names paths below it.
 */
export const SITE_BASE: string = typeof document === "undefined"
  ? (globalThis as { pandocsSiteBase?: string }).pandocsSiteBase ?? ""
  : document.querySelector<HTMLMetaElement>('meta[name="pandocs-base"]')?.content ?? "";

export const API_BASE = `${SITE_BASE}/api/v1`;

// The theme's search builds the address of its index from this when someone first searches.
(globalThis as { pandocsApiBase?: string }).pandocsApiBase = API_BASE;

/** An address of the server's own, such as its sign-in page, from a path written from the site's root. */
export const sitePath = (path: string) => `${SITE_BASE}${path}`;

/** An address in the browser as the app names it, below the site's path. */
export function insideSite(pathname: string): string {
  if (!SITE_BASE) return pathname;
  return pathname === SITE_BASE || pathname.startsWith(`${SITE_BASE}/`) ? pathname.slice(SITE_BASE.length) || "/" : pathname;
}
