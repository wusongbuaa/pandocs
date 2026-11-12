import { Extension, Mark, mergeAttributes, Node, type AnyExtension, type JSONContent } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { ListItem, TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Lexer, Marked, type Token } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";
import { ALERT_BLOCKS, defaultBlockRegistry, formatAttributes, formatImageTitle, headingsStepDown, parseAttributes, parseImageTitle, SUBSCRIPT_AT_START, SUPERSCRIPT_AT_START, type BlockDefinition, type BlockRegistry, type ImageLayout } from "@pandocs/markdown";

const INDENT = { style: "space" as const, size: 3 };
const ALERT_MARKER = Object.fromEntries(Object.entries(ALERT_BLOCKS).map(([marker, block]) => [block, marker]));

export interface DialectViews {
  readonly container?: ((definition: BlockDefinition) => unknown) | undefined;
  readonly leaf?: ((definition: BlockDefinition) => unknown) | undefined;
  readonly inline?: ((definition: BlockDefinition) => unknown) | undefined;
  readonly raw?: (() => unknown) | undefined;
  readonly math?: (() => unknown) | undefined;
  readonly code?: (() => unknown) | undefined;
  readonly footnote?: (() => unknown) | undefined;
}

export interface DialectOptions {
  readonly registry?: BlockRegistry | undefined;
  readonly views?: DialectViews | undefined;
  /** Turns `assets/<sha>.<ext>` into a URL for display; the Markdown keeps the stable path. */
  readonly assetSource?: ((src: string) => string) | undefined;
  readonly placeholder?: AnyExtension | undefined;
  /** Shows headings at the level the reader will, leaving the Markdown's own levels alone. */
  readonly readerHeadings?: ReaderHeadings | undefined;
  /** Undoing has to mean only what this person did, which shared editing brings its own way of doing. */
  readonly collaborative?: boolean | undefined;
}

export interface ReaderHeadings {
  readonly stepDown: boolean;
  readonly title: string;
}

/** The same decision the reader makes for this document. With no headings yet, the first `#` will be a section too. */
export function readerHeadingsOf(marked: Marked, body: string, title: string): ReaderHeadings {
  const blocks = marked.lexer(body).filter(token => token.type !== "space");
  const depths = blocks.filter(token => token.type === "heading").map(token => (token as unknown as { depth: number }).depth);
  const first = blocks[0] as unknown as { type: string; depth?: number; text?: string } | undefined;
  const repeatsTitle = first?.type === "heading" && first.depth === 1 && first.text?.trim() === title.trim();
  return { stepDown: depths.length === 0 || headingsStepDown(depths, repeatsTitle), title };
}

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

function shownHeading({ stepDown, title }: ReaderHeadings) {
  const shift = stepDown ? 1 : 0;
  return Heading.extend({
    renderHTML({ node, HTMLAttributes }) {
      const level = Number(node.attrs.level);
      const shown = level === 1 && node.textContent.trim() === title.trim() ? 1 : Math.min(level + shift, 6);
      return [`h${shown}`, mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
    },
    // Copying within the editor goes through HTML, so a heading must read back as the level it was written from.
    parseHTML() {
      return HEADING_LEVELS.map(level => ({ tag: `h${level}`, attrs: { level: Math.max(level - shift, 1) } }));
    }
  }).configure({ levels: [...HEADING_LEVELS] });
}

function attributeSpec(definition: BlockDefinition) {
  const keys = Object.keys(definition.attrs.shape);
  return Object.fromEntries([...keys, "label", "syntax"].map(key => [key, { default: null, rendered: false }]));
}

/**
 * Copying within the editor goes by HTML, and a block is what its attributes say as much as what it holds: the title of
 * a callout, where a card leads, the file a video plays. They travel as one attribute and are read back on the way in.
 */
const ATTRIBUTES = "data-pandocs-attrs";

function attributesToHtml(attrs: Readonly<Record<string, unknown>>): Record<string, string> {
  const given = Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== null && value !== undefined));
  return Object.keys(given).length > 0 ? { [ATTRIBUTES]: JSON.stringify(given) } : {};
}

