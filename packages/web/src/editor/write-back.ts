import type { Editor, JSONContent } from "@tiptap/core";
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
