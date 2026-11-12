import { describe, expect, it } from "vitest";
import { analyzeDocument, MOST_TREE_DEPTH, nestsTooDeeply, parseDocument, topLevelBlocks, treeDepth, visibleText } from "../src/index.js";

const repeat = (count: number, make: (at: number) => string) => Array.from({ length: count }, (_, at) => make(at)).join("");

describe("a page nested too deeply", () => {
  const deep: Record<string, string> = {
    "quotes on one line": `${"> ".repeat(5000)}x\n`,
    "lists on one line": `${"- ".repeat(5000)}x\n`,
    "lists indented level by level": repeat(1400, at => `${"  ".repeat(at)}- a\n`),
    "a list indented inside a quote": repeat(300, at => `> ${"  ".repeat(at)}- a\n`),
    "containers inside containers": `${":::note\n".repeat(4000)}x\n${":::\n".repeat(4000)}`,
    "emphasis inside emphasis": `${repeat(3000, at => `${at % 2 ? "_" : "*"}a `)}x${repeat(3000, at => ` a${(2999 - at) % 2 ? "_" : "*"}`)}\n`,
    "strikethrough inside strikethrough": `${"~~a ".repeat(3000)}x${" a~~".repeat(3000)}\n`,
    "one long run of stars on each side": `${"*".repeat(3000)}x${"*".repeat(3000)}\n`
  };

  for (const [kind, markdown] of Object.entries(deep)) {
    it(`reads as its source, at once, with ${kind}`, () => {
      const started = performance.now();
      const parsed = parseDocument(markdown);
      expect(parsed.diagnostics.map(item => item.code)).toEqual(["DOCUMENT_TOO_DEEP"]);
      expect(topLevelBlocks(parsed)).toHaveLength(1);
      expect(visibleText(parsed).trim()).toBe(markdown.trim());
      expect(analyzeDocument(markdown).diagnostics[0]!.severity).toBe("error");
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }
});

describe("nesting people write", () => {
  it("parses as usual", () => {
    const markdown = [
      repeat(12, at => `${"  ".repeat(at)}- level ${at + 1}\n`),
      "> > > > a quote in quotes\n",
      ":::steps\n:::tabs\n:::callout\n***strong and emphasis*** and ~~*struck emphasis*~~\n:::\n:::\n:::\n"
    ].join("\n");
    expect(nestsTooDeeply(markdown)).toBe(false);
    expect(parseDocument(markdown).diagnostics).toEqual([]);
  });

  it("does not count stars that never pair, such as pointers in code", () => {
    const code = `\`\`\`c\n${"int *a = *b + *c;\n".repeat(500)}char* p;\n\`\`\`\n`;
    expect(nestsTooDeeply(code)).toBe(false);
  });

  it("does not count containers that were closed again, however many there are", () => {
    expect(nestsTooDeeply(":::note\nx\n:::\n\n".repeat(1000))).toBe(false);
    expect(nestsTooDeeply(":::note\r\nx\r\n:::\r\n\r\n".repeat(1000))).toBe(false);
  });

  it("measures a tree without recursion", () => {
    let node: { type: string; children: unknown[] } = { type: "text", children: [] };
    for (let depth = 0; depth < 100_000; depth += 1) node = { type: "blockquote", children: [node] };
    expect(treeDepth(node as never)).toBe(100_000);
    expect(MOST_TREE_DEPTH).toBeLessThan(1000);
  });
});
