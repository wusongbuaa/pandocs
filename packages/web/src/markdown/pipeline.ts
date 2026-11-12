import type { GlossaryEntry } from "../types";
import { rehypeGlossary } from "./glossary";
import { readingMinutes } from "./reading-time";
import type { Element, ElementContent, Root as HastRoot } from "hast";
import type { Heading, Nodes, Root as MdastRoot } from "mdast";
import rehypeExternalLinks from "rehype-external-links";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import {
  assetHash,
  boundedTree,
  defaultBlockRegistry,
  dialectRemarkPlugins,
  headingsStepDown,
  parseImageTitle,
  plainText,
  sourceTree,
  type BlockRegistry
} from "@pandocs/markdown";
import { rehypeCodeMeta } from "../../vendor/rspress/node/mdx/rehypePlugins/codeMeta";
import { rehypeHeaderAnchor } from "../../vendor/rspress/node/mdx/rehypePlugins/headerAnchor";
import { t } from "../i18n";

export interface TocEntry {
  readonly id: string;
  readonly text: string;
  readonly depth: number;
}

export interface RenderedMarkdown {
  readonly hast: HastRoot;
  readonly toc: readonly TocEntry[];
  /** Set when the body starts with the page's title; otherwise the theme renders the title itself. */
  readonly headingTitle: string;
  readonly readingMinutes: number;
  /** What a search result or a shared link shows of the page. */
  readonly description: string;
}

/** The same characters the official table of contents keeps, which the theme then renders inline. */
export function inlineMarkdown(node: Nodes): string {
  // A formula in a heading reads as its source in the outline, which only shows text.
  if ((node.type as string) === "inlineMath") return `\`${(node as unknown as { value: string }).value}\``;
  switch (node.type) {
    case "text":
      return node.value;
    case "inlineCode":
      return `\`${node.value}\``;
    case "strong":
      return `**${node.children.map(inlineMarkdown).join("")}**`;
    case "emphasis":
      return `*${node.children.map(inlineMarkdown).join("")}*`;
    case "delete":
      return `~~${node.children.map(inlineMarkdown).join("")}~~`;
    default:
      return "children" in node ? node.children.map(inlineMarkdown).join("") : "";
  }
}

/**
 * A page's title is its one `h1`. Most Markdown also uses `#` for sections, which would
 * render as more page titles, so sections step down a level; a first heading that repeats the title stays.
 */
function structureHeadings(tree: MdastRoot, title: string, output: { toc: TocEntry[]; headingTitle: string }): void {
  const headings: Heading[] = [];
  visit(tree, "heading", node => void headings.push(node));
  const first = tree.children.find(node => node.type !== "yaml");
  const titled = first?.type === "heading" && first.depth === 1 && plainText(first).trim() === title.trim();
  if (titled) output.headingTitle = title;
  if (
    headingsStepDown(
      headings.map(node => node.depth),
      titled
    )
  ) {
    for (const heading of headings) {
      if (heading !== first || !titled) heading.depth = Math.min(heading.depth + 1, 6) as Heading["depth"];
    }
  }
  for (const heading of headings) {
    const id = (heading.data as { hProperties?: { id?: string } } | undefined)?.hProperties?.id;
    if (id && heading.depth >= 2 && heading.depth < 5)
      output.toc.push({ id, text: inlineMarkdown(heading).trim(), depth: heading.depth });
  }
}

export const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.{0,2}\/|[^:]*$)/iu;

/** The body may come from anyone with write access, including agents, so links cannot carry `javascript:`. */
function rehypeSafeUrls() {
  return (tree: HastRoot) =>
    visit(tree, "element", (node: Element) => {
      for (const property of ["href", "src"]) {
        const value = node.properties?.[property];
        if (typeof value === "string" && !assetHash(value) && !SAFE_URL.test(value)) delete node.properties[property];
      }
    });
}

const DESCRIPTION_CHARS = 160;

function firstParagraph(tree: MdastRoot): string {
  const paragraph = tree.children.find(node => node.type === "paragraph");
  const text = paragraph ? plainText(paragraph).replace(/\s+/gu, " ").trim() : "";
  return text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : text;
}

const hasCode = (tree: HastRoot) => {
  let found = false;
  visit(tree, "element", (node: Element) => {
    if (
      node.tagName === "pre" &&
      node.children.some((child: ElementContent) => child.type === "element" && child.tagName === "code")
    )
      found = true;
  });
  return found;
};

