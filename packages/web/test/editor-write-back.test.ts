// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { joinBlocks, splitFrontMatter } from "@pandocs/markdown";
import { createDialectExtensions, createDialectMarked, createMarkdownExtension, editorSourceBlocks } from "@pandocs/editor-model";
import { createWriteBack, replaceChangedBlocks } from "../src/editor/write-back";

const DIR = join(import.meta.dirname, "../../markdown/test/fixtures/corpus");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as { file: string; title: string }[];
const pages = manifest.map(entry => ({ ...entry, markdown: readFileSync(join(DIR, entry.file), "utf8") }));

const opened: Editor[] = [];

// ProseMirror flushes its DOM observer on a 20 ms timer, which must not outlive the test environment.
afterEach(async () => {
  for (const editor of opened.splice(0)) editor.destroy();
  await new Promise(resolve => setTimeout(resolve, 40));
});

function open(body: string) {
  const marked = createDialectMarked();
  const editor = new Editor({ extensions: [...createDialectExtensions(), createMarkdownExtension(marked)], content: body, contentType: "markdown" } as never);
  // Mounting in a browser dispatches a transaction, which is what lets the editor append its trailing paragraph.
  editor.view.dispatch(editor.state.tr);
  opened.push(editor);
  return { editor, marked, writeBack: createWriteBack(editor, marked, body) };
}

const changedLines = (before: string, after: string) => {
  const a = new Set(before.split("\n"));
  const b = new Set(after.split("\n"));
  return { removed: [...a].filter(line => !b.has(line)), added: [...b].filter(line => !a.has(line)) };
};

/** First top-level paragraph with ordinary text; returns where its text starts. */
function firstParagraph(editor: Editor): number {
  let at = -1;
  editor.state.doc.forEach((node, offset) => {
    if (at < 0 && node.type.name === "paragraph" && node.textContent.trim()) at = offset + 1;
  });
  return at;
}

describe("block-level write back in a real editor", () => {
  it.each(pages.map(page => [page.title, page.markdown] as const))("an untouched document stays byte-identical: %s", (_title, markdown) => {
    const { body } = splitFrontMatter(markdown);
    const { writeBack, marked } = open(body);
    expect(writeBack.aligned).toBe(true);
    expect(writeBack.markdown()).toBe(joinBlocks(editorSourceBlocks(marked, body)));
  });

  it.each(pages.map(page => [page.title, page.markdown] as const))("typing into one paragraph changes one line: %s", (_title, markdown) => {
    const { body } = splitFrontMatter(markdown);
    const { editor, writeBack } = open(body);
    const at = firstParagraph(editor);
    if (at < 0) return;
    const before = writeBack.markdown();
    editor.commands.insertContentAt(at, "【新增】");
    const { added, removed } = changedLines(before, writeBack.markdown());
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("【新增】");
    expect(removed).toHaveLength(1);
  });

  it("does not treat the editor's trailing paragraph as content", () => {
    const body = "正文\n\n- 列表结尾\n";
    const { editor, writeBack } = open(body);
    expect(editor.getJSON().content?.at(-1)).toMatchObject({ type: "paragraph" });
    expect(writeBack.aligned).toBe(true);
    expect(writeBack.markdown()).toBe(body);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "新的一段");
    expect(writeBack.markdown()).toBe("正文\n\n- 列表结尾\n\n新的一段\n");
  });

  it("keeps a block's source form when only its neighbour changes", () => {
    const body = "第一段\n\n| 列 |\n|:--|\n| 值 |\n\n:::note{emoji='x'}\n\n带非规范引号的属性\n\n:::\n\n最后一段\n";
    const { editor, writeBack } = open(body);
    editor.commands.insertContentAt(1, "改");
    const next = writeBack.markdown();
    expect(next).toContain("改第一段");
    expect(next).toContain("|:--|");
    expect(next).toContain("{emoji='x'}");
  });
});

describe("coming back from the Markdown source", () => {
  const BODY = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
  const endOf = (editor: Editor, text: string) => {
    let at = -1;
    editor.state.doc.forEach((node, offset) => {
      if (node.textContent.startsWith(text)) at = offset + node.nodeSize - 1;
    });
    return at;
  };
  const paragraphs = (editor: Editor) => {
    const texts: string[] = [];
    editor.state.doc.forEach(node => { if (node.textContent) texts.push(node.textContent); });
    return texts;
  };

  it("keeps the space someone else has just typed at the end of a paragraph it did not change", () => {
    const { editor } = open(BODY);
    editor.commands.insertContentAt(endOf(editor, "Third paragraph."), " Typed ");
    // Written out, that paragraph has lost its last space, which is what the merged Markdown says.
    replaceChangedBlocks(editor, "First paragraph, in source.\n\nSecond paragraph.\n\nThird paragraph. Typed\n");
    editor.commands.insertContentAt(endOf(editor, "Third paragraph."), "meanwhile.");
    expect(paragraphs(editor)).toEqual(["First paragraph, in source.", "Second paragraph.", "Third paragraph. Typed meanwhile."]);
  });

  it("adds, removes and changes blocks as the Markdown says", () => {
    const { editor } = open(BODY);
    replaceChangedBlocks(editor, "Second paragraph, changed.\n\nThird paragraph.\n\nA fourth.\n");
    expect(paragraphs(editor)).toEqual(["Second paragraph, changed.", "Third paragraph.", "A fourth."]);
    replaceChangedBlocks(editor, "Second paragraph, changed.\n\nThird paragraph.\n\nA fourth.\n");
    expect(paragraphs(editor)).toEqual(["Second paragraph, changed.", "Third paragraph.", "A fourth."]);
  });
});
