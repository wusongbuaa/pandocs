import { existsSync } from "node:fs";
import { join } from "node:path";
import { inLanguage, isLanguage, LANGUAGE_COOKIE, pickLanguage, type Language } from "@pandocs/i18n";
import { readCookie } from "../auth/identity.js";
import type { Principal } from "@pandocs/core";
import { createRenderPool, type PreparedAnswer, type RenderedPage, type RenderInput, type RenderPool } from "./render-pool.js";

const API_PATH = "/api/v1";
const STATE_ELEMENT_ID = "pandocs-state";
const HOME_DOCUMENT_PATH = "index";
const MANAGE_SEGMENT = "_";
/**
 * Rendering takes about 1.2 MB of memory for every KB of Markdown, on top of the server. A document longer than this is
 * left to the browser it is going to anyway, as it would take a replica's memory limit into account otherwise.
 */
const RENDER_LIMIT_CHARS = 200 * 1024;

/** The parts of the API's `bootstrap` that say which pages there are. */
interface PageList {
  readonly site: { readonly defaultLang: string; readonly locales: readonly { readonly lang: string }[] };
  readonly spaces: readonly { readonly slug: string; readonly tree: readonly { readonly id: string; readonly path: string }[] }[];
}

export type PageAddress =
  /** The page is here, and the request asked for it some other way. */
  | { readonly kind: "elsewhere"; readonly to: string; readonly permanent: boolean }
  | { readonly kind: "document"; readonly id: string; readonly lang: string | null }
  /** Nothing is here now. In a space that exists, the page may have moved. */
  | { readonly kind: "unknown"; readonly space: string | null; readonly path: string; readonly prefix: string }
  /** A page that needs nothing beyond the list of pages, or an address only the theme has something to say about. */
  | { readonly kind: "other" };

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
/** The theme's rules for matching an address: letter case, `.html` and `/index` make no difference. */
const matchable = (path: string) => path.replace(/\.html$/iu, "").replace(/(?:^|\/)index$/iu, "").toLowerCase();

/** Which page an address is. A page has one address, and the others lead there, as the app would otherwise rewrite them once running. */
export function locatePage({ site, spaces }: PageList, pathname: string): PageAddress {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A stray percent sign is no page's address, and asking for one is no reason to fail.
    return { kind: "unknown", space: null, path: pathname, prefix: "" };
  }
  const segments = decoded.split("/").filter(Boolean);
  // A site's own language has no prefix, and addresses that spell it out still work: the theme would send them on from the browser.
  if (segments[0] === site.defaultLang && !spaces.some(({ slug }) => slug === segments[0])) return { kind: "elsewhere", to: `/${encodePath(segments.slice(1).join("/"))}`, permanent: true };
  const lang = site.locales.some(({ lang: item }) => item === segments[0] && item !== site.defaultLang) ? segments.shift()! : null;
  const prefix = lang ? `/${lang}` : "";
  const [first, ...rest] = segments;
  if (first === undefined) {
    if (lang) return decoded === `${prefix}/` ? { kind: "other" } : { kind: "elsewhere", to: `${prefix}/`, permanent: true };
    return spaces.length === 1 ? { kind: "elsewhere", to: `/${encodePath(spaces[0]!.slug)}/`, permanent: false } : { kind: "other" };
  }
  if (first === MANAGE_SEGMENT) return { kind: "other" };
  const space = spaces.find(({ slug }) => slug.toLowerCase() === first.toLowerCase());
  const path = rest.join("/");
  if (!space) return { kind: "unknown", space: null, path, prefix };
  const wanted = matchable(path);
  const entry = space.tree.find(item => matchable(item.path) === wanted);
  if (!entry && wanted) return { kind: "unknown", space: space.slug, path, prefix };
  const page = entry && entry.path !== HOME_DOCUMENT_PATH ? entry.path : "";
  const address = `${prefix}/${space.slug}/${page}`;
  if (address !== decoded) return { kind: "elsewhere", to: `${prefix}/${encodePath(space.slug)}/${encodePath(page)}`, permanent: true };
  return entry ? { kind: "document", id: entry.id, lang } : { kind: "other" };
}

/** Where the build says a page with formulas finds their styles. */
const MATH_STYLES = /<meta name="pandocs-math-styles" content="([^"]*)">/gu;

/** What someone chose, then the language an address is in, then what they ask for. Something asking for nothing, such as a search engine, reads what the site is written in. */
export async function languageOfPage(request: Request, pathname: string, defaultLang: () => Promise<string>): Promise<Language> {
  const chosen = readCookie(request, LANGUAGE_COOKIE);
  if (isLanguage(chosen)) return chosen;
  // No space can be called `zh` or `en`, so an address starting with one is in that language.
  const prefix = pathname.split("/")[1];
  if (isLanguage(prefix)) return prefix;
  const asked = request.headers.get("accept-language");
  if (asked) return pickLanguage(asked);
  const lang = await defaultLang();
  return isLanguage(lang) ? lang : pickLanguage(null);
}

