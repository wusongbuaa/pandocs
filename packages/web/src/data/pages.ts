import * as React from "react";
import type { Route } from "@rspress/shared";
import { api, ApiError } from "../api/client";
import { embedded, embedShowsSidebar, shared } from "../embed/session";
import { layoutFromContent, layoutFromFrontMatter } from "../markdown/front-matter";
import { renderMarkdown, type RenderedMarkdown } from "../markdown/pipeline";
import { LocalTime } from "../ui/local-time";
import { atLeast, type Bootstrap, type DocumentView, type Space, type SpaceWithTree, type TranslationView, type TreeEntry } from "../types";
import { managePages, manageRoute, spaceManageRoute, type ManageSpec } from "./manage";
import { logoOf } from "./site";
import { documentRoute, HOME_DOCUMENT_PATH, localePrefix } from "./paths";
import { t } from "../i18n";

/** What a loaded page carries next to the fields the theme reads; the document body renders from this. */
export interface PandocsPage {
  readonly kind: "document";
  readonly space: Space;
  readonly entry: TreeEntry;
  readonly view: DocumentView;
  readonly rendered: RenderedMarkdown;
  /** Set on a language other than the one pages are written in. */
  readonly translation: PageTranslation | null;
}

export interface PageTranslation {
  readonly lang: string;
  readonly label: string;
  /** False when the page is showing its source because nobody has translated it yet. */
  readonly exists: boolean;
  readonly stale: boolean;
  readonly machine: boolean;
  readonly canEdit: boolean;
  /** When the translation shown was saved, so that saving after someone else merges with what they did. */
  readonly updatedAt?: string | undefined;
}

/** Someone who may not edit can still suggest changes to the source, whichever language they are reading in. */
export function editorModeOf(page: PandocsPage): "edit" | "propose" | "translate" {
  if (page.translation?.canEdit) return "translate";
  return atLeast(page.view.role, "editor") && !page.space.mergeRules?.requireChangeSets ? "edit" : "propose";
}

export type AppPage = PandocsPage | { readonly kind: "manage"; readonly spec: ManageSpec } | { readonly kind: "home"; readonly site?: true };

let bodySlot: React.ComponentType = () => null;

/** The body component imports the theme, which must not load before the routes exist; so routes point here and it arrives later. */
export function setDocumentBody(body: React.ComponentType): void {
  bodySlot = body;
}

function PageBody() {
  return React.createElement(bodySlot);
}

const FRESH_MS = 30_000;
const loaded = new Map<string, { at: number; page: Promise<Record<string, unknown>> }>();

/** Forget loaded pages, so the next visit or revalidation shows what was just saved. */
export function invalidatePages(): void {
  loaded.clear();
}

/**
 * A page written in the home layout has nowhere for the editor to go, so while it is being edited it is shown as a
 * document. Only a page someone wrote: a space's front page nobody has written is not one to edit.
 */
export function asEditable<Page extends { readonly pageType?: string; readonly frontmatter?: Readonly<Record<string, unknown>> }>(page: Page, mode: string | null): Page {
  const kind = (page as { readonly pandocs?: { readonly kind?: string } }).pandocs?.kind;
  if (mode !== "edit" || page.pageType !== "home" || kind !== "document") return page;
  return { ...page, pageType: "doc", frontmatter: { ...page.frontmatter, pageType: "doc" } };
}

/** The page around an embedded one has its own navigation. A share link has none around it, and needs a sidebar only if it covers several pages. */
const embedLayout = (space: SpaceWithTree) => ({ navbar: false, footer: false, ...(embedShowsSidebar || (shared && space.tree.length > 1) ? {} : { sidebar: false }) });

/**
 * What a route loads when its page is not there, such as one deleted since the list of pages was made. The theme reads
 * page data from every module's `default` before anything else, so this one needs it too, or the page fails to render.
 */
export const notFoundPage = (extra: Readonly<Record<string, unknown>> = {}) => ({ default: PageBody, title: "404", toc: [], frontmatter: { pageType: "404" }, ...extra });
const NOT_FOUND = notFoundPage();

interface PageLocale {
  readonly lang: string;
  readonly label: string;
  readonly source: boolean;
}

/**
 * A translated page shows the translation, with what depends on the source's text switched off by reading it as a
 * viewer: comments and suggestions are anchored to the source. Without a translation the page is simply the source.
 */
