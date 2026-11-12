import { describe, expect, it } from "vitest";
import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";
import { renderMarkdown } from "../src/markdown/pipeline";

function elements(tree: Root, tag: string): Element[] {
  const found: Element[] = [];
  visit(tree, "element", (node: Element) => {
    if (node.tagName === tag) found.push(node);
  });
  return found;
}

describe("Markdown to the theme's elements", () => {
  it("keeps one page title: sections written with # step down a level", async () => {
    const { hast, toc, headingTitle } = await renderMarkdown("# 第一章\n\n## 小节\n\n# 第二章\n", { title: "手册" });
    expect(headingTitle).toBe("");
    expect(elements(hast, "h1")).toHaveLength(0);
    expect(elements(hast, "h2")).toHaveLength(2);
    expect(toc.map(entry => [entry.depth, entry.text])).toEqual([[2, "第一章"], [3, "小节"], [2, "第二章"]]);
  });

  it("treats a first heading that repeats the title as the title", async () => {
    const { hast, toc, headingTitle } = await renderMarkdown("# 手册\n\n## 小节\n", { title: "手册" });
    expect(headingTitle).toBe("手册");
    expect(elements(hast, "h1")).toHaveLength(1);
    expect(toc.map(entry => entry.text)).toEqual(["小节"]);
  });

  it("leaves documents that already start at ## alone", async () => {
    const { toc } = await renderMarkdown("## 小节\n\n### 更小\n", { title: "手册" });
    expect(toc.map(entry => entry.depth)).toEqual([2, 3]);
  });

  it("keeps inline marks in the table of contents, as the official one does", async () => {
    const { toc } = await renderMarkdown("## 用 `npm` 和 **粗体**\n", { title: "手册" });
    expect(toc[0]?.text).toBe("用 `npm` 和 **粗体**");
  });

  it("keeps a formula in a heading readable in the outline, as its source", async () => {
    const { toc } = await renderMarkdown("## 公式 $$x^2$$ 小节\n", { title: "手册" });
    expect(toc[0]?.text).toBe("公式 `x^2` 小节");
  });

  it("adds the theme's anchor to every heading, with the id the server's outline uses", async () => {
    const { hast } = await renderMarkdown("## 小节 一\n", { title: "手册" });
    const heading = elements(hast, "h2")[0]!;
    expect(heading.properties.id).toBe("小节-一");
    expect((heading.children[0] as Element).properties.class).toBe("rp-header-anchor");
  });

  it("drops raw HTML and script links, and keeps asset paths", async () => {
    const { hast } = await renderMarkdown("<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))\n\n[好链接](https://example.test)\n\n![图](assets/" + "a".repeat(64) + ".png)\n", { title: "手册" });
    expect(elements(hast, "script")).toHaveLength(0);
    const [bad, good] = elements(hast, "a");
    expect(bad?.properties.href).toBeUndefined();
    expect(good?.properties.href).toBe("https://example.test");
    expect(elements(hast, "img")[0]?.properties.src).toContain("assets/");
  });

  it("highlights code with the theme's css-variables output, loading Shiki only when there is code", async () => {
    const { hast } = await renderMarkdown("```ts title=\"a.ts\"\nconst a = 1;\n```\n", { title: "手册" });
    const pre = elements(hast, "pre")[0]!;
    expect(String(pre.properties.class)).toContain("shiki");
    expect(pre.properties.title).toBe("a.ts");
  });

  it("shows code in a language it has no grammar for as plain code, and the rest of the page with it", async () => {
    for (const lang of ["curl", "terminal-output"]) {
      const { hast } = await renderMarkdown(`Before.\n\n\`\`\`${lang}\ncurl http://127.0.0.1/healthz\n\`\`\`\n\nAfter.\n`, { title: "接入" });
      expect(String(elements(hast, "pre")[0]!.properties.class)).toContain("shiki");
      expect(JSON.stringify(hast)).toContain("After.");
    }
  });
});