function attributesFromHtml(element: HTMLElement): Record<string, unknown> {
  try {
    const parsed = JSON.parse(element.getAttribute(ATTRIBUTES) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function attributesOf(definition: BlockDefinition, attrs: Readonly<Record<string, unknown>> | undefined) {
  const keys = Object.keys(definition.attrs.shape);
  const known = Object.fromEntries(keys.map(key => [key, (attrs?.[key] ?? null) as string | null]));
  // Attributes this version does not model still round-trip instead of being dropped on save.
  const extra = Object.entries(attrs ?? {}).filter(([key, value]) => !keys.includes(key) && key !== "label" && key !== "syntax" && typeof value === "string");
  return { ...known, ...Object.fromEntries(extra) } as Record<string, string | null>;
}

/**
 * Matches micromark exactly: the first line of at least as many colons closes the container, even
 * inside a code block. An author who needs `:::` in code gives the container more colons.
 */
function findClosingFence(source: string, colons: number): { index: number; length: number } | null {
  const closing = new RegExp(`^ {0,3}:{${colons},}[ \\t]*$`, "u");
  let at = 0;
  for (const line of source.split("\n")) {
    if (closing.test(line)) return { index: at, length: Math.min(line.length + 1, source.length - at) };
    at += line.length + 1;
  }
  return null;
}

/**
 * Where a block could cut short the paragraph at the start of `source`. A paragraph ends at a blank line anyway, so
 * there is no need to look further, and every kind of block looking through all the rest for every paragraph is what
 * makes reading a long document take time in proportion to the square of its length.
 */
function firstLineMatch(source: string, pattern: RegExp): number {
  const blank = source.indexOf("\n\n");
  return (blank < 0 ? source : source.slice(0, blank)).search(pattern);
}

const containerNames = (registry: BlockRegistry) => new Set(registry.list().filter(block => block.kind === "container").map(block => block.name));

function containerNode(definition: BlockDefinition, registry: BlockRegistry, views: DialectViews | undefined): AnyExtension {
  const { name } = definition;
  const containers = containerNames(registry);
  const nesting = (node: JSONContent): number => (node.content ?? []).reduce((deepest, child) => Math.max(deepest, containers.has(child.type ?? "") ? nesting(child) + 1 : nesting(child)), 0);
  // `:::tip 标题` is how other documentation tools write the title; it is normalized when the block is saved.
  const opening = new RegExp(`^( {0,3})(:{3,})[ \\t]*${name}(?![\\w-])(?:\\[([^\\]\\n]*)\\]|[ \\t]+([^\\n{]*[^\\s{]))?(?:\\{([^}\\n]*)\\})?[ \\t]*\\n`, "u");
  return Node.create({
    name,
    group: "block",
    content: "block+",
    defining: true,
    addAttributes: () => attributeSpec(definition),
    parseHTML: () => [{ tag: `div[data-pandocs-block="${name}"]`, getAttrs: attributesFromHtml }],
    renderHTML: ({ node }: { node: { attrs: Record<string, unknown> } }) => ["div", { "data-pandocs-block": name, ...attributesToHtml(node.attrs) }, 0],
    ...(views?.container ? { addNodeView: () => views.container!(definition) as never } : {}),
    markdownTokenizer: {
      name,
      level: "block",
      start: (source: string) => {
        return firstLineMatch(source, new RegExp(`^ {0,3}:{3,}[ \\t]*${name}(?![\\w-])`, "mu"));
      },
      tokenize(source: string, _tokens: unknown, lexer: { blockTokens(source: string): unknown[] }) {
        const match = opening.exec(source);
        if (!match) return undefined;
        const rest = source.slice(match[0].length);
        const closing = findClosingFence(rest, match[2]!.length);
        if (!closing) return undefined;
        const inner = rest.slice(0, closing.index);
        const dedented = match[1] ? inner.replace(new RegExp(`^ {0,${match[1].length}}`, "gmu"), "") : inner;
        return {
          type: name,
          raw: match[0] + rest.slice(0, closing.index + closing.length),
          label: match[3] ?? match[4] ?? null,
          attributes: parseAttributes(match[5]),
          tokens: lexer.blockTokens(dedented)
        };
      }
    },
    parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode(name, { ...token.attributes, label: token.label ?? null, syntax: token.syntax ?? null }, helpers.parseChildren(token.tokens ?? [])),
    renderMarkdown: (node: JSONContent, helpers: Record<string, any>) => {
      const body = helpers.renderChildren(node.content ?? [], "\n\n") as string;
      if (node.attrs?.syntax === "alert" && ALERT_MARKER[name]) {
        return [`> [!${ALERT_MARKER[name]}]`, ...body.split("\n").map(line => (line ? `> ${line}` : ">"))].join("\n");
      }
      const fence = ":".repeat(3 + nesting(node));
      const label = node.attrs?.label ? `[${node.attrs.label as string}]` : "";
      return `${fence}${name}${label}${formatAttributes(attributesOf(definition, node.attrs))}\n\n${body}\n\n${fence}`;
    }
  } as never);
}

function leafNode(definition: BlockDefinition, views: DialectViews | undefined): AnyExtension {
  const { name } = definition;
  const pattern = new RegExp(`^ {0,3}::${name}(?![\\w-])(?:\\[([^\\]\\n]*)\\])?(?:\\{([^}\\n]*)\\})?[ \\t]*(?:\\n|$)`, "u");
  return Node.create({
    name,
    group: "block",
    atom: true,
    addAttributes: () => attributeSpec(definition),
    parseHTML: () => [{ tag: `div[data-pandocs-block="${name}"]`, getAttrs: attributesFromHtml }],
    renderHTML: ({ node }: { node: { attrs: Record<string, unknown> } }) => ["div", { "data-pandocs-block": name, ...attributesToHtml(node.attrs) }],
    ...(views?.leaf ? { addNodeView: () => views.leaf!(definition) as never } : {}),
    markdownTokenizer: {
      name,
      level: "block",
      start: (source: string) => {
        return firstLineMatch(source, new RegExp(`^ {0,3}::${name}(?![\\w-])`, "mu"));
      },
      tokenize(source: string) {
        const match = pattern.exec(source);
        return match ? { type: name, raw: match[0], label: match[1] ?? null, attributes: parseAttributes(match[2]) } : undefined;
      }
    },
    parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode(name, { ...token.attributes, label: token.label ?? null }),
    renderMarkdown: (node: JSONContent) => `::${name}${node.attrs?.label ? `[${node.attrs.label as string}]` : ""}${formatAttributes(attributesOf(definition, node.attrs))}`
  } as never);
}

function inlineNode(definition: BlockDefinition, views: DialectViews | undefined): AnyExtension {
  const { name } = definition;
  const pattern = new RegExp(`^:${name}\\[([^\\]\\n]*)\\](?:\\{([^}\\n]*)\\})?`, "u");
  return Node.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => attributeSpec(definition),
    parseHTML: () => [{ tag: `span[data-pandocs-inline="${name}"]`, getAttrs: attributesFromHtml }],
    renderHTML: ({ node }: { node: { attrs: Record<string, string> } }) => ["span", { "data-pandocs-inline": name, ...attributesToHtml(node.attrs) }, node.attrs.label ?? ""],
    ...(views?.inline ? { addNodeView: () => views.inline!(definition) as never } : {}),
    markdownTokenizer: {
      name,
      level: "inline",
      start: (source: string) => source.indexOf(`:${name}[`),
      tokenize(source: string) {
        const match = pattern.exec(source);
        return match ? { type: name, raw: match[0], label: match[1], attributes: parseAttributes(match[2]) } : undefined;
      }
    },
    parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode(name, { ...token.attributes, label: token.label }),
    renderMarkdown: (node: JSONContent) => `:${name}[${(node.attrs?.label as string | undefined) ?? ""}]${formatAttributes(attributesOf(definition, node.attrs))}`
  } as never);
}

/** Blocks this version does not know stay as an opaque atom holding their source bytes. */
function rawDirective(registry: BlockRegistry, views: DialectViews | undefined): AnyExtension {
  const known = registry.list().filter(block => block.kind === "container" || block.kind === "leaf").map(block => block.name).join("|") || "\\b\\B";
  return Node.create({
    name: "rawDirective",
    group: "block",
    atom: true,
    addAttributes: () => ({ raw: { default: "", rendered: false }, directive: { default: "", rendered: false } }),
    parseHTML: () => [{ tag: "pre[data-pandocs-raw]" }],
    renderHTML: ({ node }: { node: { attrs: { raw: string } } }) => ["pre", { "data-pandocs-raw": "" }, node.attrs.raw],
    ...(views?.raw ? { addNodeView: () => views.raw!() as never } : {}),
    markdownTokenizer: {
      name: "rawDirective",
      level: "block",
      start: (source: string) => {
        return firstLineMatch(source, /^ {0,3}:{2,}[a-zA-Z]/mu);
      },
      tokenize(source: string) {
        const container = new RegExp(`^ {0,3}(:{3,})(?!(?:${known})(?![\\w-]))([a-zA-Z][\\w-]*)[^\\n]*\\n`, "u").exec(source);
        if (container) {
          const rest = source.slice(container[0].length);
          const closing = findClosingFence(rest, container[1]!.length);
          if (!closing) return undefined;
          return { type: "rawDirective", raw: container[0] + rest.slice(0, closing.index + closing.length), directive: container[2] };
        }
        const leaf = new RegExp(`^ {0,3}::(?!:)(?!(?:${known})(?![\\w-]))([a-zA-Z][\\w-]*)[^\\n]*(?:\\n|$)`, "u").exec(source);
        return leaf ? { type: "rawDirective", raw: leaf[0], directive: leaf[1] } : undefined;
      }
    },
    parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode("rawDirective", { raw: String(token.raw).replace(/\n+$/u, ""), directive: token.directive }),
    renderMarkdown: (node: JSONContent) => (node.attrs?.raw as string | undefined) ?? ""
  } as never);
}

/** `> [!NOTE]` reads as the matching block and is written back the same way. */
function githubAlerts(registry: BlockRegistry): AnyExtension {
  const pattern = /^(?: {0,3}> ?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$))((?: {0,3}>.*(?:\n|$))*)/u;
  return Extension.create({
    name: "pandocsAlert",
    markdownTokenName: "pandocsAlert",
    markdownTokenizer: {
      name: "pandocsAlert",
      level: "block",
      start: (source: string) => {
        return firstLineMatch(source, /^ {0,3}> ?\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/mu);
      },
      tokenize(source: string, _tokens: unknown, lexer: { blockTokens(source: string): unknown[] }) {
        const match = pattern.exec(source);
        if (!match) return undefined;
        const inner = match[2]!.replace(/^ {0,3}> ?/gmu, "");
        return { type: "pandocsAlert", raw: match[0], target: ALERT_BLOCKS[match[1]!], tokens: lexer.blockTokens(inner) };
      }
    },
    parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => {
      const target = registry.get(token.target as string) ? (token.target as string) : "blockquote";
      return helpers.createNode(target, target === "blockquote" ? {} : { syntax: "alert" }, helpers.parseChildren(token.tokens ?? []));
    }
  } as never);
}

