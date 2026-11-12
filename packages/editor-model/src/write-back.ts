import type { JSONContent } from "@tiptap/core";
import { joinBlocks, spliceBlocks } from "@pandocs/markdown";

/** The text of each top-level block. The editor keeps empty paragraphs at the end so the caret can land there, and they are not content. */
export function blocksOf(doc: JSONContent, serialize: (doc: JSONContent) => string): string[] {
  const nodes = [...(doc.content ?? [])];
  while (nodes.at(-1)?.type === "paragraph" && !nodes.at(-1)?.content?.length) nodes.pop();
  return nodes.map(node => serialize({ type: "doc", content: [node] }).trim());
}

/** Untouched blocks keep their original bytes, so a one-line edit stays a one-line diff. If the source and the editor disagree on what the blocks are, the whole document is rewritten. */
export function writeBackBlocks(
  source: readonly string[],
  baseline: readonly string[],
  current: readonly string[]
): string {
  return joinBlocks(source.length === baseline.length ? spliceBlocks(source, baseline, current) : current);
}
