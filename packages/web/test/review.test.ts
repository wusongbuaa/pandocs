import { describe, expect, it } from "vitest";
import type { Root } from "hast";
import { collapseUnchanged, diffBlocks, markRanges, textOfHast, wordChanges } from "../src/review/diff-blocks";

describe("diffBlocks", () => {
  it("pairs a block removed right before one was added as a rewrite", () => {
    expect(diffBlocks(["一", "二", "三"], ["一", "二改", "三"])).toEqual([
      { kind: "same", text: "一" },
      { kind: "changed", before: "二", after: "二改" },
      { kind: "same", text: "三" }
    ]);
  });

  it("keeps blocks that only moved position as additions and removals around what stayed", () => {
    expect(diffBlocks(["一", "二"], ["零", "一", "二", "三"])).toEqual([
      { kind: "added", text: "零" },
      { kind: "same", text: "一" },
      { kind: "same", text: "二" },
      { kind: "added", text: "三" }
    ]);
    expect(diffBlocks(["一", "二"], [])).toEqual([{ kind: "removed", text: "一" }, { kind: "removed", text: "二" }]);
  });
});

describe("collapseUnchanged", () => {
  it("folds long untouched runs and keeps a block of context on each side", () => {
    const rows = diffBlocks(["1", "2", "3", "4", "5", "6"], ["1", "2", "3改", "4", "5", "6"]);
    expect(collapseUnchanged(rows).map(row => row.kind)).toEqual(["collapsed", "same", "changed", "same", "collapsed"]);
    expect(collapseUnchanged(rows)[0]).toEqual({ kind: "collapsed", count: 1 });
  });

  it("shows nothing but a fold when nothing changed", () => {
    expect(collapseUnchanged(diffBlocks(["1", "2"], ["1", "2"]))).toEqual([{ kind: "collapsed", count: 2 }]);
  });
});

describe("wordChanges", () => {
  it("marks only what changed when most of the block survived", () => {
    expect(wordChanges("周末要找人值班", "周末要等人值班")).toEqual({ removed: [[3, 4]], added: [[3, 4]] });
  });

  it("gives up on a block that was rewritten", () => {
    expect(wordChanges("完全不同的一段话", "another thing entirely")).toBeNull();
  });
});

describe("markRanges", () => {
  const paragraph = (): Root => ({
    type: "root",
    children: [{
      type: "element", tagName: "p", properties: {},
      children: [{ type: "text", value: "过去" }, { type: "element", tagName: "strong", properties: {}, children: [{ type: "text", value: "要找" }] }, { type: "text", value: "排期" }]
    }]
  });

  it("wraps a range that spans several text nodes without changing the text", () => {
    const tree = paragraph();
    markRanges(tree, [[1, 3]], "pd-mark");
    expect(textOfHast(tree)).toBe("过去要找排期");
    const marks: string[] = [];
    const walk = (node: Root | Root["children"][number]) => {
      if (node.type === "element" && node.tagName === "mark") marks.push(textOfHast(node));
      if ("children" in node) (node.children as Root["children"]).forEach(walk);
    };
    walk(tree);
    expect(marks).toEqual(["去", "要"]);
  });

  it("leaves the heading's own anchor out of the count", () => {
    const tree: Root = {
      type: "root",
      children: [{
        type: "element", tagName: "h2", properties: {},
        children: [{ type: "text", value: "标题" }, { type: "element", tagName: "a", properties: { className: ["rp-header-anchor"] }, children: [{ type: "text", value: "#" }] }, { type: "text", value: "后" }]
      }]
    };
    markRanges(tree, [[2, 3]], "pd-mark");
    expect(JSON.stringify(tree)).toContain('"tagName":"mark","properties":{"className":["pd-mark"]},"children":[{"type":"text","value":"后"}]');
  });
});
