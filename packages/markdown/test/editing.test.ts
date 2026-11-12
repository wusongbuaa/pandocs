import { describe, expect, it } from "vitest";
import {
  applyEditOps,
  assetHash,
  createSlugger,
  EditOpError,
  editOpSchema,
  joinBlocks,
  joinFrontMatter,
  opsBetweenBlocks,
  splitFrontMatter,
  mergeThreeWay,
  outlineOf,
  parseDocument,
  readScoped,
  relativeDocHref,
  resolveDocLink,
  ScopeError,
  sourceBlocks,
  spliceBlocks,
  topLevelBlocks
} from "@pandocs/markdown";

const SOURCE = "---\ntitle: 示例\n---\n\n# 第一章\n\n段落一\n\n## 小节\n\n段落二\n\n# 第二章\n\n段落三\n";

describe("document structure", () => {
  it("numbers top-level blocks without counting front matter", () => {
    const blocks = topLevelBlocks(parseDocument(SOURCE));
    expect(blocks.map(block => `${block.ref}:${block.type}`)).toEqual([
      "b1:heading",
      "b2:paragraph",
      "b3:heading",
      "b4:paragraph",
      "b5:heading",
      "b6:paragraph"
    ]);
    expect(blocks[1]!.preview).toBe("段落一");
  });

  it("builds an outline with stable slugs", () => {
    const outline = outlineOf(parseDocument("# 标题\n\n# 标题\n\n## Hello, World!\n"));
    expect(outline.map(item => item.slug)).toEqual(["标题", "标题-1", "hello-world"]);
    const slug = createSlugger();
    expect(slug("！！！")).toBe("section");
  });

  it("reads the smallest scope that answers the question", () => {
    const document = parseDocument(SOURCE);
    expect(readScoped(document, { scope: "outline" }).blocks).toEqual([]);
    expect(readScoped(document, { scope: "section", section: "第一章" }).blocks.map(block => block.ref)).toEqual([
      "b1",
      "b2",
      "b3",
      "b4"
    ]);
    expect(readScoped(document, { scope: "section", section: "小节" }).blocks.map(block => block.ref)).toEqual([
      "b3",
      "b4"
    ]);
    expect(readScoped(document, { scope: "section", section: "第二章" }).blocks.map(block => block.markdown)).toEqual([
      "# 第二章",
      "段落三"
    ]);
    expect(readScoped(document, { scope: "range", start: "b2", end: "b3" }).blocks.map(block => block.ref)).toEqual([
      "b2",
      "b3"
    ]);
    expect(
      readScoped(document, { scope: "keyword", keyword: "段落二", context: 1 }).blocks.map(block => block.ref)
    ).toEqual(["b3", "b4", "b5"]);
    expect(() => readScoped(document, { scope: "section", section: "没有" })).toThrow(ScopeError);
    expect(() => readScoped(document, { scope: "range", start: "b3", end: "b2" })).toThrow(ScopeError);
  });
});

