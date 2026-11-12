import type { Nodes } from "mdast";
import { parseDocument } from "./parse.js";
import { defaultBlockRegistry, type BlockRegistry } from "./registry.js";

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

export interface DocLink {
  readonly path: string;
  readonly hash?: string;
}

/** Relative `.md` links keep exported files working anywhere; `path` is the document path inside its space. */
export function resolveDocLink(currentPath: string, href: string): DocLink | null {
  if (EXTERNAL.test(href) || href.startsWith("#")) return null;
  const [target = "", hash] = href.split("#", 2);
  if (!/\.md$/iu.test(target)) return null;
  const segments = target.startsWith("/") ? [] : currentPath.split("/").slice(0, -1);
  for (const raw of target.replace(/\.md$/iu, "").split("/")) {
    const part = safeDecode(raw);
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.length > 0 ? { path: segments.join("/"), ...(hash ? { hash: safeDecode(hash) } : {}) } : null;
}

export function relativeDocHref(fromPath: string, toPath: string): string {
  const from = fromPath.split("/").slice(0, -1);
  const to = toPath.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  const up = from.length - shared;
  return `${up === 0 ? "./" : "../".repeat(up)}${to.slice(shared).join("/")}.md`;
}

/** What a Markdown link destination cannot hold as written. `encodeURIComponent` leaves parentheses alone. */
const UNSAFE_IN_DESTINATION = /[\s()<>#?%\\]/gu;
const percentEncoded = (char: string) => (char === "(" ? "%28" : char === ")" ? "%29" : encodeURIComponent(char));

/**
 * A relative link to a page by the address the site serves it at, `./guide` rather than `./guide.md`, as `.md`, so
 * it resolves the same way: the browser takes it from the page's own address. Anything with an extension, a query or
 * nothing after its last slash is something else.
 */
function asDocHref(href: string): string | null {
  if (EXTERNAL.test(href) || href.startsWith("#")) return null;
  const [target = "", hash] = href.split("#", 2);
  const last = target.slice(target.lastIndexOf("/") + 1);
  if (/\.md$/iu.test(target)) return href;
  if (!last || last.includes(".") || target.includes("?")) return null;
  return `${target}.md${hash === undefined ? "" : `#${hash}`}`;
}

function relocatedHref(href: string, from: string, to: string, movedTo: (path: string) => string): string | null {
  // A path from the root does not depend on where the page is, and old addresses of other pages still resolve.
  if (href.startsWith("/")) return null;
  const asDoc = asDocHref(href);
  const link = asDoc === null ? null : resolveDocLink(from, asDoc);
  if (!asDoc || !link) return null;
  const target = movedTo(link.path);
  if (resolveDocLink(to, asDoc)?.path === target) return null;
  const hash = href.includes("#") ? href.slice(href.indexOf("#")) : "";
  const relative = relativeDocHref(to, target).replace(UNSAFE_IN_DESTINATION, percentEncoded);
  // Written the way it was: with `.md`, or as the page's address.
  return `${asDoc === href ? relative : relative.replace(/\.md$/u, "")}${hash}`;
}

/**
 * Relative links mean something different once a page lives elsewhere, so a move rewrites them to reach the same
 * pages. `movedTo` gives the new path of pages that moved along. Only destinations change, never the visible text,
 * so comment anchors stay put; text with nothing to change comes back identical.
 */
export function relocateDocLinks(
  markdown: string,
  from: string,
  to: string,
  movedTo: (path: string) => string = path => path,
  registry: BlockRegistry = defaultBlockRegistry
): string {
  if (!/\]\(|\]:|href=/u.test(markdown)) return markdown;
  const edits: { start: number; end: number; href: string }[] = [];
  const visit = (node: Nodes) => {
    if (
      (node.type === "link" || node.type === "definition") &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    ) {
      const href = relocatedHref(node.url, from, to, movedTo);
      // Looking from the end because the link's own text may read the same as its destination.
      const at =
        href === null ? -1 : markdown.slice(node.position.start.offset, node.position.end.offset).lastIndexOf(node.url);
      if (href !== null && at >= 0)
        edits.push({
          start: node.position.start.offset + at,
          end: node.position.start.offset + at + node.url.length,
          href
        });
    }
    if (
      (node.type === "containerDirective" || node.type === "leafDirective") &&
      node.position?.start.offset !== undefined
    ) {
      const start = node.position.start.offset;
      const opening = markdown.slice(start, node.position.end.offset).split("\n", 1)[0]!;
      for (const attribute of registry.get(node.name)?.linkAttrs ?? []) {
        const value = node.attributes?.[attribute];
        const href = value ? relocatedHref(value, from, to, movedTo) : null;
        // The attributes come after the label, which may read the same.
        const at = href === null ? -1 : opening.lastIndexOf(value!);
        if (href !== null && at >= 0)
          edits.push({ start: start + at, end: start + at + value!.length, href: href.replace(/"/gu, "%22") });
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parseDocument(markdown, registry).tree);
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => `${text.slice(0, edit.start)}${edit.href}${text.slice(edit.end)}`, markdown);
}

const ASSET_PATH = /^assets\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/iu;

/** Space-level `assets/<sha256>.<ext>`, so a page moving around the tree keeps its images. */
export function assetHash(src: string): string | null {
  return ASSET_PATH.exec(src)?.[1]?.toLowerCase() ?? null;
}

/** Every upload a page's source mentions. Reads the raw text, so a mention in code counts too: it may only ever list too many. */
export function assetHashesIn(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/assets\/([a-f0-9]{64})/giu)].map(match => match[1]!.toLowerCase()))];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
