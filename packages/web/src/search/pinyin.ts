import type { OnSearch } from "@rspress/core/theme";
import type { PageIndexInfo } from "@rspress/shared";
import { getSearchIndexURL } from "../../vendor/rspress/theme/components/Search/logic/providers/LocalProvider";
import { api } from "../api/client";
import { APP_BASE, documentRoute, localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";

interface IndexedTitle {
  readonly title: string;
  readonly link: string;
  readonly full: string;
  readonly initials: string;
}

const LOOKS_LIKE_PINYIN = /^[a-z][a-z' ]+$/iu;

const lastBuilt: { prefix: string; index: Promise<readonly IndexedTitle[]> | null } = { prefix: "", index: null };

/** The dictionary is the size of everything else on the page, so it only loads when someone types Latin letters. */
async function buildIndex(lang: string, prefix: string): Promise<readonly IndexedTitle[]> {
  const { pinyin } = await import("pinyin-pro");
  const plain = (text: string, pattern: "pinyin" | "first") => pinyin(text, { pattern, toneType: "none", type: "array", nonZh: "consecutive" }).join("").replace(/[^a-z0-9]/giu, "").toLowerCase();
  return app.bootstrap.spaces.flatMap(space => space.tree.map(entry => {
    const title = entry.titles?.[lang] ?? entry.title;
    return { title, link: documentRoute(space.slug, entry.path, prefix), full: plain(title, "pinyin"), initials: plain(title, "first") };
  }));
}

export async function pinyinMatches(query: string, lang: string, prefix: string): Promise<readonly IndexedTitle[]> {
  if (!LOOKS_LIKE_PINYIN.test(query.trim())) return [];
  if (!lastBuilt.index || lastBuilt.prefix !== prefix) {
    lastBuilt.prefix = prefix;
    lastBuilt.index = buildIndex(lang, prefix);
  }
  const typed = query.replace(/[' ]/gu, "").toLowerCase();
  return (await lastBuilt.index).filter(item => item.full.includes(typed) || item.initials.startsWith(typed));
}

function currentLocale(): { lang: string; prefix: string } {
  const { site } = app.bootstrap;
  const first = location.pathname.slice(APP_BASE.length).split("/")[0];
  const lang = site.locales.some(locale => locale.lang === first) ? first! : site.defaultLang;
  return { lang, prefix: localePrefix(lang, site.defaultLang) };
}

/** With several spaces, a result should say which one it came from. Highlights count from the start, so this goes after. */
function markSpaces(results: NonNullable<Parameters<OnSearch>[1][number]["result"]>, prefix: string): void {
  const { spaces } = app.bootstrap;
  if (spaces.length < 2) return;
  for (const item of results as { link: string; title: string; header?: string; type: string }[]) {
    const path = decodeURI(item.link).replace(APP_BASE, "/").replace(`${prefix}/`, "/");
    const name = spaces.find(space => path.startsWith(`/${space.slug}/`))?.name;
    if (!name) continue;
    if (item.type === "content") item.title = `${name} · ${item.title}`;
    else item.header = `${item.header} · ${name}`;
  }
}

interface ServerHit {
  readonly spaceSlug: string;
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
}

/** What the browser's index left out on a large site. A failed search should not take the other results with it. */
async function serverMatches(query: string, lang: string, prefix: string) {
  const text = query.trim();
  if (!app.bootstrap.fullTextOnServer || !text) return [];
  const hits = await api.get<ServerHit[]>(`search?q=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}`).catch(() => [] as ServerHit[]);
  return hits.map(hit => {
    const at = hit.snippet.toLowerCase().indexOf(text.toLowerCase());
    return {
      type: "content" as const,
      title: hit.title,
      header: hit.title,
      link: documentRoute(hit.spaceSlug, hit.path, prefix),
      query,
      statement: hit.snippet,
      highlightInfoList: at >= 0 ? [{ start: at, length: text.length }] : []
    };
  });
}

interface WrittenPage {
  readonly title: string;
  readonly link: string;
  readonly content: string;
  readonly lowerTitle: string;
  readonly lowerContent: string;
}

const MOST_EXACT = 10;
const written = new Map<string, Promise<readonly WrittenPage[]>>();

/** The same list of pages the theme searches, kept as it is written. */
function writtenPages(lang: string): Promise<readonly WrittenPage[]> {
  const url = getSearchIndexURL(lang, "");
  if (!url) return Promise.resolve([]);
  let pages = written.get(url);
  if (!pages) {
    pages = fetch(url)
      .then(response => (response.ok ? response.json() as Promise<PageIndexInfo[]> : []))
      .then(list => list.map(page => ({ title: page.title, link: page.routePath, content: page.content ?? "", lowerTitle: page.title.toLowerCase(), lowerContent: (page.content ?? "").toLowerCase() })));
    const cached = pages;
    cached.catch(() => written.delete(url));
    written.set(url, cached);
  }
  return pages;
}

/**
 * The theme's index folds a repeated letter into one and cuts numbers into threes, so a code such as QA-0599 matches
 * every page from 0590 to 0599 alike, and the one that has it can fall past the few results shown. Pages with what was
 * typed, as it is written, come first.
 */
export async function exactMatches(query: string, lang: string) {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const found: { type: "title" | "content"; title: string; header: string; link: string; query: string; statement?: string; highlightInfoList: { start: number; length: number }[] }[] = [];
  for (const page of await writtenPages(lang).catch(() => [] as readonly WrittenPage[])) {
    if (page.lowerTitle.includes(needle)) {
      found.push({ type: "title", title: page.title, header: page.title, link: page.link, query, highlightInfoList: [] });
    } else {
      const at = page.lowerContent.indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 40);
      found.push({ type: "content", title: page.title, header: page.title, link: page.link, query, statement: page.content.slice(start, at + needle.length + 80), highlightInfoList: [{ start: at - start, length: needle.length }] });
    }
    if (found.length >= MOST_EXACT) break;
  }
  return found;
}

/** The theme's index matches the characters of a page. This adds its title by how it is pronounced, so `rz` finds 认证, and the full text of a large site. */
export const onSearch: OnSearch = async (query, matched) => {
  const results = matched[0]?.result;
  if (!results) return [];
  const { lang, prefix } = currentLocale();
  const known = new Set(results.map(item => item.link.split("#")[0]));
  const exact = (await exactMatches(query, lang)).filter(item => !known.has(item.link));
  for (const item of exact) known.add(item.link);
  const extra = (await pinyinMatches(query, lang, prefix)).filter(item => !known.has(item.link));
  results.unshift(...exact as typeof results, ...extra.map(item => ({ type: "title" as const, title: item.title, header: item.title, link: item.link, query, highlightInfoList: [] })));
  for (const hit of await serverMatches(query, lang, prefix)) {
    if (!known.has(hit.link)) results.push(hit);
  }
  markSpaces(results, prefix);
  return [];
};
