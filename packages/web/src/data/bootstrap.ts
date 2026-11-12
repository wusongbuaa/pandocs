import { getSocialIcons } from "../../vendor/rspress/node/utils/getSocialIcons";
import { api, setVisitor } from "../api/client";
import { shared } from "../embed/session";
import type { Bootstrap, SpaceWithTree } from "../types";
import { buildPages, buildRoutes } from "./pages";
import { APP_BASE, documentRoute, pageUrl } from "./paths";
import { app, pageData, routes, searchIndexHash, siteData, socialIcons } from "./runtime-data";
import { buildSiteData } from "./site";

export const loadBootstrap = () => api.get<Bootstrap>("bootstrap");

/** Icons the theme ships; a stored name it no longer knows should not take the whole page down. */
function knownIcons(bootstrap: Bootstrap): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const { icon } of bootstrap.site.socialLinks) {
    try {
      Object.assign(icons, getSocialIcons([{ icon, mode: "link", content: "" } as never]));
    } catch {
      // Falls through to no icon for this link.
    }
  }
  return icons;
}

export function applyBootstrap(bootstrap: Bootstrap): void {
  app.bootstrap = bootstrap;
  setVisitor(bootstrap.me.anonymous === true);
  Object.assign(siteData, buildSiteData(bootstrap));
  (pageData as unknown as { pages: unknown[] }).pages = buildPages(bootstrap);
  routes.length = 0;
  routes.push(...buildRoutes(bootstrap));
  for (const { lang } of bootstrap.site.locales) searchIndexHash[`###${lang}`] = bootstrap.searchIndexHash;
  Object.assign(socialIcons, knownIcons(bootstrap));
}

/** With a single space there is nothing to choose from, so the app's root goes straight into it. A share link leads to its page, which is the one above any others it covers. */
export function initialRedirect({ spaces }: Bootstrap, pathname: string): string | null {
  const atRoot = pathname === APP_BASE || pathname === APP_BASE.slice(0, -1);
  if (!atRoot || spaces.length !== 1) return null;
  const [space] = spaces as [SpaceWithTree];
  const [first] = shared ? [...space.tree].sort((a, b) => a.path.length - b.path.length) : [];
  return first ? pageUrl(documentRoute(space.slug, first.path)) : `${APP_BASE}${space.slug}/`;
}