describe("edit operations", () => {
  const apply = (...ops: Parameters<typeof applyEditOps>[1]) => applyEditOps(SOURCE, ops);

  it("replaces text only when the target is unambiguous", () => {
    expect(apply({ op: "str_replace", pattern: "段落一", content: "新内容" })).toContain("新内容");
    expect(() => apply({ op: "str_replace", pattern: "段落", content: "x" })).toThrow(/3 times/u);
    expect(apply({ op: "str_replace", pattern: "段落", content: "节", all: true })).toContain("节三");
    expect(() => apply({ op: "str_replace", pattern: "不存在", content: "x" })).toThrow(EditOpError);
  });

  it("replaces, inserts, deletes and moves blocks without touching the rest", () => {
    expect(apply({ op: "block_replace", ref: "b2", content: "替换" })).toBe(
      "---\ntitle: 示例\n---\n\n# 第一章\n\n替换\n\n## 小节\n\n段落二\n\n# 第二章\n\n段落三\n"
    );
    expect(apply({ op: "block_replace", ref: "b3", end: "b4", content: "合并" })).toBe(
      "---\ntitle: 示例\n---\n\n# 第一章\n\n段落一\n\n合并\n\n# 第二章\n\n段落三\n"
    );
    expect(apply({ op: "block_insert_after", ref: "b2", content: "新增" })).toContain("段落一\n\n新增\n\n## 小节");
    expect(apply({ op: "block_insert_after", ref: "start", content: "开头" })).toContain("---\n\n开头\n\n# 第一章");
    expect(apply({ op: "block_insert_after", ref: "end", content: "结尾" })).toMatch(/段落三\n\n结尾\n$/u);
    expect(apply({ op: "block_delete", ref: "b2" })).toBe(
      "---\ntitle: 示例\n---\n\n# 第一章\n\n## 小节\n\n段落二\n\n# 第二章\n\n段落三\n"
    );
    expect(apply({ op: "block_delete", ref: "b5", end: "b6" })).toBe(
      "---\ntitle: 示例\n---\n\n# 第一章\n\n段落一\n\n## 小节\n\n段落二\n"
    );
    expect(apply({ op: "block_move_after", ref: "b6", after: "b1" })).toBe(
      "---\ntitle: 示例\n---\n\n# 第一章\n\n段落三\n\n段落一\n\n## 小节\n\n段落二\n\n# 第二章\n"
    );
  });

  it("resolves every ref against the same base, in any order", () => {
    const result = apply({ op: "block_delete", ref: "b6" }, { op: "block_replace", ref: "b2", content: "改" });
    expect(result).toBe("---\ntitle: 示例\n---\n\n# 第一章\n\n改\n\n## 小节\n\n段落二\n\n# 第二章\n");
  });

  it("rejects stale refs and overlapping edits", () => {
    expect(() => apply({ op: "block_delete", ref: "b99" })).toThrow(/b99/u);
    expect(() =>
      apply({ op: "block_replace", ref: "b2", content: "a" }, { op: "str_replace", pattern: "段落一", content: "b" })
    ).toThrow(/same content/u);
    expect(() => apply({ op: "block_move_after", ref: "b2", after: "b2" })).toThrow(EditOpError);
  });

  it("validates the wire format", () => {
    expect(editOpSchema.safeParse({ op: "block_delete", ref: "x" }).success).toBe(false);
    expect(editOpSchema.safeParse({ op: "block_delete", ref: "b1", extra: 1 }).success).toBe(false);
    expect(editOpSchema.safeParse({ op: "block_insert_after", ref: "end", content: "x" }).success).toBe(true);
  });
});

describe("block-level write back", () => {
  it("keeps original bytes for blocks the editor did not change", () => {
    const source = ["| a  |  b |\n|---|---|\n| 1 | 2 |", "第一段", "第二段"];
    const baseline = ["| a | b |\n| --- | --- |\n| 1 | 2 |", "第一段", "第二段"];
    expect(spliceBlocks(source, baseline, baseline)).toEqual(source);
    expect(spliceBlocks(source, baseline, [baseline[0]!, "改过", baseline[2]!])).toEqual([
      source[0],
      "改过",
      source[2]
    ]);
    expect(spliceBlocks(source, baseline, [baseline[0]!, "第一段", "新增", "第二段"])).toEqual([
      source[0],
      source[1],
      "新增",
      source[2]
    ]);
    expect(spliceBlocks(source, baseline, [baseline[1]!])).toEqual([source[1]]);
  });
});

