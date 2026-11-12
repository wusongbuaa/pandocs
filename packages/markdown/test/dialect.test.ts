import { describe, expect, it } from "vitest";
import {
  ALERT_BLOCKS,
  createBlockRegistry,
  builtinBlocks,
  describeBlocks,
  formatAttributes,
  parseAttributes,
  parseDocument,
  squashWhitespace,
  topLevelBlocks,
  visibleText
} from "@pandocs/markdown";

const names = (markdown: string) => parseDocument(markdown).blocks.map(block => `${block.kind}:${block.name}`);
const text = (markdown: string) => squashWhitespace(visibleText(parseDocument(markdown)));

describe("Markdown dialect", () => {
  it("restores prose that remark-directive mistakes for inline directives", () => {
    const markdown = "地址:abc 端口:8080 时间 10:30am key:value，见 http://a.b/c 结束。\n";
    const document = parseDocument(markdown);
    expect(document.blocks).toEqual([]);
    expect(text(markdown)).toBe(squashWhitespace("地址:abc 端口:8080 时间 10:30am key:value，见 http://a.b/c 结束。"));
  });

  it("recognises registered inline blocks only with a label", () => {
    expect(names('状态 :tag[已完成]{tone="tip"} 结束')).toEqual(["inline:tag"]);
    expect(names("状态 :tag 结束")).toEqual([]);
    expect(names("状态 :nope[文字] 结束")).toEqual([]);
    expect(text("状态 :nope[文字] 结束")).toBe("状态:nope[文字]结束");
  });

  it("uses community container names, titles and nesting", () => {
    const markdown = [
      ":::warning[小心]", "", "内容", "", ":::", "",
      "::::columns", "", ':::column{width="0.5"}', "", "左", "", ":::", "", ':::column{width="0.5"}', "", "右", "", ":::", "", "::::", "",
      ":::::columns", "", '::::column{width="1"}', "", ':::callout{emoji="💡"}', "", "嵌套", "", ":::", "", "::::", "", ":::::"
    ].join("\n");
    expect(names(markdown)).toEqual([
      "container:warning", "container:columns", "container:column", "container:column", "container:columns", "container:column", "container:callout"
    ]);
    expect(text(markdown)).toBe("小心内容左右嵌套");
  });

  it("treats GitHub Alerts as the matching block and drops the marker from visible text", () => {
    for (const [marker, block] of Object.entries(ALERT_BLOCKS)) {
      const markdown = `> [!${marker}]\n> 内容 **加粗**\n`;
      expect(names(markdown)).toEqual([`container:${block}`]);
      expect(text(markdown)).toBe("内容加粗");
    }
    expect(names("> 普通引用\n")).toEqual([]);
  });

  it("keeps unknown blocks out of the reader but in the source", () => {
    const markdown = ':::future{a="1"}\n\n未来的块 **内容**\n\n:::\n\n::later{x="y"}\n\n正文\n';
    const document = parseDocument(markdown);
    expect(document.blocks.map(block => block.kind)).toEqual(["unknown", "unknown"]);
    expect(document.diagnostics.every(item => item.code === "BLOCK_UNKNOWN" && item.severity === "warning")).toBe(true);
    expect(markdown.slice(document.blocks[0]!.start, document.blocks[0]!.end)).toBe(':::future{a="1"}\n\n未来的块 **内容**\n\n:::');
    expect(text(markdown)).toBe("正文");
  });

  it("reports broken blocks without failing the document", () => {
    const markdown = '::video{poster="p.png"}\n\n```chart\n{broken\n```\n\n:::note{bad="1"}\n\n正文\n\n:::\n\n:::column{width="2"}\n\n栏\n\n:::\n';
    const { diagnostics, blocks } = parseDocument(markdown);
    expect(blocks.map(block => block.name)).toEqual(["video", "chart", "note", "column"]);
    expect(diagnostics.map(item => `${item.severity}:${item.code}`)).toEqual([
      "error:BLOCK_ATTR_INVALID", "error:BLOCK_BODY_INVALID", "warning:BLOCK_ATTR_UNKNOWN", "error:BLOCK_ATTR_INVALID"
    ]);
  });

  it("reads fence attributes from the info string and hides rendered fences from visible text", () => {
    const markdown = '```chart title="销量"\n{"type":"bar","xKey":"月","data":[{"月":"一","量":1}]}\n```\n\n```mermaid\nflowchart LR\n```\n\n```ts\nconst a = 1;\n```\n';
    const document = parseDocument(markdown);
    expect(document.blocks.map(block => [block.name, block.attrs])).toEqual([["chart", { title: "销量" }], ["mermaid", {}]]);
    expect(document.diagnostics).toEqual([]);
    expect(text(markdown)).toBe("consta=1;");
  });

  it("does not parse directives inside code", () => {
    expect(names("```markdown\n:::note\n\n代码\n\n:::\n```\n\n`:::note`\n")).toEqual([]);
  });

  it("renders CJK emphasis that plain CommonMark rejects", () => {
    const document = parseDocument("**注意：**先关电源\n");
    const paragraph = document.tree.children[0] as { children: { type: string }[] };
    expect(paragraph.children[0]?.type).toBe("strong");
  });

  it("turns the only allowed inline HTML into a break", () => {
    const document = parseDocument("| 列 |\n| --- |\n| 上<br>下 |\n");
    expect(JSON.stringify(document.tree)).toContain('"type":"break"');
    expect(text("| 列 |\n| --- |\n| 上<br>下 |\n")).toBe("列上下");
    expect(text("<div>隐藏</div>\n\n正文\n")).toBe("正文");
  });

  it("lets a host add blocks without touching the parser", () => {
    const registry = createBlockRegistry([...builtinBlocks, { ...builtinBlocks[0]!, name: "task-card", kind: "leaf", summary: "任务卡片", example: "" }]);
    expect(parseDocument('::task-card{}\n', registry).blocks[0]?.kind).toBe("leaf");
    expect(parseDocument("::task-card{}\n").blocks[0]?.kind).toBe("unknown");
    expect(() => createBlockRegistry([builtinBlocks[0]!, builtinBlocks[0]!])).toThrow();
  });

  it("publishes each block's attributes as JSON Schema", () => {
    const video = describeBlocks().find(block => block.name === "video")!;
    expect(video.attributes).toMatchObject({ type: "object", required: ["src"] });
  });
});