/** Shiki and its grammars are the heaviest part of the page, and most documents have no code. */
function rehypeLazyShiki() {
  return async (tree: HastRoot) => {
    if (!hasCode(tree)) return;
    const [{ default: rehypeShiki }, { createRehypeShikiOptions }] = await Promise.all([
      import("@shikijs/rehype"),
      import("../../vendor/rspress/node/mdx/rehypePlugins/shiki")
    ]);
    // A language it has no grammar for, such as curl, is shown as plain code: failing there took the whole page with it.
    await unified()
      .use(rehypeShiki, createRehypeShikiOptions(false, false, undefined, { fallbackLanguage: "txt" }))
      .run(tree);
  };
}

const MATH_CLASS = "language-math";

const classesOf = (node: Element) => [node.properties?.className ?? []].flat().map(String);

/** `$$x$$` on a line of its own is meant as a displayed formula, even though Markdown parses it as inline. */
function displayLoneFormulas(tree: HastRoot): void {
  visit(tree, "element", (node: Element) => {
    if (node.tagName !== "p") return;
    const content = node.children.filter(child => child.type !== "text" || child.value.trim() !== "");
    const only = content[0];
    if (content.length === 1 && only?.type === "element" && classesOf(only).includes(MATH_CLASS))
      only.properties.className = [MATH_CLASS, "math-display"];
  });
}

/** KaTeX and its fonts only load for documents that have formulas. */
function rehypeLazyKatex() {
  return async (tree: HastRoot) => {
    let found = false;
    visit(tree, "element", (node: Element) => {
      if (classesOf(node).includes(MATH_CLASS)) found = true;
    });
    if (!found) return;
    displayLoneFormulas(tree);
    const { rehypeKatex } = await import("./katex");
    await unified().use(rehypeKatex, { strict: false }).run(tree);
  };
}

/** Alignment and width travel in the image's title, which every Markdown tool keeps and shows no one. */
function rehypeImageLayout() {
  return (tree: HastRoot) =>
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "img" || typeof node.properties.title !== "string") return;
      const { title, align, width } = parseImageTitle(node.properties.title);
      node.properties.title = title || undefined;
      if (align) node.properties.dataAlign = align;
      if (width) node.properties.style = `width: ${width}px`;
    });
}

export async function renderMarkdown(
  markdown: string,
  options: { readonly title: string; readonly registry?: BlockRegistry; readonly glossary?: readonly GlossaryEntry[] }
): Promise<RenderedMarkdown> {
  const output: { toc: TocEntry[]; headingTitle: string; description: string } = {
    toc: [],
    headingTitle: "",
    description: ""
  };
  const processor = unified()
    .use(remarkParse)
    .use(dialectRemarkPlugins(options.registry ?? defaultBlockRegistry))
    .use(() => (tree: MdastRoot) => {
      structureHeadings(tree, options.title, output);
      output.description = firstParagraph(tree);
    })
    // No raw HTML: `<br>` is the only tag the dialect keeps, and it arrives as a line break.
    // The list of footnotes closes the page; it is not a section of it, so the outline leaves its title out.
    .use(remarkRehype, {
      footnoteLabel: t("Footnotes"),
      footnoteBackLabel: reference => t("Back to reference {0}", reference),
      footnoteLabelProperties: { className: ["rp-toc-exclude"] }
    })
    // Before anything treats formulas' `pre` and `code` as code.
    .use(rehypeLazyKatex)
    .use(rehypeHeaderAnchor)
    .use(rehypeCodeMeta)
    .use(rehypeLazyShiki)
    .use(rehypeExternalLinks, { target: "_blank", rel: "noopener noreferrer" })
    .use(rehypeSafeUrls)
    .use(rehypeImageLayout)
    .use(rehypeGlossary, options.glossary ?? []);
  // A page nested too deeply reads as its source, here as everywhere else, rather than taking the tab down.
  const tree = boundedTree(markdown, text => processor.parse(text) as MdastRoot) ?? sourceTree(markdown);
  const hast = (await processor.run(tree, { value: markdown } as never)) as unknown as HastRoot;
  return {
    hast,
    toc: output.toc,
    headingTitle: output.headingTitle,
    readingMinutes: readingMinutes(hast),
    description: output.description
  };
}
