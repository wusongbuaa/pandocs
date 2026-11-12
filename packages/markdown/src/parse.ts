import { t } from "@pandocs/i18n";
import type { Nodes, Paragraph, Parent, Root, RootContent } from "mdast";
import "mdast-util-directive";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import remarkDirective from "remark-directive";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type Pluggable } from "unified";
import type { ZodError } from "zod";
import { parseAttributes, type BlockAttributes } from "./attributes.js";
import {
  ALERT_BLOCKS,
  defaultBlockRegistry,
  type BlockDefinition,
  type BlockKind,
  type BlockRegistry
} from "./registry.js";
import { MOST_TREE_DEPTH, nestsTooDeeply, outOfStack, treeDepth } from "./nesting.js";
import { applySuperSub } from "./supersub.js";

export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly block?: string;
  readonly line?: number;
}

export interface BlockOccurrence {
  readonly name: string;
  readonly kind: BlockKind | "unknown";
  readonly attrs: BlockAttributes;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

export interface ParsedDocument {
  readonly markdown: string;
  readonly tree: Root;
  readonly blocks: readonly BlockOccurrence[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Marks left on mdast nodes for the renderer and the text projection. */
export interface DialectData {
  readonly pandocsBlock?: {
    readonly name: string;
    readonly kind: BlockKind;
    readonly attrs: BlockAttributes;
    readonly body?: unknown;
    readonly alert?: boolean;
  };
  readonly pandocsUnknown?: { readonly raw: string };
}

/**
 * Prices stay text, so formulas take `$$`; a single `~` is left to subscripts and ranges.
 * The reader uses this list too, or the server and the page would count different text.
 */
export const REMARK_SYNTAX: Pluggable[] = [
  remarkFrontmatter,
  [remarkGfm, { singleTilde: false }],
  remarkDirective,
  remarkCjkFriendly,
  [remarkCjkFriendlyGfmStrikethrough, { singleTilde: false }],
  [remarkMath, { singleDollarTextMath: false }]
];

const processor = unified().use(remarkParse).use(REMARK_SYNTAX);
const BREAK_HTML = /^<br\s*\/?>$/iu;
const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/u;
const LOOSE_OPENING = /^:{3,}[ \t]*([a-zA-Z][\w-]*)(?:[ \t]+([^\n]*\S))?[ \t]*(?:\n|$)/u;
const LOOSE_CLOSING = /(?:^|\n)[ \t]*:{3,}[ \t]*$/u;

export function parseDocument(markdown: string, registry: BlockRegistry = defaultBlockRegistry): ParsedDocument {
  const tree = boundedTree(markdown, text => processor.runSync(processor.parse(text)) as Root);
  if (!tree) return { markdown, tree: sourceTree(markdown), blocks: [], diagnostics: [tooDeep()] };
  const { blocks, diagnostics } = applyDialect(tree, markdown, registry);
  return { markdown, tree, blocks, diagnostics };
}

/**
 * A page's tree, or null for one that nests too deeply to parse and walk safely. The same text gets the same answer on
 * any thread, however much stack it has, so every reader of a page sees it the same way.
 */
export function boundedTree(markdown: string, parse: (markdown: string) => Root): Root | null {
  if (nestsTooDeeply(markdown)) return null;
  let tree: Root;
  try {
    tree = parse(markdown);
  } catch (error) {
    if (outOfStack(error)) return null;
    throw error;
  }
  return treeDepth(tree) > MOST_TREE_DEPTH ? null : tree;
}

/** What a page that nests too deeply reads as: all of its text, as it was written, in one block. */
export function sourceTree(markdown: string): Root {
  const lines = markdown.split(/\r\n|\r|\n/u);
  const position = {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: lines.length, column: lines.at(-1)!.length + 1, offset: markdown.length }
  };
  return { type: "root", children: markdown.trim() ? [{ type: "code", value: markdown, position }] : [], position };
}

const tooDeep = (): Diagnostic => ({
  severity: "error",
  code: "DOCUMENT_TOO_DEEP",
  message: t(
    "Blocks or formatting here are nested inside each other more deeply than a page can be, so it shows as its source. Take some of the nesting out."
  )
});

/** Also runs as a remark plugin in the reader, so both paths see the same tree. */
export function applyDialect(tree: Root, source: string, registry: BlockRegistry) {
  const blocks: BlockOccurrence[] = [];
  const diagnostics: Diagnostic[] = [];
  gatherLooseContainers(tree, registry);
  applySuperSub(tree, source);

  const record = (node: Nodes, name: string, kind: BlockOccurrence["kind"], attrs: BlockAttributes) => {
    blocks.push({
      name,
      kind,
      attrs,
      start: node.position?.start.offset ?? 0,
      end: node.position?.end.offset ?? 0,
      line: node.position?.start.line ?? 0
    });
  };

  const known = (
    node: Nodes,
    definition: BlockDefinition,
    attrs: BlockAttributes,
    extra: Partial<NonNullable<DialectData["pandocsBlock"]>> = {}
  ) => {
    setData(node, { pandocsBlock: { name: definition.name, kind: definition.kind, attrs, ...extra } });
    record(node, definition.name, definition.kind, attrs);
    diagnostics.push(...validateAttrs(definition, attrs, node));
  };

  const visit = (node: Nodes, parent: Parent | null, index: number): void => {
    if (node.type === "textDirective") {
      const definition = registry.get(node.name);
      if (definition?.kind === "inline" && node.children.length > 0) {
        known(node, definition, normalizedAttributes(node.attributes));
      } else {
        // `10:30` and `地址:abc` parse as text directives; give the reader back what the author wrote.
        parent!.children[index] = { type: "text", value: sourceOf(node, source) } as RootContent;
        return;
      }
    } else if (node.type === "leafDirective" || node.type === "containerDirective") {
      const definition = registry.get(node.name);
      const kind = node.type === "leafDirective" ? "leaf" : "container";
      if (definition?.kind === kind) {
        known(node, definition, normalizedAttributes(node.attributes));
      } else {
        setData(node, { pandocsUnknown: { raw: sourceOf(node, source) } });
        record(node, node.name, "unknown", {});
        diagnostics.push({
          severity: "warning",
          code: "BLOCK_UNKNOWN",
          message: t("Unknown block {0}. It is kept but not shown.", node.name),
          block: node.name,
          ...lineOf(node)
        });
        return;
      }
    } else if (node.type === "code" && node.lang && registry.get(node.lang)?.kind === "fence") {
      const definition = registry.get(node.lang)!;
      const attrs = parseAttributes(node.meta ?? undefined);
      known(node, definition, attrs, parsedBody(definition, node.value, node, diagnostics));
      return;
    } else if (node.type === "blockquote") {
      const alert = alertOf(node);
      if (alert) {
        const definition = registry.get(alert);
        if (definition) known(node, definition, {}, { alert: true });
      }
    } else if (node.type === "html" && BREAK_HTML.test(node.value.trim())) {
      parent!.children[index] = { type: "break" } as RootContent;
      return;
    }
    if ("children" in node) {
      for (let i = 0; i < node.children.length; i += 1) visit(node.children[i]!, node, i);
    }
  };

  visit(tree, null, 0);
  return { blocks, diagnostics };
}

/**
 * VitePress, Docusaurus and Rspress write `:::tip 标题`, which micromark reads as ordinary paragraphs.
 * Third-party Markdown arrives this way, so a known container in that form is rebuilt as a real directive.
 */
function gatherLooseContainers(parent: Parent, registry: BlockRegistry): void {
  for (let index = 0; index < parent.children.length; index += 1) {
    const opener = parent.children[index]!;
    if (opener.type === "containerDirective") gatherLooseContainers(opener, registry);
    if (opener.type !== "paragraph" || opener.children[0]?.type !== "text") continue;
    const head = opener.children[0];
    const match = LOOSE_OPENING.exec(head.value);
    if (!match || registry.get(match[1]!)?.kind !== "container") continue;
    const onOwnLine = head.value.length > match[0].length || opener.children.length === 1;
    if (!onOwnLine) continue;
    const rest: Paragraph = {
      ...opener,
      children: [{ ...head, value: head.value.slice(match[0].length) }, ...opener.children.slice(1)]
    };
    const closedAt = findLooseClosing(parent, index, rest);
    if (closedAt === null) continue;
    const inner: Nodes[] = [
      ...(rest.children.some(child => child.type !== "text" || child.value) ? [rest] : []),
      ...parent.children.slice(index + 1, closedAt.index),
      ...(closedAt.tail ? [closedAt.tail] : [])
    ];
    const label = match[2]
      ? [{ type: "paragraph", data: { directiveLabel: true }, children: [{ type: "text", value: match[2] }] }]
      : [];
    const last = parent.children[closedAt.index]!;
    const container = {
      type: "containerDirective",
      name: match[1]!,
      attributes: {},
      children: [...label, ...inner],
      ...(opener.position && last.position
        ? { position: { start: opener.position.start, end: last.position.end } }
        : {})
    } as unknown as RootContent;
    parent.children.splice(index, closedAt.index - index + 1, container);
    gatherLooseContainers(container as unknown as Parent, registry);
  }
}

/** The closing `:::` is the end of a paragraph, either on its own or as the last line of the opener's paragraph. */
function findLooseClosing(
  parent: Parent,
  index: number,
  rest: Paragraph
): { index: number; tail: Paragraph | null } | null {
  const closesIn = (paragraph: Paragraph): Paragraph | "closed-empty" | null => {
    const last = paragraph.children.at(-1);
    if (last?.type !== "text" || !LOOSE_CLOSING.test(last.value)) return null;
    const value = last.value.replace(LOOSE_CLOSING, "");
    const children = [...paragraph.children.slice(0, -1), ...(value ? [{ ...last, value }] : [])];
    return children.length > 0 ? { ...paragraph, children } : "closed-empty";
  };
  const own = closesIn(rest);
  if (own) {
    if (own !== "closed-empty") rest.children = own.children;
    else rest.children = [];
    return { index, tail: null };
  }
  for (let at = index + 1; at < parent.children.length; at += 1) {
    const node = parent.children[at]!;
    if (node.type === "paragraph") {
      if (LOOSE_OPENING.test(node.children[0]?.type === "text" ? node.children[0].value : "")) return null;
      const closed = closesIn(node);
      if (closed) return { index: at, tail: closed === "closed-empty" ? null : closed };
    }
  }
  return null;
}

function alertOf(node: Extract<Nodes, { type: "blockquote" }>): string | undefined {
  const first = node.children[0];
  if (first?.type !== "paragraph") return undefined;
  const text = first.children[0];
  if (text?.type !== "text") return undefined;
  const match = ALERT_MARKER.exec(text.value);
  if (!match) return undefined;
  const value = text.value.slice(match[0].length);
  if (value) text.value = value;
  else first.children.shift();
  if (first.children[0]?.type === "break") first.children.shift();
  if (first.children.length === 0) node.children.shift();
  return ALERT_BLOCKS[match[1]!];
}

function parsedBody(definition: BlockDefinition, body: string, node: Nodes, diagnostics: Diagnostic[]) {
  if (!definition.parseBody) return {};
  try {
    return { body: definition.parseBody(body) };
  } catch (error) {
    const detail =
      error instanceof SyntaxError
        ? t("Not valid JSON")
        : ((error as ZodError).issues?.[0]?.message ?? (error instanceof Error ? error.message : ""));
    diagnostics.push({
      severity: "error",
      code: "BLOCK_BODY_INVALID",
      message: t("The content of {0} cannot be read: {1}", definition.name, detail),
      block: definition.name,
      ...lineOf(node)
    });
    return {};
  }
}

function validateAttrs(definition: BlockDefinition, attrs: BlockAttributes, node: Nodes): Diagnostic[] {
  const result = definition.attrs.safeParse(attrs);
  if (result.success) return [];
  return result.error.issues.map(issue => {
    if (issue.code === "unrecognized_keys") {
      return {
        severity: "warning" as const,
        code: "BLOCK_ATTR_UNKNOWN",
        message: t("{0} has no attribute {1}", definition.name, issue.keys.join(t(", "))),
        block: definition.name,
        ...lineOf(node)
      };
    }
    return {
      severity: "error" as const,
      code: "BLOCK_ATTR_INVALID",
      message: t("Attribute {1} of {0} is not valid: {2}", definition.name, issue.path.join("."), issue.message),
      block: definition.name,
      ...lineOf(node)
    };
  });
}

function normalizedAttributes(
  attributes: Record<string, string | null | undefined> | null | undefined
): BlockAttributes {
  const result: BlockAttributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) result[key] = value ?? "";
  return result;
}

function sourceOf(node: Nodes, source: string): string {
  return source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
}

function lineOf(node: Nodes): { line?: number } {
  return node.position ? { line: node.position.start.line } : {};
}

function setData(node: Nodes, data: DialectData): void {
  (node as { data?: object }).data = { ...(node as { data?: object }).data, ...data };
}

export function dialectOf(node: Nodes): DialectData {
  return ((node as { data?: DialectData }).data ?? {}) as DialectData;
}