async function translationOf(view: DocumentView, locale: PageLocale): Promise<{ view: DocumentView; title: string; translation: PageTranslation | null }> {
  const title = view.document.title;
  if (locale.source) return { view, title, translation: null };
  const base = { lang: locale.lang, label: locale.label, canEdit: atLeast(view.role, "editor") };
  try {
    const found = await api.get<TranslationView>(`documents/${view.document.id}/translations/${locale.lang}`);
    return { view: { ...view, markdown: found.markdown, role: "viewer" }, title: found.title, translation: { ...base, exists: true, stale: found.stale, machine: found.machine, updatedAt: found.updatedAt } };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { view, title, translation: { ...base, exists: false, stale: false, machine: false } };
    throw error;
  }
}

async function loadDocument(space: SpaceWithTree, entry: TreeEntry, locale: PageLocale): Promise<Record<string, unknown>> {
  try {
    const source = await api.get<DocumentView>(`documents/${entry.id}`);
    const { view, title, translation } = await translationOf(source, locale);
    const rendered = await renderMarkdown(view.markdown ?? "", { title, glossary: space.glossary });
    const page: PandocsPage = { kind: "document", space, entry, view, rendered, translation };
    const layout = layoutFromFrontMatter(view.markdown ?? "");
    return {
      default: PageBody,
      title,
      headingTitle: rendered.headingTitle,
      description: layout.description ?? rendered.description,
      toc: rendered.toc,
      frontmatter: { ...layoutFromContent(view.markdown ?? ""), ...layout, ...(embedded ? embedLayout(space) : {}) },
      lastUpdatedTime: React.createElement(LocalTime, { at: view.revision.createdAt }),
      pandocs: page
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return NOT_FOUND;
    throw error;
  }
}

/** The theme also preloads on link hover, so one page's requests are shared for a short while. */
function cached(key: string, load: () => Promise<Record<string, unknown>>) {
  const hit = loaded.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.page;
  const page = load();
  loaded.set(key, { at: Date.now(), page });
  page.catch(() => loaded.delete(key));
  return page;
}

function pageRoute(path: string, lang: string, file: string, preload: () => Promise<Record<string, unknown>>): Route {
  return { path, element: React.createElement(PageBody), filePath: file, preload, lang, version: "" } as unknown as Route;
}

/** A space's front page in the official home layout, built from its own structure until someone writes an `index` page. */
function spaceHome(space: SpaceWithTree, lang: string, prefix: string): Route {
  const top = space.tree.filter(entry => entry.parentId === null);
  const first = space.tree.find(entry => entry.hasContent) ?? space.tree[0];
  const editable = atLeast(space.role, "editor");
  const text = { read: t("Start reading"), manage: t("Manage pages"), create: t("Create a page"), empty: t("Nothing here yet."), separator: t(", ") };
  const actions = [
    ...(first ? [{ theme: "brand", text: text.read, link: documentRoute(space.slug, first.path, prefix) }] : []),
    ...(editable ? [{ theme: first ? "alt" : "brand", text: first ? text.manage : text.create, link: `${spaceManageRoute(space.slug, "pages", prefix)}${first ? "" : "?new=1"}` }] : [])
  ];
  // The official grid has twelve columns; a few cards share a row evenly instead of leaving a gap.
  const span = top.length > 0 && top.length <= 4 ? 12 / top.length : 4;
  const features = top.map(entry => ({
    title: entry.titles?.[lang] ?? entry.title,
    details: space.tree.filter(child => child.parentId === entry.id).slice(0, 4).map(child => child.titles?.[lang] ?? child.title).join(text.separator),
    link: documentRoute(space.slug, (entry.hasContent ? entry : space.tree.find(child => child.parentId === entry.id) ?? entry).path, prefix),
    span
  }));
  return pageRoute(`${prefix}/${space.slug}/`, lang, `${space.slug}/index.doc`, async () => ({
    default: PageBody,
    title: space.name,
    description: space.description,
    toc: [],
    frontmatter: { pageType: "home", hero: { name: space.name, tagline: space.description || (first ? "" : text.empty), actions }, features },
    pandocs: { kind: "home" } satisfies AppPage
  }));
}

function spaceRoutes(space: SpaceWithTree, locale: PageLocale, prefix: string): Route[] {
  const { lang } = locale;
  const routes = space.tree.map(entry => pageRoute(documentRoute(space.slug, entry.path, prefix), lang, `${space.slug}/${entry.path}.doc`, () => cached(`document:${entry.id}:${lang}`, () => loadDocument(space, entry, locale))));
  return space.tree.some(entry => entry.path === HOME_DOCUMENT_PATH) ? routes : [...routes, spaceHome(space, lang, prefix)];
}

/** Inside the theme's document layout, so its sidebar is the navigation between them. */
function manageRoutes(bootstrap: Bootstrap, lang: string, prefix: string): Route[] {
  return managePages(bootstrap, prefix).map(({ path, spec }) => pageRoute(path, lang, `_manage${path}.doc`, async () => ({
    default: PageBody,
    title: spec.title,
    // These pages write their own heading; without this the theme adds one, with its copy buttons.
    headingTitle: spec.title,
    toc: [],
    frontmatter: spec.view === "api-reference" ? { pageType: "doc-wide", sidebar: false, outline: false, footer: false } : { pageType: "doc-wide", outline: false, footer: false },
    pandocs: { kind: "manage", spec } satisfies AppPage
  })));
}

/** The pages most recently saved across the spaces someone can read, newest first, for the site's front page. */
export function recentPages(spaces: readonly SpaceWithTree[], limit = 8): { space: SpaceWithTree; entry: TreeEntry }[] {
  return spaces
    .flatMap(space => space.tree.filter(entry => entry.hasContent).map(entry => ({ space, entry })))
    .sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, limit);
}