function superSubMark(name: "superscript" | "subscript", tag: string, marker: string, pattern: RegExp): AnyExtension {
  return Mark.create({
    name,
    parseHTML: () => [{ tag }],
    renderHTML: () => [tag, 0],
    markdownTokenName: name,
    markdownTokenizer: {
      name,
      level: "inline",
      start: (source: string) => source.indexOf(marker),
      tokenize(source: string, _tokens: unknown, lexer: { inlineTokens(source: string): unknown[] }) {
        const match = pattern.exec(source);
        return match ? { type: name, raw: match[0], tokens: lexer.inlineTokens(match[1]!) } : undefined;
      }
    },
    parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.applyMark(name, helpers.parseInline(token.tokens ?? [])),
    renderMarkdown: (node: JSONContent, helpers: Record<string, any>) => `${marker}${helpers.renderChildren(node)}${marker}`
  } as never);
}

const MATH_BLOCK = /^ {0,3}\$\$[ \t]*\n([\s\S]*?)\n {0,3}\$\$[ \t]*(?:\n|$)/u;
const MATH_INLINE = /^\$\$([^\n$](?:[^\n]*?[^\n$])?)\$\$/u;

/** Formulas are one unit in the editor, like an image: the source is edited in a popover, never as loose text. */
function mathNodes(views: DialectViews | undefined): AnyExtension[] {
  const view = views?.math ? { addNodeView: () => views.math!() as never } : {};
  return [
    Node.create({
      name: "mathBlock",
      group: "block",
      atom: true,
      draggable: true,
      addAttributes: () => ({ latex: { default: "" } }),
      parseHTML: () => [{ tag: "div[data-math-block]", getAttrs: (element: HTMLElement) => ({ latex: element.textContent ?? "" }) }],
      renderHTML: ({ node }: { node: { attrs: Record<string, unknown> } }) => ["div", { "data-math-block": "" }, String(node.attrs.latex ?? "")],
      ...view,
      markdownTokenName: "mathBlock",
      markdownTokenizer: {
        name: "mathBlock",
        level: "block",
        start: (source: string) => {
          return firstLineMatch(source, /^ {0,3}\$\$[ \t]*$/mu);
        },
        tokenize(source: string) {
          const match = MATH_BLOCK.exec(source);
          return match ? { type: "mathBlock", raw: match[0], latex: match[1] } : undefined;
        }
      },
      parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode("mathBlock", { latex: token.latex }),
      renderMarkdown: (node: JSONContent) => `$$\n${String(node.attrs?.latex ?? "")}\n$$`
    } as never),
    Node.create({
      name: "mathInline",
      group: "inline",
      inline: true,
      atom: true,
      addAttributes: () => ({ latex: { default: "" } }),
      parseHTML: () => [{ tag: "span[data-math-inline]", getAttrs: (element: HTMLElement) => ({ latex: element.textContent ?? "" }) }],
      renderHTML: ({ node }: { node: { attrs: Record<string, unknown> } }) => ["span", { "data-math-inline": "" }, String(node.attrs.latex ?? "")],
      ...view,
      markdownTokenName: "mathInline",
      markdownTokenizer: {
        name: "mathInline",
        level: "inline",
        start: (source: string) => source.indexOf("$$"),
        tokenize(source: string) {
          const match = MATH_INLINE.exec(source);
          return match ? { type: "mathInline", raw: match[0], latex: match[1] } : undefined;
        }
      },
      parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode("mathInline", { latex: token.latex }),
      renderMarkdown: (node: JSONContent) => `$$${String(node.attrs?.latex ?? "")}$$`
    } as never)
  ];
}

