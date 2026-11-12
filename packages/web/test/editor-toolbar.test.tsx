// @vitest-environment happy-dom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDialectExtensions, createDialectMarked, createMarkdownExtension } from "@pandocs/editor-model";
import { applyBootstrap } from "../src/data/bootstrap";
import { SelectionBubble } from "../src/editor/selection-bubble";
import { bootstrap } from "./support";

afterEach(cleanup);

describe("the toolbar over selected text", () => {
  it("keeps the link address open while someone types it, whatever else happens in the editor meanwhile", () => {
    applyBootstrap(bootstrap({ ai: { configured: false, ask: false } }));
    const element = document.body.appendChild(document.createElement("div"));
    const editor = new Editor({
      element,
      extensions: [...createDialectExtensions(), createMarkdownExtension(createDialectMarked())],
      content: "Read the returns guide first.\n",
      contentType: "markdown"
    } as never);
    render(<SelectionBubble editor={editor} onComment={() => undefined} onAssist={() => undefined} />);
    act(() => {
      editor.view.dom.focus();
      editor.commands.setTextSelection({ from: 10, to: 23 });
    });
    fireEvent.click(screen.getByRole("button", { name: "链接" }));
    const address = screen.getByRole("textbox", { name: "链接地址" });
    act(() => address.focus());
    // What a shared draft does whenever someone else types, or a cursor moves.
    act(() => editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false)));
    expect(screen.queryByRole("textbox", { name: "链接地址" })).not.toBeNull();
    fireEvent.change(address, { target: { value: "./returns.md" } });
    fireEvent.submit(address.closest("form")!);
    expect(editor.getHTML()).toContain('href="./returns.md"');
    editor.destroy();
  });
});