/** Only something to look at: which space is which is in its name. */
const SPACE_ICONS = ["📘", "📗", "📙", "📕", "📒", "📓"];

function homeRoute(bootstrap: Bootstrap, lang: string, prefix: string): Route {
  const { site, spaces, me } = bootstrap;
  // Whoever just set the site up lands here, with nothing yet to read.
  const start = spaces.length > 0 ? null : me.isAdmin
    ? { tagline: t("There are no spaces yet. Create one, then start writing in it."), actions: [{ theme: "brand", text: t("New space"), link: `${manageRoute("spaces", prefix)}?new=1` }, { theme: "alt", text: t("Import the sample documents"), link: `${manageRoute("spaces", prefix)}?sample=1` }] }
    : { tagline: t("There is nothing here you can read yet. Ask an administrator for access."), actions: [] };
  const actions = start?.actions ?? [
    { theme: "brand", text: t("Start reading"), link: `${prefix}/${spaces[0]!.slug}/` },
    ...(me.isAdmin ? [{ theme: "alt", text: t("Manage spaces"), link: manageRoute("spaces", prefix) }] : [])
  ];
  // A few cards share a row evenly, as on a space's front page.
  const span = spaces.length > 0 && spaces.length <= 4 ? 12 / spaces.length : 4;
  return pageRoute(`${prefix}/`, lang, "home.doc", async () => ({
    default: PageBody,
    title: site.title,
    toc: [],
    frontmatter: {
      pageType: "home",
      hero: { name: site.title, tagline: start?.tagline ?? site.description, image: { src: logoOf(site), alt: "" }, actions },
      features: spaces.map((space, index) => ({
        icon: SPACE_ICONS[index % SPACE_ICONS.length],
        title: space.name,
        details: space.description || t("{0} {0|page|pages}", space.tree.filter(entry => entry.hasContent).length),
        link: `${prefix}/${space.slug}/`,
        span
      }))
    },
    pandocs: { kind: "home", site: true } satisfies AppPage
  }));
}

export function buildRoutes(bootstrap: Bootstrap): Route[] {
  const { site, spaces } = bootstrap;
  return site.locales.flatMap(({ lang, label }) => {
    const prefix = localePrefix(lang, site.defaultLang);
    const locale = { lang, label, source: lang === site.defaultLang };
    return [homeRoute(bootstrap, lang, prefix), ...spaces.flatMap(space => spaceRoutes(space, locale, prefix)), ...manageRoutes(bootstrap, lang, prefix)];
  });
}

export function buildPages(bootstrap: Bootstrap) {
  const { site, spaces } = bootstrap;
  return site.locales.flatMap(({ lang }) => {
    const prefix = localePrefix(lang, site.defaultLang);
    const page = (routePath: string, title: string, file: string) => ({ routePath, lang, version: "", title, frontmatter: {}, toc: [], _filepath: file, _relativePath: file });
    return [
      page(`${prefix}/`, site.title, "home.doc"),
      ...spaces.flatMap(space => [
        ...(space.tree.some(entry => entry.path === HOME_DOCUMENT_PATH) ? [] : [page(`${prefix}/${space.slug}/`, space.name, `${space.slug}/index.doc`)]),
        ...space.tree.map(entry => page(documentRoute(space.slug, entry.path, prefix), entry.titles?.[lang] ?? entry.title, `${space.slug}/${entry.path}.doc`))
      ]),
      ...managePages(bootstrap, prefix).map(({ path, spec }) => page(path, spec.title, `_manage${path}.doc`))
    ];
  });
}