const FOOTNOTE_OPENING = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*/u;
const FOOTNOTE_REFERENCE = /^\[\^([^\]\s]+)\]/u;
const INDENTED = /^(?: {4}|\t)/u;
/** Lines that start something new rather than carry on the paragraph above them. */
const STARTS_BLOCK = /^ {0,3}(?:#{1,6}\s|>|```|~~~|:::|[-*+]\s|\d+[.)]\s|\||(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/u;

/**
 * A definition's further lines stay in it by being indented, which nobody typing in its box should need to know: the box
 * shows them as they read, and they are indented again on the way out.
 */
const indentFootnote = (text: string) => text.split("\n").map((line, at) => (at === 0 || !line.trim() ? line : `    ${line}`)).join("\n");
const unindentFootnote = (text: string) => text.split("\n").map((line, at) => (at === 0 ? line : line.replace(INDENTED, ""))).join("\n");

/** A definition runs to its first blank line and on through whatever is indented after it, the way micromark reads it. */
function footnoteDefinitionAt(source: string): { raw: string; label: string; text: string } | null {
  const opening = FOOTNOTE_OPENING.exec(source);
  if (!opening) return null;
  const lines = source.split("\n");
  let end = 1;
  for (let at = 1; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (!line.trim()) {
      if (!INDENTED.test(lines.slice(at + 1).find(next => next.trim()) ?? "")) break;
    } else if (!INDENTED.test(line) && (FOOTNOTE_OPENING.test(line) || STARTS_BLOCK.test(line))) {
      break;
    } else {
      end = at + 1;
    }
  }
  const body = lines.slice(0, end).join("\n");
  return { raw: source.slice(0, body.length + (source[body.length] === "\n" ? 1 : 0)), label: opening[1]!, text: body.slice(opening[0].length) };
}

/** `marked` knows no footnotes: left alone it reads a definition as a link target, and the footnote is gone on save. */
function footnoteNodes(views: DialectViews | undefined): AnyExtension[] {
  return [
    Node.create({
      name: "footnoteReference",
      group: "inline",
      inline: true,
      atom: true,
      addAttributes: () => ({ label: { default: "" } }),
      // Ahead of superscript, which would otherwise take the same tag for itself and leave a plain raised word.
      parseHTML: () => [{ tag: "sup[data-footnote-reference]", priority: 60, getAttrs: (element: HTMLElement) => ({ label: element.getAttribute("data-footnote-reference") ?? "" }) }],
      renderHTML: ({ node }: { node: { attrs: Record<string, unknown> } }) => ["sup", { "data-footnote-reference": String(node.attrs.label ?? ""), class: "pd-footnote-ref" }, String(node.attrs.label ?? "")],
      markdownTokenName: "footnoteReference",
      markdownTokenizer: {
        name: "footnoteReference",
        level: "inline",
        start: (source: string) => source.indexOf("[^"),
        tokenize(source: string) {
          const match = FOOTNOTE_REFERENCE.exec(source);
          return match ? { type: "footnoteReference", raw: match[0], label: match[1] } : undefined;
        }
      },
      parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode("footnoteReference", { label: token.label }),
      renderMarkdown: (node: JSONContent) => `[^${String(node.attrs?.label ?? "")}]`
    } as never),
    Node.create({
      name: "footnoteDefinition",
      group: "block",
      atom: true,
      addAttributes: () => ({ label: { default: "" }, text: { default: "" } }),
      parseHTML: () => [{ tag: "div[data-footnote-definition]", getAttrs: (element: HTMLElement) => ({ label: element.getAttribute("data-footnote-definition") ?? "", text: element.textContent ?? "" }) }],
      renderHTML: ({ node }: { node: { attrs: Record<string, unknown> } }) => ["div", { "data-footnote-definition": String(node.attrs.label ?? "") }, String(node.attrs.text ?? "")],
      ...(views?.footnote ? { addNodeView: () => views.footnote!() as never } : {}),
      markdownTokenName: "footnoteDefinition",
      markdownTokenizer: {
        name: "footnoteDefinition",
        level: "block",
        start: (source: string) => {
          return firstLineMatch(source, /^ {0,3}\[\^[^\]\s]+\]:/mu);
        },
        tokenize(source: string) {
          const definition = footnoteDefinitionAt(source);
          return definition ? { type: "footnoteDefinition", ...definition } : undefined;
        }
      },
      parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode("footnoteDefinition", { label: token.label, text: unindentFootnote(token.text) }),
      renderMarkdown: (node: JSONContent) => `[^${String(node.attrs?.label ?? "")}]: ${indentFootnote(String(node.attrs?.text ?? ""))}`
    } as never)
  ];
}

