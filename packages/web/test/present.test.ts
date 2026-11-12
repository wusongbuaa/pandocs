// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { zoomAround } from "../src/markdown/diagram-zoom";
import { renderMarkdown } from "../src/markdown/pipeline";
import { toMarkmapData } from "../src/present/mindmap-chart";
import { treeFromMarkdown, treeFromOutline } from "../src/present/mindmap-tree";
import { splitSlides } from "../src/present/split-slides";

const slidesOf = async (markdown: string, title = "页面标题") => splitSlides((await renderMarkdown(markdown, { title })).hast);
const tagsOf = (slide: { children: unknown[] }) => (slide.children as { tagName?: string }[]).map(node => node.tagName).filter(Boolean);

describe("a page as slides", () => {
  it("makes one slide for each section and each divider, with what comes first under the title", async () => {
    const { opening, slides } = await slidesOf("开场白\n\n## 第一节\n\n内容\n\n---\n\n接着说\n\n## 第二节\n\n内容\n");
    expect(opening.filter(node => node.type === "element").length).toBe(1);
    expect(slides.map(tagsOf)).toEqual([["h2", "p"], ["p"], ["h2", "p"]]);
  });

  it("drops the title the page writes itself, because the opening slide shows it", async () => {
    const { opening, slides } = await slidesOf("# 页面标题\n\n## 第一节\n\n内容\n");
    expect(opening).toEqual([]);
    expect(slides.map(tagsOf)).toEqual([["h2", "p"]]);
  });

  it("breaks a long section at its next headings", async () => {
    const paragraphs = Array.from({ length: 5 }, (_, at) => `段落 ${at}`).join("\n\n");
    const { slides } = await slidesOf(`## 很长的一节\n\n### 甲\n\n${paragraphs}\n\n### 乙\n\n${paragraphs}\n\n## 短的一节\n\n内容\n`);
    expect(slides.map(slide => tagsOf(slide)[0])).toEqual(["h2", "h3", "h3", "h2"]);
  });

  it("gives footnotes a slide of their own", async () => {
    const { slides } = await slidesOf("## 第一节\n\n带脚注[^1]\n\n[^1]: 内容\n");
    expect(slides.map(tagsOf)).toEqual([["h2", "p"], ["section"]]);
  });

  it("copes with a page that has nothing on it", async () => {
    expect(await slidesOf("")).toEqual({ opening: [], slides: [] });
  });
});

describe("zooming into a diagram", () => {
  it("keeps the point under the pointer where it is", () => {
    const view = zoomAround({ scale: 1, x: 0, y: 0 }, { x: 100, y: 50 }, 2);
    expect(view).toEqual({ scale: 2, x: -100, y: -50 });
    const place = (x: number, y: number) => ({ x: x * view.scale + view.x, y: y * view.scale + view.y });
    expect(place(100, 50)).toEqual({ x: 100, y: 50 });
    const again = zoomAround(view, { x: 400, y: 300 }, 1.5);
    expect(400 - again.x).toBeCloseTo((400 - view.x) * 1.5);
    expect(300 - again.y).toBeCloseTo((300 - view.y) * 1.5);
  });

  it("stops at a smallest and a largest size, and stays put there", () => {
    const largest = zoomAround({ scale: 8, x: 10, y: 20 }, { x: 100, y: 100 }, 2);
    expect(largest).toEqual({ scale: 8, x: 10, y: 20 });
    expect(zoomAround({ scale: 0.5, x: 10, y: 20 }, { x: 100, y: 100 }, 0.5)).toEqual({ scale: 0.5, x: 10, y: 20 });
  });
});

describe("a page as a mind map", () => {
  it("follows the levels of the outline, and remembers which heading each branch is", () => {
    const root = treeFromOutline("标题", [
      { id: "a", text: "甲", depth: 2 },
      { id: "a1", text: "甲一", depth: 3 },
      { id: "b", text: "乙", depth: 2 },
      { id: "b1", text: "跳级的", depth: 4 }
    ]);
    expect(root).toEqual({ text: "标题", children: [
      { text: "甲", headingId: "a", children: [{ text: "甲一", headingId: "a1", children: [] }] },
      { text: "乙", headingId: "b", children: [{ text: "跳级的", headingId: "b1", children: [] }] }
    ] });
  });

  it("reads a block's headings and lists, with a lone heading as the centre", () => {
    expect(treeFromMarkdown("# 中心\n\n- 分支\n  - **要点**\n- 另一支\n\n一段话\n")).toEqual({ text: "中心", children: [
      { text: "分支", children: [{ text: "**要点**", children: [] }] },
      { text: "另一支", children: [] },
      { text: "一段话", children: [] }
    ] });
  });

  it("uses the title as the centre when there is more than one thing at the top", () => {
    expect(treeFromMarkdown("- 甲\n- 乙\n", "标题")).toEqual({ text: "标题", children: [{ text: "甲", children: [] }, { text: "乙", children: [] }] });
    expect(treeFromMarkdown("- 甲\n- 乙\n").text).toBe("");
  });

  it("hands the map escaped text, because it puts what it gets into the page as HTML", () => {
    const data = toMarkmapData({ text: '<img src=x onerror="window.__xss=1"/> **重点**', children: [{ text: "<script>x</script>", headingId: "a", children: [] }] });
    expect(data.content).toBe('&lt;img src=x onerror="window.__xss=1"/&gt; <strong>重点</strong>');
    expect(data.children[0]!.content).toBe("&lt;script&gt;x&lt;/script&gt;");
    expect(data.children[0]!.payload).toEqual({ headingId: "a" });
  });
});