export function assemblePage(template: string, language: Language, page: RenderedPage | null, state: Pick<RenderInput, "origin" | "answers">): string {
  if (!page) return template.replace("<html", () => `<html data-language="${language}"`);
  // Inside a script element, where the only thing that could end it early is a tag.
  const json = JSON.stringify(state).replaceAll("<", "\\u003c");
  return template
    .replace(MATH_STYLES, (_tag, href: string) => (page.html.includes('class="katex') ? `<link rel="stylesheet" crossorigin href="${href}">` : ""))
    .replace(/<html[^>]*>/u, () => `<html data-language="${language}"${page.htmlAttrs}>`)
    .replace(/<title>[^<]*<\/title>/u, () => page.headTags)
    .replace(/<!--pandocs-page-->[^]*<!--\/pandocs-page-->/u, () => page.html)
    .replace("<!--pandocs-state-->", () => `<script id="${STATE_ELEMENT_ID}" type="application/json">${json}</script>`);
}

export type PageOutcome =
  | { readonly kind: "redirect"; readonly to: string; readonly status: 301 | 302 }
  | { readonly kind: "page"; readonly status: number; readonly html: string; readonly documentId?: string };

/** Everything between someone asking for a page and the HTML for it. Without a rendering build, or when rendering fails, the app renders in the browser as it can. */
export function createPageRendering(deps: {
  readonly webDir: string;
  readonly enabled: boolean;
  readonly origin: string;
  /** The site's path below its host, such as `/docs`, which the pages' own links start with. Empty at the root. */
  readonly base?: string;
  readonly api: (request: Request, principal: Principal) => Promise<Response>;
  readonly log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}) {
  const workerFile = join(deps.webDir, "ssr", "worker.mjs");
  const built = deps.enabled && existsSync(workerFile);
  const log = deps.log ?? ((event, fields) => console.warn(JSON.stringify({ event, ...fields })));
  let pool: RenderPool | null = null;

  return {
    /** `template` is the built `index.html`. */
    async answer(template: string, address: { readonly pathname: string; readonly search: string }, principal: Principal, language: Language): Promise<PageOutcome> {
      const { pathname, search } = address;
      const unrendered: PageOutcome = { kind: "page", status: 200, html: assemblePage(template, language, null, { origin: deps.origin, answers: {} }) };
      if (!built) return unrendered;
      const ask = async (path: string): Promise<PreparedAnswer> => {
        const response = await inLanguage(language, () => deps.api(new Request(`${deps.origin}${API_PATH}/${path}`, { headers: { "accept-language": language } }), principal));
        return { status: response.status, payload: await response.json().catch(() => null) };
      };
      const bootstrap = await ask("bootstrap");
      const list = (bootstrap.payload as { data?: PageList } | null)?.data;
      if (!list) return unrendered;
      const answers: Record<string, PreparedAnswer> = { bootstrap };
      const located = locatePage(list, pathname);
      if (located.kind === "elsewhere") return { kind: "redirect", to: `${located.to}${search}`, status: located.permanent ? 301 : 302 };
      if (located.kind === "unknown" && located.space !== null) {
        const moved = await ask(`spaces/${encodeURIComponent(located.space)}/resolve?path=${encodeURIComponent(located.path)}`);
        // A page that has not moved is one the list does not have yet, as can happen for a moment: what a visitor sees is shared and a few seconds old.
        const { path, redirected } = (moved.payload as { data?: { path?: string; redirected?: boolean } } | null)?.data ?? {};
        if (path && redirected) return { kind: "redirect", to: `${located.prefix}/${encodePath(located.space)}/${path === HOME_DOCUMENT_PATH ? "" : encodePath(path)}${search}`, status: 301 };
      }
      if (located.kind === "document") {
        const reads = [`documents/${located.id}`, ...(located.lang ? [`documents/${located.id}/translations/${located.lang}`] : [])];
        await Promise.all(reads.map(async read => { answers[read] = await ask(read); }));
        const long = reads.some(read => ((answers[read]?.payload as { data?: { markdown?: string } } | null)?.data?.markdown?.length ?? 0) > RENDER_LIMIT_CHARS);
        if (long) return unrendered;
      }
      pool ??= createRenderPool(workerFile, { log, base: deps.base ?? "" });
      const page = await pool.render(language, { url: `${pathname}${search}`, origin: deps.origin, answers });
      return {
        kind: "page",
        status: page?.status ?? (located.kind === "unknown" ? 404 : 200),
        html: assemblePage(template, language, page, { origin: deps.origin, answers }),
        ...(located.kind === "document" ? { documentId: located.id } : {})
      };
    },
    stop(): void {
      pool?.stop();
    }
  };
}

export type PageRendering = ReturnType<typeof createPageRendering>;