const BreakInline = Node.create({
  name: "breakInline",
  inline: true,
  group: "inline",
  selectable: false,
  parseHTML: () => [{ tag: "br[data-pandocs-break]" }],
  renderHTML: () => ["br", { "data-pandocs-break": "" }],
  markdownTokenizer: {
    name: "breakInline",
    level: "inline",
    start: (source: string) => source.search(/<br\s*\/?>/iu),
    tokenize(source: string) {
      const match = /^<br\s*\/?>/iu.exec(source);
      return match ? { type: "breakInline", raw: match[0] } : undefined;
    }
  },
  parseMarkdown: (_token: unknown, helpers: Record<string, any>) => helpers.createNode("breakInline"),
  renderMarkdown: () => "<br>"
} as never);

const NEXT_IS_TASK_ITEM = /^(?:[ \t]*\n)*[ \t]*[-+*][ \t]+\[[ xX]\][ \t]/u;

/** It asks of every block whether a task list starts there, and for that splits all the rest of the document into lines. */
function fasterTaskList(): AnyExtension {
  const tokenizer = TaskList.config.markdownTokenizer as { tokenize(source: string, tokens: unknown, lexer: unknown): unknown };
  return TaskList.extend({
    markdownTokenizer: { ...tokenizer, tokenize: (source: string, tokens: unknown, lexer: unknown) => (NEXT_IS_TASK_ITEM.test(source) ? tokenizer.tokenize(source, tokens, lexer) : undefined) }
  } as never);
}