describe("three-way merge", () => {
  const base = joinBlocks(["一", "二", "三", "四"]);

  it("merges changes to different blocks", () => {
    const ours = joinBlocks(["一改", "二", "三", "四"]);
    const theirs = joinBlocks(["一", "二", "三", "四改"]);
    expect(mergeThreeWay(base, ours, theirs)).toEqual({ ok: true, markdown: joinBlocks(["一改", "二", "三", "四改"]) });
  });

  it("merges insertions and deletions", () => {
    const ours = joinBlocks(["一", "新", "二", "三", "四"]);
    const theirs = joinBlocks(["一", "二", "四"]);
    expect(mergeThreeWay(base, ours, theirs)).toEqual({ ok: true, markdown: joinBlocks(["一", "新", "二", "四"]) });
  });

  it("reports the same block changed twice as a conflict", () => {
    const result = mergeThreeWay(base, joinBlocks(["一", "二甲", "三", "四"]), joinBlocks(["一", "二乙", "三", "四"]));
    expect(result).toEqual({
      ok: false,
      conflicts: [{ base: ["二"], ours: ["二甲"], theirs: ["二乙"] }],
      keepingOurs: joinBlocks(["一", "二甲", "三", "四"])
    });
  });

  it("short-circuits when one side did nothing or both agree", () => {
    const edited = joinBlocks(["一", "改", "三", "四"]);
    expect(mergeThreeWay(base, edited, base)).toEqual({ ok: true, markdown: edited });
    expect(mergeThreeWay(base, base, edited)).toEqual({ ok: true, markdown: edited });
    expect(mergeThreeWay(base, edited, edited)).toEqual({ ok: true, markdown: edited });
  });

  it("keeps a whole directive as one block", () => {
    expect(sourceBlocks(":::note\n\n甲\n\n乙\n\n:::\n\n丙\n")).toEqual([":::note\n\n甲\n\n乙\n\n:::", "丙"]);
  });
});

describe("front matter and block edit scripts", () => {
  it("keeps front matter byte for byte", () => {
    const { frontMatter, body } = splitFrontMatter("---\ntitle: 甲\n# 注释\n---\n\n正文\n");
    expect(frontMatter).toBe("---\ntitle: 甲\n# 注释\n---\n");
    expect(body).toBe("正文\n");
    expect(joinFrontMatter(frontMatter, body)).toBe("---\ntitle: 甲\n# 注释\n---\n\n正文\n");
    expect(splitFrontMatter("---\n\n分隔线后的正文\n")).toEqual({ frontMatter: "", body: "---\n\n分隔线后的正文\n" });
  });

  it("turns two block lists into ops that reproduce the target", () => {
    const base = ["# 甲", "乙", "丙", "丁"];
    const cases = [
      ["# 甲", "乙改", "丙", "丁"],
      ["新开头", "# 甲", "乙", "丙", "丁"],
      ["# 甲", "乙", "丙", "丁", "新结尾"],
      ["# 甲", "丁"],
      ["完全不同"],
      ["# 甲", "插入", "乙", "丙改", "丁"]
    ];
    for (const target of cases) {
      const ops = opsBetweenBlocks(base, target);
      expect(applyEditOps(joinBlocks(base), ops as never)).toBe(joinBlocks(target));
    }
    expect(opsBetweenBlocks(base, base)).toEqual([]);
    expect(opsBetweenBlocks(base, ["# 甲", "乙改", "丙", "丁"])).toEqual([
      { op: "block_replace", ref: "b2", content: "乙改" }
    ]);
  });
});

describe("links and assets", () => {
  it("resolves relative document links", () => {
    expect(resolveDocLink("入门/认识", "./登录.md")).toEqual({ path: "入门/登录" });
    expect(resolveDocLink("入门/认识", "../日常/任务.md#步骤")).toEqual({ path: "日常/任务", hash: "步骤" });
    expect(resolveDocLink("首页", "./入门/认识.md")).toEqual({ path: "入门/认识" });
    expect(resolveDocLink("a/b", "/c/d.md")).toEqual({ path: "c/d" });
    expect(resolveDocLink("a/b", "%E7%99%BB%E5%BD%95.md")).toEqual({ path: "a/登录" });
  });

  it("leaves everything else alone", () => {
    expect(resolveDocLink("a", "https://example.test/x.md")).toBeNull();
    expect(resolveDocLink("a", "#section")).toBeNull();
    expect(resolveDocLink("a", "./image.png")).toBeNull();
    expect(resolveDocLink("a", "../../x.md")).toBeNull();
  });

  it("computes the reverse", () => {
    expect(relativeDocHref("入门/认识", "入门/登录")).toBe("./登录.md");
    expect(relativeDocHref("入门/认识", "日常/任务")).toBe("../日常/任务.md");
    expect(relativeDocHref("首页", "入门/认识")).toBe("./入门/认识.md");
    const round = relativeDocHref("a/b/c", "a/d");
    expect(resolveDocLink("a/b/c", round)).toEqual({ path: "a/d" });
  });

  it("recognises space-level assets", () => {
    const sha = "a".repeat(64);
    expect(assetHash(`assets/${sha}.png`)).toBe(sha);
    expect(assetHash(`assets/${sha}`)).toBe(sha);
    expect(assetHash("assets/short.png")).toBeNull();
    expect(assetHash("https://example.test/a.png")).toBeNull();
  });
});

