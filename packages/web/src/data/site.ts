import * as React from "react";
import { shared } from "../embed/session";
import type { SiteData } from "@rspress/shared";
import { Code, FileDown, Network, Presentation, Sparkles, type LucideIcon } from "lucide-react";
import { runHostAction } from "../annotations/host-actions";
import type { Bootstrap, SiteAction, SpaceWithTree, TreeEntry } from "../types";
import { manageSidebar } from "./manage";
import { APP_BASE, documentRoute, localePrefix, MANAGE_PREFIX, softNavigate } from "./paths";
import { app } from "./runtime-data";
import { t } from "../i18n";
import { sitePath } from "./site-base";

type SidebarEntry =
  | { readonly sectionHeaderText: string }
  | { readonly text: string; readonly link?: string; readonly items?: readonly SidebarEntry[]; readonly collapsible?: boolean; readonly collapsed?: boolean };

export function sidebarOf(space: SpaceWithTree, prefix: string, lang = ""): SidebarEntry[] {
  const childrenOf = (parent: string | null) => space.tree.filter(entry => entry.parentId === parent);
  const titleOf = (entry: TreeEntry) => entry.titles?.[lang] ?? entry.title;
  const toItem = (entry: TreeEntry): SidebarEntry => {
    const children = childrenOf(entry.id);
    const link = documentRoute(space.slug, entry.path, prefix);
    if (children.length === 0) return { text: titleOf(entry), link };
    return { text: titleOf(entry), ...(entry.hasContent ? { link } : {}), items: children.map(toItem), collapsible: true, collapsed: false };
  };
  // The official sidebar groups pages under headings. A top-level page that only holds its children is that heading.
  return childrenOf(null).flatMap(entry => {
    const children = childrenOf(entry.id);
    return children.length > 0 && !entry.hasContent ? [{ sectionHeaderText: titleOf(entry) }, ...children.map(toItem)] : [toItem(entry)];
  });
}

/** Room in the top bar for spaces' names, in widths of a Latin letter, with the gap after each. A Chinese character takes two. */
const NAV_ROOM = 64;
const NAV_GAP = 4;
const widthOf = (text: string) => [...text].reduce((width, character) => width + (/[\u2e80-\uffff]/u.test(character) ? 2 : 1), NAV_GAP);

/**
 * Names never wrap, since the bar does not grow to hold them: the spaces that fit are listed, and the rest are under
 * one more item. Squeezed in, every name became a column of a few characters that the window cut off.
 */
function navOf({ site, spaces }: Bootstrap, prefix: string) {
  if (site.nav) return site.nav.map(item => ({ ...item, ...(item.link ? { link: item.link.startsWith("/") ? `${prefix}${item.link}` : item.link } : {}) }));
  const items = spaces.map(space => ({ text: space.name, link: `${prefix}/${space.slug}/`, activeMatch: `^${prefix}/${space.slug}(/|$)` }));
  let room = NAV_ROOM - widthOf(t("More spaces"));
  let shown = 0;
  while (shown < items.length && widthOf(items[shown]!.text) <= room) room -= widthOf(items[shown++]!.text);
  // All of them fit without the extra item taking room.
  if (items.slice(shown).reduce((width, item) => width + widthOf(item.text), 0) <= room + widthOf(t("More spaces"))) return items;
  return [...items.slice(0, shown), { text: shown === 0 ? t("Spaces") : t("More spaces"), items: items.slice(shown) }];
}

const menuIcon = (icon: LucideIcon) => React.createElement(icon, { size: 16, "aria-hidden": true });

function pageMenuItem(action: SiteAction) {
  return { title: action.label, icon: menuIcon(Sparkles), onClick: () => runHostAction(action, { url: location.href, title: document.title, text: "" }) };
}

const pageMenuViews = () => [
  { title: t("Present"), icon: menuIcon(Presentation), onClick: () => softNavigate(`${location.pathname}?view=slides`) },
  { title: t("Mind map"), icon: menuIcon(Network), onClick: () => softNavigate(`${location.pathname}?view=mindmap`) },
  { title: t("View source"), icon: menuIcon(Code), onClick: () => softNavigate(`${location.pathname}?view=source`) },
  { title: t("Export PDF"), icon: menuIcon(FileDown), onClick: () => print() }
];

/**
 * The theme starts root-relative images from its own base, and leaves alone what already starts with it, as Pandocs' own
 * files do below the site's path. Under an embed's base they do not, and a logo like `/brand.png` belongs to the host.
 */
const fromOrigin = (src: string) => (src.startsWith("/") && !src.startsWith(APP_BASE) ? `${app.origin}${src}` : src);

/** Pandocs' own mark until a site sets its own, as with its icon. The comparison with the official theme has none. */
export const logoOf = (site: { readonly logo: string }) => (import.meta.env.MODE === "parity" ? site.logo : site.logo || sitePath("/logo.svg"));

export function buildSiteData(bootstrap: Bootstrap): SiteData {
  const { site, spaces } = bootstrap;
  const locales = site.locales.map(({ lang, label }) => {
    const prefix = localePrefix(lang, site.defaultLang);
    return {
      lang,
      label,
      nav: navOf(bootstrap, prefix),
      sidebar: { ...Object.fromEntries(spaces.map(space => [`${prefix}/${space.slug}/`, sidebarOf(space, prefix, lang)])), [`${prefix}${MANAGE_PREFIX}/`]: manageSidebar(bootstrap, prefix) }
    };
  });
  return {
    base: APP_BASE,
    siteOrigin: app.origin,
    title: site.title,
    description: site.description,
    icon: fromOrigin(site.logo),
    route: { useTransitions: true, cleanUrls: true },
    themeConfig: {
      locales,
      sidebar: Object.assign({}, ...locales.map(locale => locale.sidebar)),
      nav: Object.fromEntries(locales.map(locale => [locale.lang, locale.nav])),
      footer: { message: site.footer },
      lastUpdated: true,
      socialLinks: site.socialLinks.map(({ icon, link }) => ({ icon, mode: "link", content: link })),
      // The chat services cannot read a page behind a login, so the page menu only offers what works here.
      llmsUI: { viewOptions: ["markdownLink", ...site.actions.map(pageMenuItem), ...pageMenuViews()] },
      // Present so the theme shows its "edit this page" entries; src/theme decides where they lead.
      editLink: { docRepoBaseUrl: APP_BASE }
    },
    lang: site.defaultLang,
    locales: site.locales,
    logo: fromOrigin(logoOf(site)),
    logoText: site.title,
    logoHref: "",
    multiVersion: { default: "", versions: [] },
    // Searching is a way of finding out what else is there, which a share link is not for.
    search: shared ? false : { mode: "local", versioned: false },
    markdown: { showLineNumbers: false, defaultWrapCode: false, shiki: {} }
  } as unknown as SiteData;
}
