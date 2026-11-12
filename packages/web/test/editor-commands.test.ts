// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { defaultBlockRegistry } from "@pandocs/markdown";
import { insertBlock, runSlashItem, slashItems } from "../src/editor/commands";
import {
  createDialectExtensions,
  createDialectManager,
  createDialectMarked,
  createMarkdownExtension,
  readerHeadingsOf
} from "@pandocs/editor-model";
import { createWriteBack } from "../src/editor/write-back";

function editorWith(markdown: string, title = "页面标题") {
  const marked = createDialectMarked();
  const extensions = [
    ...createDialectExtensions({ readerHeadings: readerHeadingsOf(marked, markdown, title) }),
    createMarkdownExtension(marked)
  ];
  return {
    marked,
    editor: new Editor({
      element: document.createElement("div"),
      extensions,
      content: markdown,
      contentType: "markdown"
    } as never)
  };
}

describe("slash items", () => {
  it("can be found by label, pinyin initials or English", () => {
    const items = slashItems(
      () => undefined,
      () => undefined
    );
    const find = (text: string) =>
      items.filter(item => item.label.includes(text) || item.keywords.includes(text)).map(item => item.id);
    expect(find("表格")).toContain("table");
    expect(find("bg")).toContain("table");
    expect(find("mermaid")).toContain("mermaid");
  });

  it("has an item for every block the schema can hold", () => {
    const ids = new Set(
      slashItems(
        () => undefined,
        () => undefined
      ).map(item => item.id)
    );
    for (const block of [
      "tip",
      "note",
      "warning",
      "danger",
      "info",
      "columns",
      "video",
      "subpages",
      "mermaid",
      "chart"
    ])
      expect(ids, block).toContain(block);
  });

  it("replaces the typed trigger with the block, in the Markdown the document will store", () => {
    const { editor, marked } = editorWith("开头\n");
    const writeBack = createWriteBack(editor, marked, "开头\n");
    const item = slashItems(
      () => undefined,
      () => undefined
    ).find(entry => entry.id === "tip")!;
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "/ts");
    const end = editor.state.doc.content.size - 1;
    runSlashItem(editor, { from: end - 3, to: end }, item);
    const markdown = writeBack.markdown();
    expect(markdown).toContain("开头");
    expect(markdown).toContain(":::tip");
    expect(markdown).not.toContain("/ts");
    editor.destroy();
  });

  it("inserts a registered block the schema knows", () => {
    const { editor } = editorWith("开头\n");
    insertBlock(editor, defaultBlockRegistry, "warning");
    expect(editor.getJSON().content?.some(node => node.type === "warning")).toBe(true);
    editor.destroy();
  });
});

describe("demonstration blocks from the slash menu", () => {
  it.each([
    ["steps", ":::steps", "### 第一步"],
    ["tabs", "::::tabs", ":::tab[标签一]"],
    ["cards", "::::cards", ":::card[卡片一]"],
    ["prompt", "```prompt", ""],
    ["hotspots", "```hotspots", "[]"],
    ["compare", "::compare", ""],
    ["mindmap", "```mindmap", "- 分支一"]
  ])("start %s with the parts it is made of", (id, opening, part) => {
    const { editor, marked } = editorWith("开头\n");
    const writeBack = createWriteBack(editor, marked, "开头\n");
    const item = slashItems(
      () => undefined,
      () => undefined
    ).find(entry => entry.id === id)!;
    item.run(editor);
    const markdown = writeBack.markdown();
    expect(markdown).toContain(opening);
    expect(markdown).toContain(part);
    editor.destroy();
  });
});

describe("headings in the editor", () => {
  const shown = (markdown: string, title = "页面标题") => {
    const { editor } = editorWith(markdown, title);
    const tags = [...editor.view.dom.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(element => element.tagName);
    editor.destroy();
    return tags;
  };

  it("match the reader: body `#` steps down because the page title is the only h1", () => {
    expect(shown("# 第一节\n\n正文\n\n## 小节\n")).toEqual(["H2", "H3"]);
    expect(shown("## 第一节\n\n### 小节\n")).toEqual(["H2", "H3"]);
  });

  it("keep a first heading that repeats the title as the title", () => {
    expect(shown("# 页面标题\n\n# 第一节\n")).toEqual(["H1", "H2"]);
    expect(shown("# 页面标题\n\n## 第一节\n")).toEqual(["H1", "H2"]);
  });

  it("do not change the levels written back to Markdown", () => {
    const { editor, marked } = editorWith("# 第一节\n\n## 小节\n");
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "新增" }]
    });
    expect(createWriteBack(editor, marked, "# 第一节\n\n## 小节\n").markdown()).toContain("# 第一节\n\n## 小节");
    editor.destroy();
  });

  it("read back at their written level when copied within the editor", () => {
    const { editor } = editorWith("# 第一节\n");
    const rule = getSchema(createDialectExtensions({ readerHeadings: { stepDown: true, title: "页面标题" } })).nodes
      .heading!.spec.parseDOM!;
    expect(rule.find(item => "tag" in item && item.tag === "h2")?.attrs).toEqual({ level: 1 });
    editor.destroy();
  });

  it("leave the server-side manager with its plain schema", () => {
    const { manager } = createDialectManager();
    expect(manager.parse("# 一\n").content?.[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
  });
});

describe("dragging a block by its handle", () => {
  it("moves a whole table, leaving no empty one where it was", async () => {
    const { startBlockDrag } = await import("../src/editor/block-handle");
    const { editor } = editorWith("说明\n\n| 单号 | 备注 |\n| --- | --- |\n| SF1 | 好 |\n\n下一步\n");
    let table = -1;
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === "table") table = offset;
    });
    const selection = startBlockDrag(editor.view, table);
    // Selecting a whole table selects its cells, and removing what is selected would only empty them.
    expect(editor.state.selection.constructor.name).toBe("CellSelection");
    const dragging = (
      editor.view as unknown as { dragging: { slice: Slice; move: boolean; node?: { replace(tr: Transaction): void } } }
    ).dragging;
    expect(dragging.move).toBe(true);
    // What ProseMirror does with a move dropped at the start of the page.
    const tr = editor.state.tr;
    dragging.node!.replace(tr);
    tr.replaceRangeWith(0, 0, dragging.slice.content.firstChild!);
    const tables: string[] = [];
    tr.doc.forEach(node => {
      if (node.type.name === "table") tables.push(node.textContent);
    });
    expect(tables).toEqual(["单号备注SF1好"]);
    expect(tr.doc.firstChild!.type.name).toBe("table");
    expect(selection.from).toBe(table);
  });
});
