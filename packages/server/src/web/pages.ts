import { createHash } from "node:crypto";
import { ANONYMOUS_PRINCIPAL, PandocsError, siteStyles, type PandocsServices, type Principal } from "@pandocs/core";
import { t } from "@pandocs/i18n";
import { splitFrontMatter } from "@pandocs/markdown";
import type { Context, Hono } from "hono";
import type { EmbedApps } from "../auth/embed.js";
import { compress } from "hono/compress";
import { clientAddress } from "../client-address.js";
import type { Identity } from "../auth/identity.js";
import type { PublicAccess } from "../public-access.js";
import { CSP_HEADER, embedCsp, pageCsp } from "./csp.js";
import { absoluteLinks, robotsTxt, sitemapXml } from "./discovery.js";
import { languageOfPage, type PageRendering } from "./rendering.js";
import type { StaticFiles } from "./static.js";

const NO_STORE = { "Cache-Control": "no-store" };
const plainText = (status: number, body: string) =>
  new Response(body, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
const LLMS_PATH = /^((?:\/[^/]+){0,2})\/(llms|llms-full)\.txt$/u;
const EMBED_PATH = /^\/embed\/([a-z0-9][a-z0-9-]*)(\/.*)?$/u;
/** The icons `index.html` names, one after another, which a site's own favicon replaces. */
const ICON_LINKS = /[ \t]*<link rel="(?:icon|apple-touch-icon)"[^>]*>\n?/gu;

/** Pandocs' icons, or the site's own, which settings keep to an address or a small image. */
export function withFavicon(html: string, favicon: string): string {
  if (!favicon) return html;
  const href = favicon.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
  let first = true;
  return html.replace(ICON_LINKS, () => {
    if (!first) return "";
    first = false;
    return `    <link rel="icon" href="${href}" />\n    <link rel="apple-touch-icon" href="${href}" />\n`;
  });
}

const SHARE_PATH = /^\/s\/(pds_[\w-]+)(\/.*)?$/u;
const MANAGE_PREFIX = "/_/";
/** They do not run what is on a page, so nothing else would count them. Search engines are not on this list: they are not reading for anyone. */
const AI_CRAWLER =
  /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|PerplexityBot|Perplexity-User|Bytespider|CCBot|cohere-ai|Amazonbot|meta-externalagent|MistralAI-User|DuckAssistBot|YouBot/iu;

/** Whether this asks for Markdown ahead of HTML, the way agents ask for a page. A browser's list does not mention it. */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  const ranked = (accept ?? "").split(",").map(part => {
    const [type = "", ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.map(parameter => /^\s*q=([\d.]+)/u.exec(parameter)?.[1]).find(Boolean);
    return { type: type.trim(), weight: quality === undefined ? 1 : Number(quality) };
  });
  const markdown = ranked.findIndex(({ type }) => type === "text/markdown");
  if (markdown < 0 || ranked[markdown]!.weight === 0) return false;
  const html = ranked.findIndex(({ type }) => type === "text/html");
  if (html < 0) return true;
  const difference = ranked[markdown]!.weight - ranked[html]!.weight;
  return difference > 0 || (difference === 0 && markdown < html);
}

/** Someone copying a page from the app wants the page and nothing else; the note is for whatever else comes across it. */
function fromTheSiteItself(request: Request): boolean {
  const referer = request.headers.get("referer");
  if (!referer || !URL.canParse(referer)) return false;
  return new URL(referer).host === request.headers.get("host");
}

/** Asked for on every page, and it hardly ever changes. An administrator saving a new colour should see it on their next page, so it is checked rather than kept. */
function siteStylesheet(c: Context, css: string): Response {
  const etag = `"${createHash("sha256").update(css).digest("hex").slice(0, 16)}"`;
  const headers = { "Cache-Control": "no-cache", ETag: etag };
  if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(css, { headers: { ...headers, "Content-Type": "text/css; charset=utf-8" } });
}

export function registerPageRoutes(
  app: Hono,
  deps: {
    identity: Identity;
    services: PandocsServices;
    files: StaticFiles;
    embedApps: EmbedApps;
    publicAccess: PublicAccess;
    rendering: PageRendering;
    origin: string;
    trustProxy: number;
    readonly base?: string;
  }
): void {
  const { identity, services, files, embedApps, publicAccess, rendering, origin, trustProxy, base = "" } = deps;
  const pagePolicy = pageCsp(base);

  const tooMany = () => {
    const limited = plainText(429, t("Too many requests. Try again later."));
    limited.headers.set("Retry-After", "60");
    return limited;
  };

  /** These addresses also take API tokens, so an agent can read what the person it works for can read. */
  const asReader = async (c: Context, respond: (principal: Principal) => Promise<Response>): Promise<Response> => {
    const auth = await identity.authenticate(c.req.raw);
    const visitor = !auth.ok && auth.code === "UNAUTHENTICATED" && (await publicAccess.open());
    if (!auth.ok && !visitor) return plainText(auth.status, auth.message);
    if (visitor && !publicAccess.allowRequest(clientAddress(c, trustProxy), new URL(c.req.url).pathname))
      return tooMany();
    try {
      return await respond(auth.ok ? auth.principal : ANONYMOUS_PRINCIPAL);
    } catch (error) {
      if (error instanceof PandocsError) return plainText(error.status, error.message);
      throw error;
    }
  };

  /** One of the site's languages other than the one its pages are written in, as the first part of an address. */
  const translatedLang = async (segment: string | undefined): Promise<string | undefined> => {
    const { locales, defaultLang } = await services.site.get();
    return locales.some(({ lang }) => lang === segment && lang !== defaultLang) ? segment : undefined;
  };

  /**
   * Under a share link, what is read is read with the link, and what is linked to stays under it, where whoever has the
   * link can follow it. A share page tells agents these addresses, and they should work for anyone it was shared with.
   */
  const asLinkHolder = async (
    token: string,
    respond: (principal: Principal) => Promise<Response>
  ): Promise<Response> => {
    const principal = await services.shareLinks.principalOf(token);
    if (!principal) return plainText(404, t("This link does not work any more. Ask whoever sent it for a new one."));
    try {
      return await respond(principal);
    } catch (error) {
      if (error instanceof PandocsError) return plainText(error.status, error.message);
      throw error;
    }
  };
  const readerOf = (c: Context, share: string | undefined) => (respond: (principal: Principal) => Promise<Response>) =>
    share ? asLinkHolder(share, respond) : asReader(c, respond);
  const siteFor = (share: string | undefined) => (share ? `${origin}/s/${share}` : origin);

  const llmsResponse = (c: Context, scope: string, file: string, share?: string) =>
    readerOf(
      c,
      share
    )(async principal => {
      const segments = scope.split("/").filter(Boolean).map(decodeURIComponent);
      const lang = await translatedLang(segments[0]);
      if (lang) segments.shift();
      if (segments.length > 1) return plainText(404, t("No such page"));
      const options = { origin: siteFor(share), lang };
      return plainText(
        200,
        file === "llms"
          ? await services.llms.index(principal, segments[0], options)
          : await services.llms.full(principal, segments[0], options)
      );
    });

  const markdown = (body: string, headers: Readonly<Record<string, string>> = {}) =>
    new Response(body, {
      headers: { ...NO_STORE, "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", ...headers }
    });
  const indexNote = (lang: string | undefined, site = origin) =>
    `> For the complete documentation index, see [llms.txt](${site}${lang ? `/${lang}` : ""}/llms.txt).\n\n`;

  /** `/<space>/<path>.md`: what "copy Markdown" fetches, and a stable address for tokens and agents. A front page written by nobody lists what is under it. */
  const markdownResponse = (c: Context, pathname: string, share?: string) =>
    readerOf(
      c,
      share
    )(async principal => {
      const request = c.req.raw;
      const site = siteFor(share);
      const segments = pathname.replace(/\.md$/u, "").split("/").filter(Boolean).map(decodeURIComponent);
      const lang = await translatedLang(segments[0]);
      if (lang) segments.shift();
      const options = { origin: site, lang };
      if (segments.length === 0 || (segments.length === 1 && segments[0] === "index"))
        return markdown(await services.llms.index(principal, undefined, options));
      const [space, ...rest] = segments;
      const path = rest.join("/") || "index";
      const id = await services.documents.resolvePath(principal, space ?? "", path).catch(async (error: unknown) => {
        if (path === "index" && error instanceof PandocsError && error.status === 404) return null;
        throw error;
      });
      if (id === null) return markdown(await services.llms.index(principal, space, options));
      const { document, markdown: source = "", revision } = await services.documents.read(principal, id);
      const translation = lang
        ? await services.translations.get(principal, id, lang).catch(error => {
            if (error instanceof PandocsError && error.status === 404) return null;
            throw error;
          })
        : null;
      const title = translation?.title ?? document.title;
      // Front matter only means something at the very top of a file, which is not where this puts it.
      const { body: text } = splitFrontMatter(translation?.markdown ?? source);
      const page = text.trimStart().startsWith(`# ${title}\n`) ? text.trimStart() : `# ${title}\n\n${text.trimStart()}`;
      if (fromTheSiteItself(request)) return markdown(page, { ETag: `"${revision.sha256}"` });
      services.stats.countView(document.id, "agent");
      const address = `${site}${lang ? `/${lang}` : ""}/${encodeURIComponent(space!)}/${path === "index" ? "" : path.split("/").map(encodeURIComponent).join("/")}`;
      // Someone with a link reads and does no more, so there is nothing to tell them about saying what is wrong.
      const reportNote = share
        ? ""
        : `> Something wrong on this page? POST {"kind":"report","body":"what is wrong"} to ${origin}/api/v1/documents/${document.id}/feedback.\n\n`;
      return markdown(
        `${indexNote(lang, site).trimEnd()}\n${reportNote}${absoluteLinks(page, address, `${origin}/api/v1/spaces/${encodeURIComponent(space!)}/assets`)}`,
        { ETag: `"${revision.sha256}"` }
      );
    });

  app.use("*", compress());

  app.on(["GET", "HEAD"], "*", async c => {
    const { pathname, search } = new URL(c.req.url);
    const file = await files.serve(pathname, c.req.header("accept-encoding") ?? "");
    if (file) {
      // Other sites load this one with <script type="module">, which browsers only allow with this header.
      if (pathname === "/embed.js") file.headers.set("Access-Control-Allow-Origin", "*");
      return file;
    }
    try {
      decodeURIComponent(pathname);
    } catch {
      return plainText(404, t("No such page"));
    }
    const embed = EMBED_PATH.exec(pathname);
    if (embed) {
      // The page holds nothing itself and asks its host for a token once it runs, so it needs no login to load.
      const embedApp = await embedApps.bySlug(embed[1]!);
      if (embedApp?.status !== "active") return plainText(404, t("No such embed app"));
      if (pathname.endsWith(".md")) return markdownResponse(c, embed[2] ?? "");
      const html = await files.indexHtml();
      if (!html) return plainText(503, "The web app has not been built. Run: pnpm build");
      return new Response(withFavicon(html, (await services.site.get()).favicon), {
        headers: {
          ...NO_STORE,
          "Content-Type": "text/html; charset=utf-8",
          [CSP_HEADER]: embedCsp(embedApp.allowedOrigins, base)
        }
      });
    }
    const shared = SHARE_PATH.exec(pathname);
    if (shared) {
      if (!publicAccess.allowRequest(clientAddress(c, trustProxy), pathname)) return tooMany();
      const rest = shared[2] ?? "";
      if (rest.endsWith(".md")) return markdownResponse(c, rest, shared[1]);
      const llms = rest.endsWith(".txt") ? LLMS_PATH.exec(rest) : null;
      if (llms) return llmsResponse(c, llms[1]!, llms[2]!, shared[1]);
      if (!(await services.shareLinks.principalOf(shared[1]!)))
        return plainText(404, t("This link does not work any more. Ask whoever sent it for a new one."));
      const html = await files.indexHtml();
      if (!html) return plainText(503, "The web app has not been built. Run: pnpm build");
      // Nothing here is for search engines. Every page already says not to tell other sites where someone came from, which here is the link itself.
      return new Response(withFavicon(html, (await services.site.get()).favicon), {
        headers: {
          ...NO_STORE,
          "Content-Type": "text/html; charset=utf-8",
          [CSP_HEADER]: pagePolicy,
          "X-Robots-Tag": "noindex"
        }
      });
    }
    if (pathname === "/site.css") return siteStylesheet(c, siteStyles(await services.site.get()));
    if (pathname === "/robots.txt") return plainText(200, robotsTxt(await publicAccess.open(), origin));
    if (pathname === "/sitemap.xml") {
      if (!(await publicAccess.open())) return plainText(404, t("No such page"));
      if (!publicAccess.allowRequest(clientAddress(c, trustProxy), pathname)) return tooMany();
      return new Response(await sitemapXml(services, origin), {
        headers: { ...NO_STORE, "Content-Type": "application/xml; charset=utf-8" }
      });
    }
    const llms = pathname.endsWith(".txt") ? LLMS_PATH.exec(pathname) : null;
    if (llms) return llmsResponse(c, llms[1]!, llms[2]!);
    if (pathname.endsWith(".md")) return markdownResponse(c, pathname);
    if (!pathname.startsWith(MANAGE_PREFIX) && prefersMarkdown(c.req.header("accept")))
      return markdownResponse(c, pathname);
    const auth = await identity.authenticate(c.req.raw);
    const signedIn = auth.ok && auth.via !== "embed";
    if (!signedIn && !(await publicAccess.allowsPage(pathname)))
      return c.redirect(`/login?${new URLSearchParams({ next: `${pathname}${search}` })}`);
    const built = await files.indexHtml();
    if (!built) return plainText(503, "The web app has not been built. Run: pnpm build");
    if (!signedIn && !publicAccess.allowRequest(clientAddress(c, trustProxy), pathname)) return tooMany();
    const site = await services.site.get();
    const outcome = await rendering.answer(
      withFavicon(built, site.favicon),
      { pathname, search },
      signedIn ? auth.principal : ANONYMOUS_PRINCIPAL,
      await languageOfPage(c.req.raw, pathname, async () => site.defaultLang)
    );
    if (outcome.kind === "redirect") return c.redirect(outcome.to, outcome.status);
    if (outcome.documentId && outcome.status === 200 && AI_CRAWLER.test(c.req.header("user-agent") ?? ""))
      services.stats.countView(outcome.documentId, "agent");
    return new Response(outcome.html, {
      status: outcome.status,
      headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8", Vary: "Accept", [CSP_HEADER]: pagePolicy }
    });
  });
}