/** The same again: all it wants to know of a paragraph is its first two lines. */
function fasterTable() {
  const tokenizer = Table.config.markdownTokenizer as { start(source: string): number };
  return Table.extend({
    markdownTokenizer: {
      ...tokenizer,
      start(source: string) {
        const first = source.indexOf("\n");
        const second = first < 0 ? -1 : source.indexOf("\n", first + 1);
        return tokenizer.start(second < 0 ? source : source.slice(0, second));
      }
    }
  } as never);
}

/** A picture's caption, alignment and width. A shared draft from before they were apart has them all in its title. */
export function imageLayout(attrs: Readonly<Record<string, unknown>>): ImageLayout {
  const written = parseImageTitle(String(attrs.title ?? ""));
  const align = (attrs.align ?? written.align) as ImageLayout["align"];
  const width = (attrs.width ?? written.width) as number | undefined;
  return { title: written.title, ...(align ? { align } : {}), ...(width ? { width: Number(width) } : {}) };
}

/** A caption is free text, and a quote inside it would otherwise end the Markdown title early. */
function imageMarkdown(node: JSONContent): string {
  const { src = "", alt = "", title = "" } = (node.attrs ?? {}) as Record<string, string | null>;
  return title ? `![${alt ?? ""}](${src ?? ""} "${title.replace(/(["\\])/gu, "\\$1")}")` : `![${alt ?? ""}](${src ?? ""})`;
}

