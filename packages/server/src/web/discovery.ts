import { ANONYMOUS_PRINCIPAL, type PandocsServices } from "@pandocs/core";
import { assetHash } from "@pandocs/markdown";

const HOME_DOCUMENT_PATH = "index";
/** The most one sitemap file may list. */
const SITEMAP_LIMIT = 50_000;

const escapeXml = (text: string) => text.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The login and the app's own pages lead nowhere for a crawler. A site with nothing public has nothing to crawl. */
export function robotsTxt(open: boolean, siteUrl: string): string {
  // Below a path, crawlers read the host's own file rather than this one, which says what to put in it.
  const base = new URL(siteUrl).pathname.replace(/\/$/u, "");
  if (!open) return `User-agent: *\nDisallow: ${base}/\n`;
  return ["User-agent: *", `Allow: ${base}/`, ...["/_/", "/api/", "/auth/", "/embed/", "/login", "/logout"].map(path => `Disallow: ${base}${path}`), "", `Sitemap: ${siteUrl}/sitemap.xml`, ""].join("\n");
}

/** Every page someone with no login can read, in each language it has been written in. A space's front page is only made of links to these. */
export async function sitemapXml(services: PandocsServices, origin: string): Promise<string> {
  const { defaultLang } = await services.site.get();
  const spaces = await services.spaces.list(ANONYMOUS_PRINCIPAL);
  const entries: { readonly path: string; readonly updatedAt: string }[] = [];
  for (const space of spaces) {
    const tree = await services.documents.tree(ANONYMOUS_PRINCIPAL, space.slug);
    const base = `/${encodeURIComponent(space.slug)}/`;
    for (const node of tree) {
      if (!node.hasContent) continue;
      const path = node.path === HOME_DOCUMENT_PATH ? "" : encodePath(node.path);
      const updatedAt = new Date(node.updatedAt).toISOString();
      entries.push({ path: `${base}${path}`, updatedAt });
      for (const lang of Object.keys(node.titles ?? {})) if (lang !== defaultLang) entries.push({ path: `/${lang}${base}${path}`, updatedAt });
    }
  }
  const urls = entries.slice(0, SITEMAP_LIMIT).map(({ path, updatedAt }) => `  <url><loc>${escapeXml(`${origin}${path}`)}</loc><lastmod>${updatedAt}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu;
const INLINE_LINK = /(\]\(\s*<?)([^\s)>]+)/gu;
const LINK_DEFINITION = /^( {0,3}\[(?!\^)[^\]]+\]:\s*<?)([^\s>]+)/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
/** Blocks that stand for a file say which in an attribute. */
const FILE_BLOCK = /^ {0,3}::[a-z]/iu;
const FILE_ATTRIBUTE = /(\b(?:src|poster|before|after)=")([^"]+)/gu;

/**
 * Whatever reads a page's Markdown may well keep it without the address it came from, so its links and images say where they
 * lead in full. Works on the text, because a page's source is otherwise left as written; code stays as it is.
 */
export function absoluteLinks(markdown: string, page: string, assets: string): string {
  const absolute = (target: string) => {
    if (NOT_RELATIVE.test(target)) return target;
    const hash = assetHash(target);
    if (hash) return `${assets}/${hash}`;
    return URL.canParse(target, page) ? new URL(target, page).href : target;
  };
  const rewrite = (_match: string, before: string, target: string) => `${before}${absolute(target)}`;
  let fence = "";
  return markdown.split("\n").map(line => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    if (FILE_BLOCK.test(line)) return line.replace(FILE_ATTRIBUTE, rewrite);
    return line.split(/(`[^`]*`)/u).map((part, at) => (at % 2 === 1 ? part : part.replace(INLINE_LINK, rewrite))).join("").replace(LINK_DEFINITION, rewrite);
  }).join("\n");
}
