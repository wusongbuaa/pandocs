import { describe, expect, it } from "vitest";
import { defaultBlockRegistry, parseDocument, squashWhitespace, visibleText } from "../src/index.js";

const text = (markdown: string) => visibleText(parseDocument(markdown)).trim();

describe("superscript and subscript", () => {
  it("leave the markers out of the text everyone counts", () => {
    expect(text("水是 H~2~O，面积 10^2^ 平方米")).toBe("水是 H2O，面积 102 平方米");
  });

  it.each([
    ["1~3 天，5~7 天"],
    ["1~3天，5~7天"],
    ["北京~上海~广州"],
    ["10~20~30"],
    ["a^b c^d"],
    ["~~删掉~~"]
  ])("do not touch text that only looks like them: %s", source => {
    const paragraph = parseDocument(source).tree.children[0] as { children: { type: string }[] };
    expect(paragraph.children.map(child => child.type)).not.toContain("subscript");
    expect(paragraph.children.map(child => child.type)).not.toContain("superscript");
  });

  it("leave code alone", () => {
    expect(text("`x^2^` 不变")).toBe("x^2^ 不变");
  });

  it("leave markers written as text alone, as the editor does", () => {
    expect(text(String.raw`\^note\^ 与 H\~2\~O`)).toBe("^note^ 与 H~2~O");
    expect(text("&#94;note&#94; 与 H&#126;2&#126;O")).toBe("^note^ 与 H~2~O");
    expect(text(String.raw`\^a^b^ 和 **粗** H~2~O`)).toBe("^ab 和 粗 H2O");
    expect(text("一行\n  &#x1F600;x^2^")).toBe("一行\n😀x2");
  });
});

describe("demonstration blocks", () => {
  const namesIn = (markdown: string) => parseDocument(markdown).blocks.map(block => `${block.kind}:${block.name}`);
  const problems = (markdown: string) => parseDocument(markdown).diagnostics.map(item => item.code);

  it("read as what they are, with nothing to complain about", () => {
    for (const block of defaultBlockRegistry.list()) {
      if (["compare", "hotspots"].includes(block.name)) continue;
      expect(problems(block.example), block.name).toEqual([]);
    }
    expect(namesIn(":::steps\n\n### 一\n\n内容\n\n:::\n")).toEqual(["container:steps"]);
    expect(namesIn("::::tabs\n\n:::tab[甲]\n\n内容\n\n:::\n\n::::\n")).toEqual(["container:tabs", "container:tab"]);
    expect(namesIn('::::cards\n\n:::card[甲]{href="./a.md"}\n\n内容\n\n:::\n\n::::\n')).toEqual(["container:cards", "container:card"]);
    expect(namesIn('::compare{before="assets/a.png" after="assets/b.png"}\n')).toEqual(["leaf:compare"]);
    expect(namesIn('```prompt title="标题"\n内容\n```\n')).toEqual(["fence:prompt"]);
    expect(namesIn('```hotspots src="assets/a.png"\n[]\n```\n')).toEqual(["fence:hotspots"]);
    expect(namesIn("```mindmap\n- 甲\n```\n")).toEqual(["fence:mindmap"]);
  });

  it("leave a tab's label out of the counted text, because it shows away from where it is written", () => {
    expect(text("::::tabs\n\n:::tab[甲]\n\n甲的内容\n\n:::\n\n:::tab[乙]\n\n乙的内容\n\n:::\n\n::::\n").replace(/\s+/gu, "")).toBe("甲的内容乙的内容");
  });

  it("count what a card and a prompt show, in the order they show it", () => {
    expect(text(':::card[甲]{href="./a.md"}\n\n说明\n\n:::\n').replace(/\s+/gu, "")).toBe("甲说明");
    expect(text('```prompt title="标题"\n帮我修 **这个**\n```\n')).toBe("帮我修 **这个**");
    expect(text('```hotspots src="assets/a.png"\n[{"x":1,"y":2,"title":"入口"}]\n```\n')).toBe("");
    expect(text('::compare[说明]{before="assets/a.png" after="assets/b.png"}\n')).toBe("");
    expect(text("```mindmap\n- 甲\n```\n")).toBe("");
  });

  it("say so when a required part is missing or a mark is off the picture", () => {
    expect(problems("::compare\n")).toContain("BLOCK_ATTR_INVALID");
    expect(problems("```hotspots\n[]\n```\n")).toContain("BLOCK_ATTR_INVALID");
    expect(problems('```hotspots src="assets/a.png"\n[{"x":120,"y":2,"title":"入口"}]\n```\n')).toContain("BLOCK_BODY_INVALID");
    expect(problems('```hotspots src="assets/a.png"\n不是 JSON\n```\n')).toContain("BLOCK_BODY_INVALID");
  });
});

describe("strikethrough", () => {
  it("still works, including around Chinese punctuation, and a single tilde is not it", () => {
    expect(text("~~**删掉。**~~后面")).toBe("删掉。后面");
    const paragraph = parseDocument("~不是删除线 的文字~").tree.children[0] as { children: { type: string }[] };
    expect(paragraph.children.map(child => child.type)).toEqual(["text"]);
  });
});

describe("formulas", () => {
  it("take $$, so prices stay text", () => {
    expect(text("费用 $100，税 $20")).toBe("费用 $100，税 $20");
    expect(text("质能方程 $$E=mc^2$$ 很有名")).toBe("质能方程  很有名");
  });

  it("count as nothing in the visible text, inline or displayed", () => {
    const document = parseDocument("前面\n\n$$\n\\sum_i x_i\n$$\n\n后面\n");
    expect(squashWhitespace(visibleText(document))).toBe("前面后面");
    expect(document.tree.children.map(child => child.type)).toEqual(["paragraph", "math", "paragraph"]);
  });
});

describe("file trees", () => {
  it("are a registered block that takes block anchors instead of text", () => {
    expect(defaultBlockRegistry.get("tree")).toMatchObject({ kind: "fence", visibleText: false });
    expect(text("前面\n\n```tree\nsrc\n└── a.ts\n```\n")).toBe("前面");
    expect(parseDocument("```tree\nsrc\n```\n").diagnostics).toEqual([]);
  });
});