const INLINE_IMAGE = "inlineImage";

/**
 * A picture inside a line of text, such as an icon or a badge. The editor's image is a block, which a paragraph cannot
 * hold, and a paragraph the editor cannot hold is one it drops. Only a picture on a line of its own is that block.
 */
function inlineImageNode(assetSource: (src: string) => string): AnyExtension {
  return Node.create({
    name: INLINE_IMAGE,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => ({ src: { default: null }, alt: { default: null }, title: { default: null } }),
    parseHTML: () => [{ tag: "img[data-inline-image]", priority: 60, getAttrs: (element: HTMLElement) => ({ src: element.getAttribute("data-src") ?? element.getAttribute("src"), alt: element.getAttribute("alt"), title: element.getAttribute("title") }) }],
    renderHTML: ({ node }: { node: { attrs: Record<string, unknown> } }) => ["img", { src: assetSource(String(node.attrs.src ?? "")), "data-src": node.attrs.src, alt: node.attrs.alt, title: node.attrs.title, "data-inline-image": "", class: "pd-inline-image" }],
    markdownTokenName: INLINE_IMAGE,
    parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => helpers.createNode(INLINE_IMAGE, { src: token.href, alt: token.text, title: token.title ?? null }),
    renderMarkdown: imageMarkdown
  } as never);
}

/** Every picture that shares its line with something else, wherever that line is: a paragraph, a heading, a cell, a list item. */
function markInlineImages(tokens: readonly Token[]): void {
  const visit = (token: Record<string, any>) => {
    const children = token.tokens as Record<string, any>[] | undefined;
    if (Array.isArray(children)) {
      const alone = token.type === "paragraph" && children.length === 1 && children[0]!.type === "image";
      if (!alone) for (const child of children) if (child.type === "image") child.type = INLINE_IMAGE;
      children.forEach(visit);
    }
    for (const key of ["items", "nestedTokens", "header"]) if (Array.isArray(token[key])) (token[key] as Record<string, any>[]).forEach(visit);
    if (Array.isArray(token.rows)) for (const row of token.rows as Record<string, any>[][]) row.forEach(visit);
  };
  tokens.forEach(token => visit(token as Record<string, any>));
}

