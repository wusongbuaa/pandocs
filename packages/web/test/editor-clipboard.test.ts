// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import { DOMParser, DOMSerializer, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createDialectExtensions, createDialectManager } from "@pandocs/editor-model";
describe("copying within the editor", () => {
  it("keeps what each block says about itself, through the HTML a copy travels as", () => {
    const markdown = [
      ":::warning[Over 30 days needs a supervisor]",
      "",
      "Check it.",
      "",
      ":::",
      "",
      ":::details[What someone collecting for another brings]",
      "",
      "An ID.",
      "",
      ":::",
      "",
      "::::cards",
      "",
      ':::card[Returns FAQ]{href="./faq.md"}',
      "",
      "Read this first.",
      "",
      ":::",
      "",
      "::::",
      "",
      "::::tabs",
      "",
      ":::tab[Morning]",
      "",
      "08:30.",
      "",
      ":::",
      "",
      ":::tab[Night]",
      "",
      "21:30.",
      "",
      ":::",
      "",
      "::::",
      "",
      '::video[Unloading]{src="assets/a.mp4" poster="assets/p.png"}',
      "",
      '::file[Form.pdf]{src="assets/f.pdf"}',
      "",
      'Status :tag[Done]{tone="tip"} and a note.[^approval]',
      "",
      "[^approval]: Confirmed by the supervisor.",
      ""
    ].join("\n");
    const { manager } = createDialectManager();
    const schema = getSchema(createDialectExtensions());
    const copied = ProseMirrorNode.fromJSON(schema, manager.parse(markdown));
    const clipboard = document.createElement("div");
    clipboard.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(copied.content, { document }));
    const pasted = DOMParser.fromSchema(schema).parse(clipboard);
    expect(manager.serialize(pasted.toJSON() as JSONContent)).toBe(manager.serialize(copied.toJSON() as JSONContent));
  });
});