describe("block attributes", () => {
  it("reads every form the syntax allows and writes one", () => {
    expect(parseAttributes(`a="1" b='2' c=3 d .x .y #z`)).toEqual({ a: "1", b: "2", c: "3", d: "", class: "x y", id: "z" });
    expect(parseAttributes(undefined)).toEqual({});
    expect(formatAttributes({ a: "1", b: 'x"y', c: null })).toBe('{a="1" b="x&quot;y"}');
    expect(formatAttributes({})).toBe("");
    expect(parseAttributes('b="x&quot;y"')).toEqual({ b: 'x"y' });
  });
});

describe("loose containers from other documentation tools", () => {
  const blockNames = (markdown: string) => parseDocument(markdown).blocks.map(block => block.name);

  it("reads `:::tip 标题` as the same block as `:::tip[标题]`", () => {
    const loose = parseDocument(":::tip 注意事项\n\n内容\n\n:::\n\n之后的段落\n");
    expect(loose.blocks.map(block => block.name)).toEqual(["tip"]);
    expect(visibleText(loose)).toBe(visibleText(parseDocument(":::tip[注意事项]\n\n内容\n\n:::\n\n之后的段落\n")));
    expect(topLevelBlocks(loose).map(block => block.type)).toEqual(["tip", "paragraph"]);
  });

  it("reads the compact form with no blank lines", () => {
    const parsed = parseDocument(":::warning 小心\n第一行\n第二行\n:::\n");
    expect(parsed.blocks.map(block => block.name)).toEqual(["warning"]);
    expect(squashWhitespace(visibleText(parsed))).toBe("小心第一行第二行");
  });

  it("keeps the block's whole source range, so block edits replace the markers too", () => {
    const markdown = "前面\n\n:::tip 标题\n\n内容\n\n:::\n\n后面\n";
    const [, container] = topLevelBlocks(parseDocument(markdown));
    expect(markdown.slice(container!.start, container!.end)).toBe(":::tip 标题\n\n内容\n\n:::");
  });

  it("leaves anything it cannot close, or does not know, as the text the author wrote", () => {
    expect(blockNames(":::tip 没有结束\n\n内容\n")).toEqual([]);
    expect(blockNames(":::nothing 标题\n\n内容\n\n:::\n")).toEqual([]);
    expect(squashWhitespace(visibleText(parseDocument(":::nothing 标题\n\n内容\n\n:::\n")))).toBe(":::nothing标题内容:::");
  });

  it("nests inside a real directive", () => {
    expect(blockNames(":::::columns\n\n::::column\n\n:::tip 标题\n\n内容\n\n:::\n\n::::\n\n:::::\n")).toEqual(["columns", "column", "tip"]);
  });
});