/** Only the schema and the Markdown round trip: this editor brings its own list keymaps. */
export function createDialectExtensions(options: DialectOptions = {}): AnyExtension[] {
  const registry = options.registry ?? defaultBlockRegistry;
  const assetSource = options.assetSource ?? ((src: string) => src);
  const blocks = registry.list();
  return [
    StarterKit.configure({ heading: options.readerHeadings ? false : { levels: [...HEADING_LEVELS] }, underline: false, link: false, listItem: false, ...(options.views?.code ? { codeBlock: false } : {}), ...(options.collaborative ? { undoRedo: false } : {}) }),
    ...(options.views?.code ? [CodeBlock.extend({ addNodeView: () => options.views!.code!() as never })] : []),
    ...(options.readerHeadings ? [shownHeading(options.readerHeadings)] : []),
    ListItem,
    fasterTaskList(),
    TaskItem.configure({ nested: true }),
    inlineImageNode(assetSource),
    Link.extend({ inclusive: false }).configure({ openOnClick: false, autolink: true, defaultProtocol: "https" }),
    Image.extend({
      // Two people can change the caption and the alignment at once, and each is kept only if each is its own attribute.
      addAttributes(this: { parent?: () => Record<string, unknown> }) {
        return { ...this.parent?.(), align: { default: null, rendered: false }, width: { default: null, rendered: false } };
      },
      parseMarkdown: (token: Record<string, any>, helpers: Record<string, any>) => {
        const { title, align, width } = parseImageTitle(String(token.title ?? ""));
        return helpers.createNode("image", { src: token.href, alt: token.text, title: title || null, align: align ?? null, width: width ?? null });
      },
      renderHTML({ HTMLAttributes, node }: { HTMLAttributes: Record<string, unknown>; node: { attrs: Record<string, unknown> } }) {
        const { title, align, width } = imageLayout(node.attrs);
        const image = ["img", { ...HTMLAttributes, src: assetSource(String(HTMLAttributes.src ?? "")), title: title || null, ...(align ? { "data-align": align } : {}), ...(width ? { style: `width: ${width}px` } : {}) }];
        return (title ? ["span", { class: "pd-figure", "data-caption": title, ...(align ? { "data-align": align } : {}) }, image] : image) as never;
      },
      renderMarkdown: (node: JSONContent) => imageMarkdown({ ...node, attrs: { ...node.attrs, title: formatImageTitle(imageLayout(node.attrs ?? {})) } })
    } as never).configure({ inline: false, allowBase64: false }),
    fasterTable().configure({ resizable: false, renderWrapper: true }),
    TableRow,
    TableHeader,
    TableCell,
    BreakInline,
    superSubMark("superscript", "sup", "^", SUPERSCRIPT_AT_START),
    superSubMark("subscript", "sub", "~", SUBSCRIPT_AT_START),
    ...mathNodes(options.views),
    ...footnoteNodes(options.views),
    ...blocks.filter(block => block.kind === "container").map(block => containerNode(block, registry, options.views)),
    ...blocks.filter(block => block.kind === "leaf").map(block => leafNode(block, options.views)),
    ...blocks.filter(block => block.kind === "inline").map(block => inlineNode(block, options.views)),
    rawDirective(registry, options.views),
    githubAlerts(registry),
    ...(options.placeholder ? [options.placeholder] : [])
  ];
}

export function createDialectMarked(): Marked {
  const marked = new Marked();
  marked.use(markedCjkFriendly());
  // Whoever reads tokens from this instance, the editor or a list reading its items again, finds pictures in text marked.
  class DialectLexer extends Lexer {
    override lex(source: string) {
      const tokens = super.lex(source);
      markInlineImages(tokens);
      return tokens;
    }
  }
  marked.Lexer = DialectLexer as typeof marked.Lexer;
  marked.lexer = ((source: string, options?: typeof marked.defaults) => new DialectLexer(options ?? marked.defaults).lex(source)) as typeof marked.lexer;
  return marked;
}

export function createMarkdownExtension(marked: Marked = createDialectMarked()): AnyExtension {
  return Markdown.configure({ marked: marked as never, indentation: INDENT });
}

/** The editor's parser and serializer without a browser, so the server's tests can hold it to the same corpus. */
export function createDialectManager(options: DialectOptions = {}): { manager: MarkdownManager; marked: Marked } {
  const marked = createDialectMarked();
  return { marked, manager: new MarkdownManager({ extensions: createDialectExtensions(options), marked: marked as never, indentation: INDENT }) };
}

/**
 * The raw source of each top-level block as marked sees it. They line up one-to-one with the
 * editor's top-level nodes, which is what makes block-level write back possible.
 */
export function editorSourceBlocks(marked: Marked, body: string): string[] {
  return marked.lexer(body).filter(token => token.type !== "space").map(token => token.raw.trim());
}
