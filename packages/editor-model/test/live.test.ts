import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createDialectExtensions, createDialectManager, createLiveCodec, LIVE_FIELD, LIVE_META } from "../src/index.js";

const ROOT = join(import.meta.dirname, "../../..");
const fromFolder = (folder: string) => readdirSync(join(ROOT, folder)).filter(name => name.endsWith(".md")).map(name => [name, readFileSync(join(ROOT, folder, name), "utf8")] as const);
const docs = [...fromFolder("docs"), ...fromFolder("packages/markdown/test/fixtures/corpus")];
const RICH = [
  "---",
  "title: Rich",
  "---",
  "",
  "# Heading with *emphasis* and `code`",
  "",
  "A paragraph with a [link](https://example.com \"title\"), ~~strikethrough~~, ^sup^ and ~sub~, $$x^2$$ and a note[^1].",
  "",
  "*  a list with odd markers",
  "*  second",
  "   * nested",
  "",
  "1. one",
  "2. two",
  "",
  "- [ ] to do",
  "- [x] done",
  "",
  "| A | B |",
  "| --- | :-: |",
  "| 1 | 2 |",
  "",
  "> quoted",
  "",
  "> [!NOTE]",
  "> an alert",
  "",
  ":::tip[Careful]",
  "",
  "Inside a block.",
  "",
  ":::",
  "",
  "::::tabs",
  "",
  ":::tab[One]",
  "",
  "First.",
  "",
  ":::",
  "",
  ":::tab[Two]",
  "",
  "Second.",
  "",
  ":::",
  "",
  "::::",
  "",
  "::video{src=\"assets/abc.mp4\"}",
  "",
  ":::unknown-block{a=\"1\"}",
  "",
  "Kept as it is.",
  "",
  ":::",
  "",
  "```ts title=\"a.ts\"",
  "const a = 1;",
  "```",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "![A picture](assets/abc.png \"Caption align=center\")",
  "",
  "---",
  "",
  "[^1]: The note.",
  ""
].join("\n");

