import { describe, expect, it } from "vitest";
import { blocksInTextRange, parseDocument, squashWhitespace, visibleText } from "../src/index.js";

const MARKDOWN = "---\ntitle: 示例\n---\n\n# 标题\n\n第一段 **说明**。\n\n![图](assets/a.png)\n\n第二段说明。\n\n- 甲\n- 乙\n";

function rangeOf(words: string): [number, number] {
  const text = squashWhitespace(visibleText(parseDocument(MARKDOWN)));
  const start = text.indexOf(squashWhitespace(words));
  expect(start).toBeGreaterThanOrEqual(0);
  return [start, start + squashWhitespace(words).length];
}

describe("blocksInTextRange", () => {
  const blocks = (words: string) => blocksInTextRange(parseDocument(MARKDOWN), ...rangeOf(words));

  it("finds the block words sit in, past front matter and blocks with no text", () => {
    expect(blocks("第一段说明")).toEqual({ first: "b2", last: "b2" });
    expect(blocks("第二段")).toEqual({ first: "b4", last: "b4" });
    expect(blocks("乙")).toEqual({ first: "b5", last: "b5" });
  });

  it("spans every block a selection crosses", () => {
    expect(blocks("标题第一段")).toEqual({ first: "b1", last: "b2" });
    expect(blocks("说明。第二段说明。甲")).toEqual({ first: "b2", last: "b5" });
  });

  it("finds nothing outside the text", () => {
    expect(blocksInTextRange(parseDocument(MARKDOWN), 1000, 1001)).toBeNull();
  });
});
