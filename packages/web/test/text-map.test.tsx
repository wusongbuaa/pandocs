// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { anchorFromQuote, anchorFromRange, parseDocument, squashWhitespace, visibleText } from "@pandocs/markdown";
import { buildTextMap, captureSelection, rangeFor } from "../src/reader/text-map";
import { renderDocument } from "./support";

const DIR = join(import.meta.dirname, "../../markdown/test/fixtures/corpus");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as { file: string; title: string }[];
const pages = manifest.map(entry => [entry.title, readFileSync(join(DIR, entry.file), "utf8")] as const);
const elements = readFileSync(join(import.meta.dirname, "../parity/fixtures/elements.md"), "utf8");

const domText = (root: Element) => buildTextMap(root).segments.map(segment => segment.node.nodeValue ?? "").join("");

afterEach(cleanup);

describe("the official theme's page counts text the way the server does", () => {
  it.each(pages)("rendered text matches the server's visible text: %s", async (title, markdown) => {
    const { body } = await renderDocument(markdown, title);
    expect(squashWhitespace(domText(body))).toBe(squashWhitespace(visibleText(parseDocument(markdown))));
  });

  it("leaves out the row of actions under a title written in the text", async () => {
    const markdown = "# 测试文档\n\n正文内容\n\n第二段\n";
    const { body } = await renderDocument(markdown, "测试文档");
    expect(body.querySelector(".rp-llms-container")).not.toBeNull();
    expect(squashWhitespace(domText(body))).toBe(squashWhitespace(visibleText(parseDocument(markdown))));
  });

  it("holds for every official element, including titles and buttons the theme adds", async () => {
    const { body } = await renderDocument(elements);
    expect(squashWhitespace(domText(body))).toBe(squashWhitespace(visibleText(parseDocument(elements))));
  });

  it.each(pages)("a server anchor lands on the same words in the DOM: %s", async (title, markdown) => {
    const text = squashWhitespace(visibleText(parseDocument(markdown)));
    const middle = Math.floor(text.length / 2);
    const anchor = anchorFromRange(text, middle, middle + 8);
    const { body } = await renderDocument(markdown, title);
    const range = rangeFor(buildTextMap(body), body, anchor.start, anchor.end);
    expect(range).not.toBeNull();
    // A range across a heading also holds its anchor link, which the coordinates skip.
    const words = document.createElement("div");
    words.append(range!.cloneContents());
    expect(squashWhitespace(domText(words))).toBe(text.slice(middle, middle + 8));
  });

  it("captures a selection in the same coordinates, skipping the callout title the renderer supplies", async () => {
    const markdown = ":::callout{emoji=\"🎯\"}\n\n**重点**内容\n\n:::\n\n第二段文字\n";
    const { body } = await renderDocument(markdown);
    expect(body.querySelector(".rp-callout__title")?.textContent).toBe("说明");
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) && !node.nodeValue?.includes("第二段")) { /* find the paragraph */ }
    const range = document.createRange();
    range.setStart(node!, 0);
    range.setEnd(node!, 3);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const captured = captureSelection(body, selection);
    const expected = anchorFromQuote(squashWhitespace(visibleText(parseDocument(markdown))), "第二段");
    expect(captured).toMatchObject({ start: expected.start, end: expected.end, exact: "第二段" });
  });
});