describe("a document as shared state", () => {
  const codec = createLiveCodec();

  const samples: readonly (readonly [string, string])[] = [["every kind of block", RICH], ...docs];

  const plain: readonly (readonly [string, string])[] = [["nothing", ""], ["one line", "Hello\n"], ["no last newline", "Hello"]];

  it.each([...samples, ...plain])("comes back from %s exactly as it went in", (_name, markdown) => {
    expect(codec.markdownOf(codec.seed(markdown, {}), markdown)).toBe(markdown);
  });

  it.each(samples)("has nothing to change when %s says the same thing", (_name, markdown) => {
    const state = codec.seed(markdown, { baseRevision: 1 });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const before = Y.encodeStateVector(doc);
    Y.applyUpdate(doc, codec.align(state, markdown, { baseRevision: 1 }).change);
    expect(Y.encodeStateVector(doc)).toEqual(before);
    expect(codec.markdownOf(Y.encodeStateAsUpdate(doc), markdown)).toBe(markdown);
  });

  it("changes only what differs, so that it merges with what someone else is typing", () => {
    const base = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
    const state = codec.seed(base, {});
    const person = new Y.Doc();
    Y.applyUpdate(person, state);
    // Someone is typing in the first paragraph while a change to the third arrives.
    const first = person.getXmlFragment(LIVE_FIELD).get(1) as Y.XmlElement;
    (first.get(0) as Y.XmlText).insert(5, " typed");
    Y.applyUpdate(person, codec.align(state, base.replace("Third", "Changed third"), {}).change);
    expect(codec.markdownOf(Y.encodeStateAsUpdate(person), base)).toBe("# Title\n\nFirst typed paragraph.\n\nSecond paragraph.\n\nChanged third paragraph.\n");
  });

  it("merges inside a paragraph that two people changed", () => {
    const base = "One two three.\n";
    const state = codec.seed(base, {});
    const person = new Y.Doc();
    Y.applyUpdate(person, state);
    ((person.getXmlFragment(LIVE_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, " and a half");
    Y.applyUpdate(person, codec.align(state, "One two three, four.\n", {}).change);
    expect(codec.markdownOf(Y.encodeStateAsUpdate(person), base)).toBe("One and a half two three, four.\n");
  });

  it("adds, removes and reorders blocks", () => {
    const base = "One.\n\nTwo.\n\nThree.\n";
    const state = codec.seed(base, {});
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const target = "New.\n\nThree.\n\n- a list\n\nOne.\n";
    Y.applyUpdate(doc, codec.align(state, target, {}).change);
    expect(codec.markdownOf(Y.encodeStateAsUpdate(doc), base)).toBe(target);
  });

  it("keeps the front matter, and what everyone should agree on", () => {
    const state = codec.seed("---\nlayout: wide\n---\n\nBody.\n", { baseRevision: 3 });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const meta = doc.getMap(LIVE_META);
    expect(meta.get("baseRevision")).toBe(3);
    expect(meta.get("frontMatter")).toContain("layout: wide");
    Y.applyUpdate(doc, codec.align(state, "---\nlayout: narrow\n---\n\nBody.\n", { baseRevision: 4 }).change);
    expect(meta.get("baseRevision")).toBe(4);
    expect(codec.markdownOf(Y.encodeStateAsUpdate(doc), "Body.\n")).toBe("---\nlayout: narrow\n---\n\nBody.\n");
  });

  it("does not count the empty paragraphs at the end as anything", () => {
    const base = "| A |\n| --- |\n| 1 |\n";
    const doc = new Y.Doc();
    Y.applyUpdate(doc, codec.seed(base, {}));
    const fragment = doc.getXmlFragment(LIVE_FIELD);
    // Two people opening a page at once can each add the paragraph the editor wants after a table.
    fragment.insert(fragment.length, [new Y.XmlElement("paragraph"), new Y.XmlElement("paragraph")]);
    expect(codec.markdownOf(Y.encodeStateAsUpdate(doc), base)).toBe(base);
  });

  it("takes time in proportion to a document's length, even at the longest a page can be", () => {
    const section = "## A section\n\nSome text with **bold**, a [link](https://example.com) and `code`.\n\n- an item\n- another\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```\n\n";
    const markdown = section.repeat(Math.ceil(2_000_000 / section.length));
    const started = performance.now();
    const state = codec.seed(markdown, {});
    expect(codec.markdownOf(state, markdown)).toBe(markdown);
    codec.align(state, `${markdown}One more.\n`, {});
    // About four seconds on a laptop. When reading was quadratic, this took minutes.
    expect(performance.now() - started).toBeLessThan(60_000);
  }, 120_000);
});

describe("what the editor keeps of a page", () => {
  const codec = createLiveCodec();
  const { manager } = createDialectManager();
  const schema = getSchema(createDialectExtensions());
  const editorDoc = (markdown: string) => ProseMirrorNode.fromJSON(schema, manager.parse(markdown));
  /** What saving gives once someone has typed at the end of the last paragraph, and changed nothing else. */
  const savedAfterTyping = (markdown: string) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, codec.seed(markdown, {}));
    const fragment = doc.getXmlFragment(LIVE_FIELD);
    const last = fragment.get(fragment.length - 1) as Y.XmlElement;
    (last.get(0) as Y.XmlText).insert((last.get(0) as Y.XmlText).length, " Typed.");
    return codec.markdownOf(Y.encodeStateAsUpdate(doc), markdown);
  };

  it.each([
    ["a sentence", "Check ![passed](assets/abc.png) before you submit.\n\nLast line.\n"],
    ["a heading", "## Status ![icon](assets/abc.png)\n\nLast line.\n"],
    ["a list item", "- Scan ![code](assets/abc.png) first\n- Then sign\n\nLast line.\n"],
    ["a table cell", "| Status | Step |\n| --- | --- |\n| ![ok](assets/abc.png) done | Sign |\n\nLast line.\n"],
    ["a link", "See [![badge](assets/abc.png)](https://example.com) here.\n\nLast line.\n"]
  ])("keeps a picture in %s, and the text around it", (_where, markdown) => {
    expect(() => editorDoc(markdown).check()).not.toThrow();
    expect(codec.markdownOf(codec.seed(markdown, {}), markdown)).toBe(markdown);
    expect(savedAfterTyping(markdown)).toBe(markdown.replace("Last line.", "Last line. Typed."));
  });

  it("still makes a picture on a line of its own a block", () => {
    expect(editorDoc("![A picture](assets/abc.png)\n").firstChild?.type.name).toBe("image");
    expect(editorDoc("A ![picture](assets/abc.png) in text.\n").firstChild!.child(1).type.name).toBe("inlineImage");
  });

  it("keeps tasks under a numbered step side by side, however far the step is indented", () => {
    for (const markdown of [
      "1. Check the papers.\n   - [ ] Number\n   - [ ] Address\n   - [x] Phone\n2. Sign.\n",
      "10. Check the papers.\n    - [ ] Number\n    - [ ] Address\n11. Sign.\n",
      "1. Check the papers.\n    - [ ] Number\n    - [ ] Address\n2. Sign.\n"
    ]) {
      const tasks = editorDoc(markdown).firstChild!.firstChild!.child(1);
      expect([tasks.type.name, tasks.childCount, tasks.firstChild!.childCount]).toEqual(["taskList", markdown.includes("Phone") ? 3 : 2, 1]);
    }
  });

  it("keeps a second paragraph of a footnote in the footnote", () => {
    const markdown = "A claim.[^n]\n\n[^n]: First part.\n\n    Second part.\n";
    const footnote = editorDoc(markdown).child(1);
    expect(footnote.attrs.text).toBe("First part.\n\nSecond part.");
    expect(manager.serialize({ type: "doc", content: [footnote.toJSON()] })).toBe("[^n]: First part.\n\n    Second part.");
    const typed = { type: "footnoteDefinition", attrs: { label: "n", text: "First part.\n\nA second, typed in the box.\n- and a list" } };
    expect(manager.serialize({ type: "doc", content: [typed] })).toBe("[^n]: First part.\n\n    A second, typed in the box.\n    - and a list");
  });
});

describe("two people changing one picture", () => {
  const codec = createLiveCodec();

  it("keeps a new caption from one and a new alignment from the other", () => {
    const markdown = "Intro.\n\n![Entrance](assets/abc.png \"First caption width=320\")\n\nEnd.\n";
    const state = codec.seed(markdown, {});
    const [captioning, aligning] = [new Y.Doc(), new Y.Doc()];
    for (const doc of [captioning, aligning]) Y.applyUpdate(doc, state);
    const image = (doc: Y.Doc) => doc.getXmlFragment(LIVE_FIELD).get(1) as Y.XmlElement;
    expect(image(captioning).getAttribute("title")).toBe("First caption");
    image(captioning).setAttribute("title", "A caption written offline");
    image(aligning).setAttribute("align", "right");
    Y.applyUpdate(captioning, Y.encodeStateAsUpdate(aligning));
    Y.applyUpdate(aligning, Y.encodeStateAsUpdate(captioning));
    for (const doc of [captioning, aligning]) {
      expect(codec.markdownOf(Y.encodeStateAsUpdate(doc), markdown)).toBe("Intro.\n\n![Entrance](assets/abc.png \"A caption written offline align=right width=320\")\n\nEnd.\n");
    }
  });
});
