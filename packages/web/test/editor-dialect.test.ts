import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import {
  defaultBlockRegistry,
  joinBlocks,
  parseDocument,
  spliceBlocks,
  squashWhitespace,
  visibleText
} from "@pandocs/markdown";
import { createDialectManager, editorSourceBlocks } from "@pandocs/editor-model";

const DIR = join(import.meta.dirname, "../../markdown/test/fixtures/corpus");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as { file: string; title: string }[];
const pages = manifest.map(entry => ({ ...entry, markdown: readFileSync(join(DIR, entry.file), "utf8") }));

function blocksFromEditor(node: JSONContent, out: string[] = []): string[] {
  const type = node.type ?? "";
  const definition = defaultBlockRegistry.get(type);
  if (type === "rawDirective") out.push(`unknown:${node.attrs?.directive as string}`);
  else if (definition && definition.kind !== "fence") out.push(`${definition.kind}:${type}`);
  else if (type === "codeBlock") {
    const language = String(node.attrs?.language ?? "").split(/\s/u)[0]!;
    if (defaultBlockRegistry.get(language)?.kind === "fence") out.push(`fence:${language}`);
  }
  (node.content ?? []).forEach(child => blocksFromEditor(child, out));
  return out;
}

function textFromEditor(node: JSONContent): string {
  const type = node.type ?? "";
  if (type === "text") return node.text ?? "";
  if (
    type === "image" ||
    type === "breakInline" ||
    type === "rawDirective" ||
    type === "footnoteReference" ||
    type === "footnoteDefinition"
  )
    return "";
  if (type === "codeBlock") {
    const language = String(node.attrs?.language ?? "").split(/\s/u)[0]!;
    if (defaultBlockRegistry.get(language)?.visibleText === false) return "";
  }
  const definition = defaultBlockRegistry.get(type);
  if (definition?.kind === "leaf") return "";
  if (definition?.kind === "inline") return String(node.attrs?.label ?? "");
  return `${definition?.kind === "container" && definition.labelText !== false && node.attrs?.label ? String(node.attrs.label) : ""}${(node.content ?? []).map(textFromEditor).join("")}`;
}

const serverBlocks = (markdown: string) =>
  parseDocument(markdown).blocks.map(
    block => `${block.kind === "unknown" ? `unknown:${block.name}` : `${block.kind}:${block.name}`}`
  );
const serverText = (markdown: string) => squashWhitespace(visibleText(parseDocument(markdown)));

describe("the editor reads Markdown the way the server does", () => {
  it.each(pages.map(page => [page.title, page.markdown] as const))(
    "agrees on blocks and visible text: %s",
    (_title, markdown) => {
      const { manager } = createDialectManager();
      const document = manager.parse(markdown);
      expect(blocksFromEditor(document)).toEqual(serverBlocks(markdown));
      expect(squashWhitespace(textFromEditor(document))).toBe(serverText(markdown));
    }
  );

  const TRAPS = [
    '地址:abc 端口:8080 时间 10:30am key:value，状态 :tag[已完成]{tone="tip"} 结束。\n',
    ":::warning[小心]\n\n内容\n\n:::\n",
    ':::note{emoji="📌"}\n\n带属性\n\n:::\n',
    "> [!WARNING]\n> 提醒 **加粗**\n",
    "> [!TIP]\n> 第一行\n>\n> 第二段\n",
    '1. 列表项\n\n   :::callout{emoji="x"}\n\n   列表里的提示\n\n   :::\n',
    "- 列表项\n\n  :::tip\n\n  无序列表里的提示\n\n  :::\n",
    '::video[演示]{src="assets/a.mp4"}\n',
    ':::future{a="1"}\n\n未来的块 **内容**\n\n:::\n\n::later{x="y"}\n',
    "```markdown\n:::note\n\n代码里的指令不算\n\n:::\n```\n",
    ":::note\n\n```markdown\n:::\n```\n\n容器里的代码块\n\n:::\n",
    "::::note\n\n```markdown\n:::\n```\n\n冒号更多的容器才能包住代码里的指令\n\n::::\n",
    '::::columns\n\n:::column{width="0.5"}\n\n左\n\n:::\n\n:::column{width="0.5"}\n\n右\n\n:::\n\n::::\n',
    "| 列 |\n| --- |\n| 上<br>下 |\n",
    ":::steps\n\n### 第一步\n\n内容\n\n### 第二步\n\n内容\n\n:::\n",
    "::::tabs\n\n:::tab[甲]\n\n甲的内容\n\n:::\n\n:::tab[乙]\n\n乙的内容\n\n:::\n\n::::\n",
    '::::cards\n\n:::card[标题]{href="./a.md"}\n\n说明\n\n:::\n\n::::\n',
    '::compare[改版]{before="assets/a.png" after="assets/b.png"}\n',
    '```prompt title="修复"\n帮我修 `bug`\n\n- 第一步\n```\n',
    '```hotspots src="assets/a.png"\n[{"x":10,"y":20,"title":"入口"}]\n```\n',
    "这句话有脚注[^1]，还有一个[^长名字]。\n\n[^1]: 第一条。\n\n[^长名字]: 第二条\n    第二行\n\n    第二段\n\n后面的段落\n"
  ];

  it.each(TRAPS)("agrees on a tricky case: %j", markdown => {
    const { manager } = createDialectManager();
    const document = manager.parse(markdown);
    expect(blocksFromEditor(document)).toEqual(serverBlocks(markdown));
    expect(squashWhitespace(textFromEditor(document))).toBe(serverText(markdown));
  });

  it("agrees on what a container's title is", () => {
    const { manager } = createDialectManager();
    expect(manager.parse(":::warning[小心]\n\n内容\n\n:::\n").content?.[0]).toMatchObject({
      type: "warning",
      attrs: { label: "小心" }
    });
  });
});

