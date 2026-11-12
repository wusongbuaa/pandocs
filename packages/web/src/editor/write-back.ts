import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { blocksOf, editorSourceBlocks, writeBackBlocks } from "@pandocs/editor-model";
import type { Marked } from "marked";

export interface WriteBack {
  /** False when the source and the editor disagree on blocks, so a save rewrites the whole document. */
  readonly aligned: boolean;
  markdown(): string;
}

type WithMarkdown = Editor & { markdown: { serialize(doc: JSONContent): string; parse(markdown: string): JSONContent } };

const serialize = (editor: Editor) => (doc: JSONContent) => (editor as WithMarkdown).markdown.serialize(doc);

/** Untouched blocks keep their original bytes, so a one-line edit stays a one-line diff. */
export function createWriteBack(editor: Editor, marked: Marked, body: string): WriteBack {
  const source = editorSourceBlocks(marked, body);
  // In a shared draft, what the editor holds by now is not what this text says.
  const baseline = blocksOf(editor.schema.nodeFromJSON((editor as WithMarkdown).markdown.parse(body)).toJSON() as JSONContent, serialize(editor));
  return {
    aligned: source.length === baseline.length,
    markdown: () => writeBackBlocks(source, baseline, blocksOf(editor.getJSON(), serialize(editor)))
  };
}

/**
 * Makes the editor say this Markdown by replacing only the top-level blocks that read differently, so that in a shared draft
 * what someone else is typing elsewhere is left alone. Written out as Markdown, a paragraph loses the space someone has just
 * typed at its end; replacing the whole document would take that space out from under them.
 */
export function replaceChangedBlocks(editor: Editor, body: string): void {
  const write = serialize(editor);
  const next = editor.schema.nodeFromJSON((editor as WithMarkdown).markdown.parse(body));
  const now = editor.state.doc;
  const text = (node: ProseMirrorNode) => write({ type: "doc", content: [node.toJSON() as JSONContent] }).trim();
  const empty = (node: ProseMirrorNode) => node.type.name === "paragraph" && node.childCount === 0;
  // The trailing empty paragraphs the editor keeps for the caret are not content, on either side.
  const contentOf = (doc: ProseMirrorNode) => {
    const nodes: ProseMirrorNode[] = [];
    doc.forEach(node => { nodes.push(node); });
    while (nodes.length && empty(nodes.at(-1)!)) nodes.pop();
    return nodes;
  };
  const before = contentOf(now);
  const after = contentOf(next);
  const was = before.map(text);
  const will = after.map(text);
  let start = 0;
  while (start < was.length && start < will.length && was[start] === will[start]) start += 1;
  let end = 0;
  while (end < was.length - start && end < will.length - start && was[was.length - 1 - end] === will[will.length - 1 - end]) end += 1;
  if (start === was.length && start === will.length) return;
  let from = 0;
  for (const node of before.slice(0, start)) from += node.nodeSize;
  let to = from;
  for (const node of before.slice(start, before.length - end)) to += node.nodeSize;
  editor.view.dispatch(editor.state.tr.replaceWith(from, to, after.slice(start, after.length - end)));
}