describe("merging edits to neighbouring blocks", () => {
  const blocks = (...items: string[]) => `${items.join("\n\n")}\n`;
  const base = blocks("甲", "乙", "丙", "丁");

  it("keeps both edits when they touch adjacent blocks", () => {
    expect(mergeThreeWay(base, blocks("甲改", "乙", "丙", "丁"), blocks("甲", "乙改", "丙", "丁"))).toEqual({
      ok: true,
      markdown: blocks("甲改", "乙改", "丙", "丁")
    });
  });

  it("keeps an edit next to an inserted block", () => {
    expect(mergeThreeWay(base, blocks("甲改", "乙", "丙", "丁"), blocks("甲", "乙改", "新块", "丙", "丁"))).toEqual({
      ok: true,
      markdown: blocks("甲改", "乙改", "新块", "丙", "丁")
    });
  });

  it("still conflicts when both change the same block differently, and reports only that block", () => {
    const result = mergeThreeWay(base, blocks("甲", "乙一", "丙改", "丁"), blocks("甲改", "乙二", "丙", "丁"));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.conflicts).toEqual([{ base: ["乙"], ours: ["乙一"], theirs: ["乙二"] }]);
  });

  it("takes one copy when both made the same change", () => {
    expect(mergeThreeWay(base, blocks("甲", "乙改", "丙", "丁"), blocks("甲", "乙改", "丙", "丁", "尾"))).toEqual({
      ok: true,
      markdown: blocks("甲", "乙改", "丙", "丁", "尾")
    });
  });

  it("does not choose an order for two different insertions at one spot", () => {
    expect(mergeThreeWay(base, blocks("甲", "我的", "乙", "丙", "丁"), blocks("甲", "他的", "乙", "丙", "丁")).ok).toBe(
      false
    );
  });

  it("keeps one side's deletion and the other's edit elsewhere", () => {
    expect(mergeThreeWay(base, blocks("甲", "丙", "丁"), blocks("甲", "乙", "丙改", "丁"))).toEqual({
      ok: true,
      markdown: blocks("甲", "丙改", "丁")
    });
  });

  it("keeps an edit to a block the other side put something new before, whichever side made it", () => {
    const merged = { ok: true, markdown: blocks("甲", "新块", "乙改", "丙", "丁") };
    expect(mergeThreeWay(base, blocks("甲", "乙改", "丙", "丁"), blocks("甲", "新块", "乙", "丙", "丁"))).toEqual(
      merged
    );
    expect(mergeThreeWay(base, blocks("甲", "新块", "乙", "丙", "丁"), blocks("甲", "乙改", "丙", "丁"))).toEqual(
      merged
    );
  });

  it("does not bring back a block one side deleted and the other put something new before", () => {
    const merged = { ok: true, markdown: blocks("甲", "新块", "丙", "丁") };
    expect(mergeThreeWay(base, blocks("甲", "丙", "丁"), blocks("甲", "新块", "乙", "丙", "丁"))).toEqual(merged);
    expect(mergeThreeWay(base, blocks("甲", "新块", "乙", "丙", "丁"), blocks("甲", "丙", "丁"))).toEqual(merged);
  });
});