describe("writing Markdown back", () => {
  const roundTrip = (markdown: string) => {
    const { manager } = createDialectManager();
    return manager.serialize(manager.parse(markdown));
  };

  it("writes blocks in the canonical community form", () => {
    expect(roundTrip(":::warning[小心]{emoji=x}\n内容\n:::\n").trim()).toBe(
      ':::warning[小心]{emoji="x"}\n\n内容\n\n:::'
    );
    expect(roundTrip("::::columns\n:::column{width=0.5}\n左\n:::\n::::\n").trim()).toBe(
      '::::columns\n\n:::column{width="0.5"}\n\n左\n\n:::\n\n::::'
    );
    expect(roundTrip("::video[演示]{src=a.mp4}\n").trim()).toBe('::video[演示]{src="a.mp4"}');
    expect(roundTrip("状态 :tag[完成]{tone=tip} 结束\n").trim()).toBe('状态 :tag[完成]{tone="tip"} 结束');
  });

  it.each([
    ":::steps\n\n### 第一步\n\n内容\n\n### 第二步\n\n内容\n\n:::",
    "::::tabs\n\n:::tab[甲]\n\n内容\n\n:::\n\n:::tab[乙]\n\n内容\n\n:::\n\n::::",
    '::::tabs{group="系统"}\n\n:::tab[甲]\n\n内容\n\n:::\n\n::::',
    '::::cards\n\n:::card[标题]{href="./a.md"}\n\n说明\n\n:::\n\n::::',
    '::compare[改版]{before="assets/a.png" after="assets/b.png" beforeLabel="旧" afterLabel="新"}',
    '```prompt title="修复" description="贴给 Agent"\n帮我修 `bug`\n\n- 第一步\n```',
    '```hotspots src="assets/a.png" alt="控制台"\n[{"x":10,"y":20,"title":"入口"}]\n```'
  ])("keeps demonstration blocks as written: %j", markdown => {
    expect(roundTrip(`${markdown}\n`).trim()).toBe(markdown);
  });

  it.each([
    "这句话有脚注[^1]。\n\n[^1]: 脚注的内容。",
    "连着两个[^a][^b]不算上标。\n\n[^a]: 甲\n\n[^b]: 乙",
    "正文[^1]\n\n[^1]: 第一行\n    第二行\n\n    第二段\n\n## 后面的标题"
  ])("keeps footnotes as written: %j", markdown => {
    expect(roundTrip(`${markdown}\n`).trim()).toBe(markdown);
  });

  it("keeps a caption whole when it has quotes in it", () => {
    const written = '![图](/a.png "他说 \\"好\\" align=center")';
    expect(roundTrip(`${written}\n`).trim()).toBe(written);
    // Alignment is an attribute of its own, so that someone changing it and someone writing the caption do not undo each other.
    expect(createDialectManager().manager.parse(`${written}\n`).content?.[0]).toMatchObject({
      type: "image",
      attrs: { title: '他说 "好"', align: "center" }
    });
  });

  it("keeps GitHub Alerts as they were written", () => {
    expect(roundTrip("> [!WARNING]\n> 提醒\n").trim()).toBe("> [!WARNING]\n> 提醒");
  });

  it("keeps unknown blocks byte for byte, attributes it does not model too", () => {
    const unknown = ":::future{a=\"1\" b='2'}\n未来的块 **内容**\n:::";
    expect(roundTrip(`${unknown}\n`).trim()).toBe(unknown);
    expect(roundTrip('::later{x="y"}\n').trim()).toBe('::later{x="y"}');
    expect(roundTrip(':::note{future="1"}\n\n内容\n\n:::\n').trim()).toBe(':::note{future="1"}\n\n内容\n\n:::');
  });

  it("does not turn CJK emphasis into escaped asterisks", () => {
    expect(roundTrip("**注意：**先关电源\n").trim()).toBe("**注意：**先关电源");
  });

  it("does not break table cells with line breaks", () => {
    const row = roundTrip("| 列 |\n| --- |\n| 上<br>下 |\n");
    expect(row).toContain("上<br>下");
    expect(row).not.toContain("&lt;");
  });

  it.each(pages.map(page => [page.title, page.markdown] as const))(
    "keeps every untouched byte with block-level write back: %s",
    (_title, markdown) => {
      const { manager, marked } = createDialectManager();
      const nodes = manager.parse(markdown).content ?? [];
      const source = editorSourceBlocks(marked, markdown);
      expect(source).toHaveLength(nodes.length);
      const serialize = (node: JSONContent) => manager.serialize({ type: "doc", content: [node] }).trim();
      const baseline = nodes.map(serialize);
      expect(joinBlocks(spliceBlocks(source, baseline, baseline))).toBe(joinBlocks(source));

      const index = nodes.findIndex(
        (node, at) => at >= nodes.length / 3 && node.type === "paragraph" && node.content?.[0]?.type === "text"
      );
      if (index < 0) return;
      const edited: JSONContent[] = JSON.parse(JSON.stringify(nodes));
      edited[index]!.content![0]!.text += "（已修改）";
      const saved = spliceBlocks(source, baseline, edited.map(serialize));
      expect(saved.filter((block, at) => block !== source[at])).toHaveLength(1);
      expect(saved).toHaveLength(source.length);
    }
  );
});
