import { splitFrontMatter } from "@pandocs/markdown";
import { parse } from "yaml";

const SAFE_LINK = /^(?:https?:|mailto:|\/|\.{0,2}\/|[^:]*$)/iu;

/** The theme renders these strings as HTML when they contain tags, and anyone who can write a page can write them. */
const plain = (value: unknown): string | undefined =>
  typeof value === "string" ? value.replace(/[<>]/gu, "") : undefined;
const link = (value: unknown): string | undefined => {
  const text = plain(value);
  return text && SAFE_LINK.test(text) ? text : undefined;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

/** A page that is nothing but an API reference gets the room that needs, and the reference brings its own navigation. */
const SOLE_API_REFERENCE = /^\s*::openapi\{[^}\n]*\}\s*$/u;
const API_REFERENCE_LAYOUT = { pageType: "doc-wide", sidebar: false, outline: false, footer: false } as const;

export const layoutFromContent = (markdown: string) =>
  SOLE_API_REFERENCE.test(splitFrontMatter(markdown).body) ? API_REFERENCE_LAYOUT : {};

function hero(value: unknown) {
  const source = record(value);
  const image = record(source.image);
  return defined({
    name: plain(source.name),
    text: plain(source.text),
    tagline: plain(source.tagline),
    badge: plain(source.badge),
    image: link(image.src) ? { src: link(image.src), alt: plain(image.alt) ?? "" } : undefined,
    actions: list(source.actions)
      .map(record)
      .map(action =>
        defined({
          theme: action.theme === "alt" ? "alt" : "brand",
          text: plain(action.text) ?? "",
          link: link(action.link) ?? ""
        })
      )
      .filter(action => action.text && action.link)
  });
}

function features(value: unknown) {
  return list(value)
    .map(record)
    .map(item =>
      defined({
        title: plain(item.title) ?? "",
        details: plain(item.details),
        icon: plain(item.icon),
        link: link(item.link),
        span: typeof item.span === "number" ? item.span : undefined
      })
    )
    .filter(item => item.title);
}

/**
 * The official way to choose a page's layout, such as `pageType: home`, with only the fields that are about layout.
 * A page whose YAML does not parse still shows its content; the editor keeps the block as written.
 */
export function layoutFromFrontMatter(markdown: string): Record<string, unknown> {
  const { frontMatter } = splitFrontMatter(markdown);
  if (!frontMatter) return {};
  let data: Record<string, unknown>;
  try {
    data = record(parse(frontMatter.replace(/^---\r?\n/u, "").replace(/\r?\n---\s*$/u, "")));
  } catch {
    return {};
  }
  return defined({
    pageType:
      data.pageType === "home" || data.pageType === "doc" || data.pageType === "doc-wide" ? data.pageType : undefined,
    hero: data.hero ? hero(data.hero) : undefined,
    features: data.features ? features(data.features) : undefined,
    outline: typeof data.outline === "boolean" ? data.outline : undefined,
    sidebar: typeof data.sidebar === "boolean" ? data.sidebar : undefined,
    footer: typeof data.footer === "boolean" ? data.footer : undefined,
    readingTime: typeof data.readingTime === "boolean" ? data.readingTime : undefined,
    navbar: typeof data.navbar === "boolean" ? data.navbar : undefined,
    tag: plain(data.tag),
    description: plain(data.description)
  });
}
