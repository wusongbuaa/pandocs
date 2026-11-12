import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";

const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm"
};

const isFile = async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false;

/**
 * The build names what the page loads relative to it, so the same build works wherever the site lives. A page can be at
 * any depth, though, so its addresses start from the site's path instead: `/docs/assets/…` below `/docs`, `/assets/…`
 * at the root. Below a path the page also says where the site is, for the app to work out the rest.
 */
export function placeBelow(html: string, base: string): string {
  const placed = html.replace(/(\s(?:src|href|content)=")\.?\/(?!\/)/gu, `$1${base}/`);
  return base ? placed.replace("<head>", () => `<head>\n    <meta name="pandocs-base" content="${base}" />`) : placed;
}

/** The build writes `.br` and `.gz` next to each file, so serving them costs no CPU per request. */
export function createStaticFiles(root: string, options: { readonly cacheHtml: boolean; readonly base?: string }) {
  const base = normalize(root.endsWith(sep) ? root : `${root}${sep}`);
  let html: string | null = null;
  return {
    /** `null` when there is no such file, so the page route can take the path. */
    async serve(pathname: string, acceptEncoding: string): Promise<Response | null> {
      let relative: string;
      try {
        relative = decodeURIComponent(pathname).replace(/^\/+/u, "");
      } catch {
        return null;
      }
      const file = normalize(join(base, relative));
      // `ssr/` is what renders pages here, and is of no use to a browser.
      if (!file.startsWith(base) || relative === "" || relative === "index.html" || file.startsWith(join(base, "ssr", sep)) || !(await isFile(file))) return null;
      const accepted = acceptEncoding.toLowerCase();
      const variant = accepted.includes("br") && await isFile(`${file}.br`)
        ? { path: `${file}.br`, encoding: "br" }
        : accepted.includes("gzip") && await isFile(`${file}.gz`)
          ? { path: `${file}.gz`, encoding: "gzip" }
          : { path: file, encoding: undefined };
      const headers: Record<string, string> = {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        // Names under assets/ carry a hash of their content. Anything else can change in place.
        "Cache-Control": relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        Vary: "Accept-Encoding"
      };
      if (variant.encoding) headers["Content-Encoding"] = variant.encoding;
      return new Response(Readable.toWeb(createReadStream(variant.path)) as ReadableStream, { headers });
    },
    async indexHtml(): Promise<string | null> {
      if (html !== null) return html;
      const read = await readFile(join(base, "index.html"), "utf8").catch(() => null);
      const content = read === null ? null : placeBelow(read, options.base ?? "");
      if (options.cacheHtml) html = content;
      return content;
    }
  };
}

export type StaticFiles = ReturnType<typeof createStaticFiles>;