describe("what a merge writes between blocks", () => {
  // A heading with its paragraph right under it, a list straight after a paragraph, and no newline at the end.
  const base = "# 甲\n乙\n- 一\n- 二\n\n\n丙\n\n丁";

  it("is what each version had, so only the edited blocks change", () => {
    const ours = "# 甲\n乙\n- 一\n- 二\n\n\n丙\n\n丁改";
    const theirs = "# 甲改\n乙\n- 一\n- 二\n\n\n丙\n\n丁";
    expect(mergeThreeWay(base, ours, theirs)).toEqual({ ok: true, markdown: "# 甲改\n乙\n- 一\n- 二\n\n\n丙\n\n丁改" });
  });

  it("is what the version that put a block there had around it", () => {
    const ours = "# 甲\n乙\n- 一\n- 二\n\n\n丙\n\n丁改";
    const theirs = "# 甲\n乙\n- 一\n- 二\n\n新\n\n\n丙\n\n丁";
    expect(mergeThreeWay(base, ours, theirs)).toEqual({
      ok: true,
      markdown: "# 甲\n乙\n- 一\n- 二\n\n新\n\n\n丙\n\n丁改"
    });
  });
});

describe("merging any two sets of edits", () => {
  // Every block has its own text, so where each one ends up says what the merge did with it.
  type Change = "keep" | "delete" | "replace";
  const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const edit = (next: () => number, size: number, side: string) => {
    const changes: Change[] = Array.from({ length: size }, () => {
      const roll = next();
      return roll < 0.6 ? "keep" : roll < 0.8 ? "delete" : "replace";
    });
    const inserted = Array.from({ length: size + 1 }, () => next() < 0.25);
    const result: string[] = [];
    for (let at = 0; at <= size; at += 1) {
      if (inserted[at]) result.push(`${side}${at}`);
      if (at < size && changes[at] === "keep") result.push(`b${at}`);
      if (at < size && changes[at] === "replace") result.push(`b${at}${side}`);
    }
    return { changes, inserted, result };
  };

  it("never loses, repeats or brings back a block when it says it merged", () => {
    const next = random(20_261_109);
    let merged = 0;
    for (let round = 0; round < 3000; round += 1) {
      const size = 1 + Math.floor(next() * 7);
      const base = Array.from({ length: size }, (_, at) => `b${at}`);
      const ours = edit(next, size, "o");
      const theirs = edit(next, size, "t");
      const result = mergeThreeWay(joinBlocks(base), joinBlocks(ours.result), joinBlocks(theirs.result));
      const bothReplaced = base.some((_, at) => ours.changes[at] === "replace" && theirs.changes[at] === "replace");
      if (bothReplaced) expect(result.ok).toBe(false);
      if (!result.ok) continue;
      merged += 1;
      const out = sourceBlocks(result.markdown);
      const count = (block: string) => out.filter(item => item === block).length;
      for (const side of [ours, theirs]) {
        for (const block of side.result.filter(item => !/^b\d+$/u.test(item)))
          expect(count(block), `${block} in ${out.join(" ")}`).toBe(1);
      }
      for (const [at, block] of base.entries()) {
        const kept = ours.changes[at] === "keep" && theirs.changes[at] === "keep";
        expect(
          count(block),
          `${block} in ${out.join(" ")}, from ${ours.result.join(" ")} and ${theirs.result.join(" ")}`
        ).toBe(kept ? 1 : 0);
      }
      const order = out.filter(item => /^b\d+$/u.test(item)).map(item => Number(item.slice(1)));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
    // Most rounds should merge, or this would say little.
    expect(merged).toBeGreaterThan(1000);
  });
});

describe("a page with very many short lists", () => {
  it("takes time in proportion to its length", () => {
    // Without the patch to the parser's edit list, each list that ends copies everything before it: this took 39 seconds.
    const markdown = "- 一项\n\n一段\n\n".repeat(40_000);
    const started = performance.now();
    expect(parseDocument(markdown).tree.children).toHaveLength(80_000);
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 60_000);
});
