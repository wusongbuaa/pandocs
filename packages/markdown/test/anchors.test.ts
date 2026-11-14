import { describe, expect, it } from "vitest";
import {
  anchorFromBlock,
  anchorFromQuote,
  anchorFromRange,
  AnchorError,
  relocateBlockAnchor,
  relocateTextAnchor,
  squashWhitespace
} from "@pandocs/markdown";

const DOCUMENT = squashWhitespace(
  "菜园按地块分给各户，领到地块以后才能用工具棚和水井。浇水系统会按你登记的地块号定时放水，所以每户在自己的每块地上都要单独登记一次。" +
    "检查一遍：水管接头没有滴水，阀门把手朝下，登记表上写了你的名字。地块牌和登记表的号码要一致，牌子丢了去工具棚找管理员补一块新的。" +
    "检查一遍：棚门锁好，钥匙挂回门后的钩子上，铁锹和水桶都放回原处。夜里下过雨的话，第二天早上就不用再去浇水了。"
);
const QUOTE = "浇水系统会按你登记的地块号定时放水";

describe("text anchors", () => {
  it("creates anchors from a browser range or a quote", () => {
    const start = DOCUMENT.indexOf(QUOTE);
    const fromRange = anchorFromRange(DOCUMENT, start, start + QUOTE.length);
    expect(fromRange.exact).toBe(QUOTE);
    expect(fromRange.prefix.endsWith("工具棚和水井。")).toBe(true);
    expect(anchorFromQuote(DOCUMENT, `浇水系统会按 你登记的\n地块号定时放水`).start).toBe(start);
  });

  it("refuses to guess between repeated phrases", () => {
    expect(() => anchorFromQuote(DOCUMENT, "检查一遍")).toThrow(/2 times/u);
    expect(anchorFromQuote(DOCUMENT, "检查一遍", 2).start).toBe(DOCUMENT.lastIndexOf("检查一遍"));
    expect(() => anchorFromQuote(DOCUMENT, "检查一遍", 3)).toThrow(AnchorError);
    expect(() => anchorFromQuote(DOCUMENT, "不存在的内容")).toThrow(AnchorError);
    expect(() => anchorFromRange(DOCUMENT, 5, 5)).toThrow(AnchorError);
    expect(() => anchorFromRange(DOCUMENT, 0, DOCUMENT.length + 1)).toThrow(AnchorError);
  });

  const anchor = anchorFromRange(DOCUMENT, DOCUMENT.indexOf(QUOTE), DOCUMENT.indexOf(QUOTE) + QUOTE.length);

  it("stays exact when text moves around it", () => {
    const moved = relocateTextAnchor(anchor, `这是新插入的一段说明文字。${DOCUMENT}`);
    expect(moved.state).toBe("exact");
    expect(moved.anchor.start).toBe(anchor.start + "这是新插入的一段说明文字。".length);
  });

  it("follows light edits and says so", () => {
    const edited = DOCUMENT.replace("会按你登记", "会照你登记");
    const moved = relocateTextAnchor(anchor, edited);
    expect(moved.state).toBe("fuzzy");
    expect(moved.anchor.start).toBe(anchor.start);
    expect(moved.anchor.exact).toBe(QUOTE);
  });

  it("orphans an anchor whose text is gone, keeping the quote", () => {
    const moved = relocateTextAnchor(anchor, DOCUMENT.replace(QUOTE, ""));
    expect(moved.state).toBe("orphaned");
    expect(moved.anchor.exact).toBe(QUOTE);
  });

  it("does not latch onto a similar sentence elsewhere", () => {
    const first = DOCUMENT.indexOf("检查一遍：水管");
    const sentence = "检查一遍：水管接头没有滴水";
    const repeated = anchorFromRange(DOCUMENT, first, first + sentence.length);
    const without = DOCUMENT.replace(sentence, "");
    expect(relocateTextAnchor(repeated, without).state).toBe("orphaned");
  });

  it("does not take the copy left of a repeated sentence for the one that was rewritten", () => {
    const rules = squashWhitespace(
      "客服规则个人客户请在签收后七天内申请退货。个人订单由客服核对签收记录。企业客户请在签收后七天内申请退货。企业订单由客户经理核对合同条款。"
    );
    const sentence = "请在签收后七天内申请退货。";
    const second = rules.lastIndexOf(sentence);
    const enterprise = anchorFromRange(rules, second, second + sentence.length);
    const rewritten =
      rules.slice(0, second) + "企业订单的退货时限以双方签订的合同约定为准。" + rules.slice(second + sentence.length);
    expect(relocateTextAnchor(enterprise, rewritten).state).toBe("orphaned");
    // The other copy going away leaves this one where it was, and as it was.
    const first = rules.indexOf(sentence);
    const kept = relocateTextAnchor(enterprise, rules.slice(0, first) + rules.slice(first + sentence.length));
    expect([kept.state, kept.anchor.exact]).toEqual(["exact", sentence]);
  });

  it("keeps a sentence found once where it was, whatever happened around it", () => {
    const rewritten = DOCUMENT.replace("领到地块以后才能用工具棚和水井。", "全部换了。").replace(
      "所以每户在自己的每块地上都要单独登记一次。",
      "也全部换了。"
    );
    expect(relocateTextAnchor(anchor, rewritten).state).toBe("exact");
  });

  it("never cuts a character in two at the edge of what it keeps around the quote", () => {
    const text = `📦${"a".repeat(31)}请核对签收凭证后再完成交接。${"b".repeat(31)}🚚`;
    const start = text.indexOf("请核对");
    const made = anchorFromRange(text, start, start + "请核对签收凭证后再完成交接。".length);
    expect(JSON.parse(JSON.stringify(made.prefix)).startsWith("📦")).toBe(true);
    expect(made.suffix.endsWith("🚚")).toBe(true);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(made.prefix + made.suffix)
    ).toBe(false);
  });

  it("refuses to choose between identical copies with no context", () => {
    const copy = anchorFromRange("甲甲甲", 1, 2);
    expect(relocateTextAnchor({ ...copy, prefix: "", suffix: "" }, "甲乙甲").state).toBe("orphaned");
  });
});

describe("block anchors", () => {
  const blocks = [
    { ref: "b1", type: "heading", markdown: "# 标题", preview: "标题" },
    { ref: "b2", type: "mermaid", markdown: "```mermaid\nA\n```", preview: "" },
    { ref: "b3", type: "paragraph", markdown: "段落", preview: "段落" }
  ];
  const anchor = anchorFromBlock(blocks[1]!);

  it("follows the block when it moves", () => {
    const moved = relocateBlockAnchor(anchor, [blocks[0]!, blocks[2]!, { ...blocks[1]!, ref: "b3" }]);
    expect(moved.state).toBe("exact");
    expect(moved.anchor.ref).toBe("b3");
  });

  it("stays in place when the block changes, and says so", () => {
    const moved = relocateBlockAnchor(anchor, [
      blocks[0]!,
      { ...blocks[1]!, markdown: "```mermaid\nB\n```" },
      blocks[2]!
    ]);
    expect(moved.state).toBe("fuzzy");
    expect(moved.anchor.ref).toBe("b2");
  });

  it("orphans the anchor when the block is gone", () => {
    expect(relocateBlockAnchor(anchor, [blocks[0]!, blocks[2]!]).state).toBe("orphaned");
  });
});
