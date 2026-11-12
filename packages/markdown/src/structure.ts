import { t } from "@pandocs/i18n";
import type { Nodes, RootContent } from "mdast";
import { dialectOf, parseDocument, type Diagnostic, type ParsedDocument } from "./parse.js";
import { defaultBlockRegistry, type BlockRegistry } from "./registry.js";
import { searchTokens } from "./search-tokens.js";
import { squashWhitespace, visibleText, visibleTextOf } from "./visible-text.js";

export interface SourceBlock {
  /** Position within one revision only; never written into the Markdown. */
  readonly ref: string;
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly preview: string;
}

export interface OutlineEntry {
  readonly ref: string;
  readonly depth: number;
  readonly text: string;
  readonly slug: string;
}

export function topLevelBlocks(document: ParsedDocument): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  for (const node of document.tree.children) {
    if (node.type === "yaml" || !node.position) continue;
    blocks.push({
      ref: `b${blocks.length + 1}`,
      type: blockType(node),
      start: node.position.start.offset ?? 0,
      end: node.position.end.offset ?? 0,
      line: node.position.start.line,
      preview: previewOf(node)
    });
  }
  return blocks;
}

/** The top-level blocks that a range of reading offsets falls in, for anything that has to edit around a text anchor. */
export function blocksInTextRange(
  document: ParsedDocument,
  start: number,
  end: number,
  registry: BlockRegistry = defaultBlockRegistry
): { first: string; last: string } | null {
  const blocks = topLevelBlocks(document);
  const nodes = document.tree.children.filter(node => node.type !== "yaml" && node.position);
  let offset = 0;
  let found: { first: string; last: string } | null = null;
  nodes.forEach((node, index) => {
    const length = squashWhitespace(visibleTextOf(node, registry)).length;
    if (length > 0 && offset < end && offset + length > start) {
      const { ref } = blocks[index]!;
      found = { first: found?.first ?? ref, last: ref };
    }
    offset += length;
  });
  return found;
}

function blockType(node: RootContent): string {
  const dialect = dialectOf(node);
  if (dialect.pandocsBlock) return dialect.pandocsBlock.name;
  if (dialect.pandocsUnknown) return "unknown";
  return node.type;
}

function previewOf(node: Nodes): string {
  return plainText(node).replace(/\s+/gu, " ").trim().slice(0, 80);
}

export function plainText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "image") return node.alt ?? "";
  if (!("children" in node)) return "";
  return node.children
    .map(child => plainText(child))
    .join(node.type === "paragraph" || node.type === "heading" ? "" : " ");
}

export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return text => {
    const base =
      text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
        .replace(/\s+/gu, "-") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

export function outlineOf(document: ParsedDocument): OutlineEntry[] {
  const refs = new Map<RootContent, string>();
  let index = 0;
  for (const node of document.tree.children) {
    if (node.type !== "yaml") refs.set(node, `b${(index += 1)}`);
  }
  const slug = createSlugger();
  const entries: OutlineEntry[] = [];
  const walk = (node: Nodes, topRef: string | undefined) => {
    if (node.type === "heading") {
      const text = plainText(node).trim();
      entries.push({ ref: topRef ?? "", depth: node.depth, text, slug: slug(text) });
    }
    if (dialectOf(node).pandocsUnknown || !("children" in node)) return;
    for (const child of node.children) walk(child, topRef ?? refs.get(child as RootContent));
  };
  walk(document.tree, undefined);
  return entries;
}

/**
 * What reading and committing a revision need from its parse, without the tree. Plain data: it can cross to a
 * worker thread cheaply and be kept per revision, so a read never has to parse a document it has seen before.
 */
export interface DocumentAnalysis {
  readonly visibleText: string;
  readonly outline: readonly OutlineEntry[];
  readonly blocks: readonly SourceBlock[];
  readonly diagnostics: readonly Diagnostic[];
  /** Only needed while committing, so it is left out of what gets kept. */
  readonly searchTokens?: readonly string[] | undefined;
}

export function analyzeDocument(markdown: string, registry: BlockRegistry = defaultBlockRegistry): DocumentAnalysis {
  const parsed = parseDocument(markdown, registry);
  const text = visibleText(parsed, registry);
  return {
    visibleText: text,
    outline: outlineOf(parsed),
    blocks: topLevelBlocks(parsed),
    diagnostics: parsed.diagnostics,
    searchTokens: searchTokens(text)
  };
}

export type ReadScope =
  | { readonly scope: "full" }
  | { readonly scope: "outline" }
  | { readonly scope: "section"; readonly section: string }
  | { readonly scope: "range"; readonly start: string; readonly end: string }
  | { readonly scope: "keyword"; readonly keyword: string; readonly context?: number };

export interface ScopedBlock extends SourceBlock {
  readonly markdown: string;
}

export interface ScopedRead {
  readonly outline: readonly OutlineEntry[];
  readonly blocks: readonly ScopedBlock[];
}

export class ScopeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ScopeError";
  }
}

/** Lets agents read the smallest part they need instead of the whole document. */
export function readScoped(
  document: ParsedDocument | { readonly markdown: string; readonly analysis: DocumentAnalysis },
  request: ReadScope
): ScopedRead {
  const { blocks, outline } =
    "analysis" in document ? document.analysis : { blocks: topLevelBlocks(document), outline: outlineOf(document) };
  const scoped = (selected: readonly SourceBlock[]): ScopedRead => ({
    outline,
    blocks: selected.map(block => ({ ...block, markdown: document.markdown.slice(block.start, block.end) }))
  });
  switch (request.scope) {
    case "outline":
      return { outline, blocks: [] };
    case "full":
      return scoped(blocks);
    case "section": {
      const entry = outline.find(
        item => item.slug === request.section || item.ref === request.section || item.text === request.section
      );
      if (!entry) throw new ScopeError("SECTION_NOT_FOUND", t("Section {0} not found", request.section));
      const start = blocks.findIndex(block => block.ref === entry.ref);
      if (start < 0) throw new ScopeError("SECTION_NOT_FOUND", t("Section {0} not found", request.section));
      const next = outline.find(
        item =>
          item.ref !== entry.ref && Number(item.ref.slice(1)) > Number(entry.ref.slice(1)) && item.depth <= entry.depth
      );
      const end = next ? blocks.findIndex(block => block.ref === next.ref) : blocks.length;
      return scoped(blocks.slice(start, end));
    }
    case "range": {
      const start = blocks.findIndex(block => block.ref === request.start);
      const end = blocks.findIndex(block => block.ref === request.end);
      if (start < 0 || end < start)
        throw new ScopeError("RANGE_INVALID", t("The start or end block is not valid. Read one version again."));
      return scoped(blocks.slice(start, end + 1));
    }
    case "keyword": {
      const keyword = request.keyword.trim().toLowerCase();
      if (!keyword) throw new ScopeError("KEYWORD_EMPTY", t("A keyword cannot be empty"));
      const context = request.context ?? 0;
      const hits = new Set<number>();
      blocks.forEach((block, index) => {
        if (document.markdown.slice(block.start, block.end).toLowerCase().includes(keyword)) {
          for (let i = Math.max(0, index - context); i <= Math.min(blocks.length - 1, index + context); i += 1)
            hits.add(i);
        }
      });
      return scoped(blocks.filter((_, index) => hits.has(index)));
    }
  }
}
