import { parseDocument, topLevelBlocks, type EditOp } from "@pandocs/markdown";
import type { PandocsPage } from "../data/pages";

export interface Target {
  /** What the person edits, and what it replaces. */
  readonly source: string;
  /** The source is exactly the selected words, rather than the blocks around them. */
  readonly exact: boolean;
  ops(content: string): readonly EditOp[];
}

function countOf(text: string, pattern: string): number {
  let count = 0;
  for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + pattern.length)) count += 1;
  return count;
}

/**
 * The selection is rendered text, the suggestion is against the Markdown. Words found once in the source
 * are replaced as they are; anything else, such as text across bold marks, rewrites its top-level blocks.
 */
export function suggestionTarget(page: PandocsPage, exact: string, firstRef: string | undefined, lastRef: string | undefined): Target | null {
  const markdown = page.view.markdown ?? "";
  if (countOf(markdown, exact) === 1) return { source: exact, exact: true, ops: content => [{ op: "str_replace", pattern: exact, content }] };
  const blocks = topLevelBlocks(parseDocument(markdown));
  const first = blocks.find(block => block.ref === firstRef);
  const last = blocks.find(block => block.ref === lastRef) ?? first;
  if (!first || !last) return null;
  const end = last.ref === first.ref ? {} : { end: last.ref };
  return { source: markdown.slice(first.start, last.end), exact: false, ops: content => [{ op: "block_replace", ref: first.ref, ...end, content }] };
}
