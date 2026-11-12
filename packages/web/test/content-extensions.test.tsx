// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument, squashWhitespace, visibleText } from "@pandocs/markdown";
import { createDialectExtensions, createDialectManager, createDialectMarked, createMarkdownExtension } from "@pandocs/editor-model";
import { createWriteBack } from "../src/editor/write-back";
import { FileTree, parseFileTree } from "../src/markdown/file-tree";
import { layoutFromFrontMatter } from "../src/markdown/front-matter";
import { formatImageTitle, parseImageTitle } from "@pandocs/markdown";
import { renderMarkdown } from "../src/markdown/pipeline";
import { readingMinutes } from "../src/markdown/reading-time";
import { buildTextMap } from "../src/reader/text-map";
import { renderDocument } from "./support";

afterEach(cleanup);

const domText = (root: Element) => buildTextMap(root).segments.map(segment => segment.node.nodeValue ?? "").join("");

describe("addresses in a block's own attributes", () => {
  it("lead nowhere when they could run script, and work as usual otherwise", async () => {
    const { body } = await renderDocument([
      '::file[Report]{src="javascript:alert(1)"}',
      '::video{src="data:text/html,<script>alert(1)</script>" poster="javascript:alert(2)"}',
      '::file[Elsewhere]{src="https://example.com/report.pdf"}',
      '::file[Here]{src="assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf"}'
    ].join("\n\n"));
    const links = [...body.querySelectorAll("a.pd-file")].map(link => link.getAttribute("href"));
    expect(links[0]).toBe("about:blank");
    expect(links[1]).toBe("https://example.com/report.pdf");
    expect(links[2]).toContain("/assets/aaaaaaaa");
    const video = body.querySelector("video")!;
    expect([video.getAttribute("src"), video.getAttribute("poster")]).toEqual(["about:blank", "about:blank"]);
  });
});

describe("comment offsets stay right around the new content", () => {
  const MARKDOWN = [
    "开头 H~2~O 和 10^3^ 的文字。",
    "带公式 $$E=mc^2$$ 的一句话。",
    "$$\n\\sum_{i=1}^n x_i\n$$",
    "$$x^2$$",
    '![图](/a.png "示意图 align=center width=320")',
    "```tree\nsrc\n├── a.ts\n└── b.ts  # 说明\n```",
    "结尾的文字。"
  ].join("\n\n");

  it("counts the same text in the page and on the server", async () => {
    const { body } = await renderDocument(MARKDOWN);
    expect(body.querySelectorAll(".katex").length).toBe(3);
    expect(body.querySelector("sub")?.textContent).toBe("2");
    expect(body.querySelector("sup")?.textContent).toBe("3");
    expect(squashWhitespace(domText(body))).toBe(squashWhitespace(visibleText(parseDocument(MARKDOWN))));
  });
});

describe("demonstration blocks in the page", () => {
  // The theme's tabs read the group's choice from here, and Node's own `localStorage` hides happy-dom's.
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }));
  afterEach(() => vi.unstubAllGlobals());

  const MARKDOWN = [
    "开头。",
    ":::steps\n\n### 第一步\n\n做这个\n\n### 第二步\n\n做那个\n\n:::",
    "::::tabs\n\n:::tab[甲]\n\n甲的内容\n\n:::\n\n:::tab[乙]\n\n乙的内容\n\n:::\n\n::::",
    '::::cards\n\n:::card[快速开始]{href="./a.md"}\n\n五分钟跑通\n\n:::\n\n:::card[没有链接]\n\n只是说明\n\n:::\n\n::::',
    '```prompt title="修复" description="贴给 Agent"\n帮我修 `bug`\n\n- 第一步\n```',
    '```hotspots src="assets/a.png" alt="控制台"\n[{"x":10,"y":20,"title":"入口","text":"从这里开始"}]\n```',
    '::compare[改版]{before="assets/a.png" after="assets/b.png"}',
    '![图](/a.png "图片说明 align=center")',
    "带脚注的话[^1]\n\n[^1]: 脚注内容",
    "结尾。"
  ].join("\n\n");

  it("count the same text in the page and on the server", async () => {
    const { body } = await renderDocument(MARKDOWN);
    expect(squashWhitespace(domText(body))).toBe(squashWhitespace(visibleText(parseDocument(MARKDOWN))));
  });

  it("use the theme's own steps, tabs and prompt", async () => {
    const { body } = await renderDocument(MARKDOWN);
    expect(body.querySelectorAll(".rp-steps > h3").length).toBe(2);
    expect([...body.querySelectorAll(".rp-tabs__label__item")].map(item => item.textContent)).toEqual(["甲", "乙"]);
    expect(body.querySelector(".rp-tabs__content__item--active")?.textContent).toContain("甲的内容");
    expect(body.querySelector(".rp-tabs__content__item--hidden")?.textContent).toContain("乙的内容");
    expect(body.querySelector(".rp-prompt__title")?.textContent).toBe("修复");
    expect(body.querySelector(".rp-prompt__description")?.textContent).toBe("贴给 Agent");
    expect(body.querySelector(".rp-prompt__content-body")?.textContent).toBe("帮我修 `bug`\n\n- 第一步");
  });

  it("link a card to a page through its title, and leave the rest of it alone", async () => {
    const { body } = await renderDocument(MARKDOWN);
    const cards = [...body.querySelectorAll(".pd-doc-card")];
    expect(cards.length).toBe(2);
    expect(cards[0]!.querySelector(".pd-doc-card__title a")?.getAttribute("href")).toContain("/handbook/a");
    expect(cards[1]!.querySelector("a")).toBeNull();
    expect(cards[1]!.textContent).toBe("没有链接只是说明");
  });

  it("drop a card link that could run code", async () => {
    const { body } = await renderDocument(':::card[危险]{href="javascript:alert(1)"}\n\n说明\n\n:::\n');
    expect(body.querySelector(".pd-doc-card a")).toBeNull();
    expect(body.querySelector(".pd-doc-card__title")?.textContent).toBe("危险");
  });

  it("number a screenshot's marks and list them below it, as text and never as markup", async () => {
    const { body } = await renderDocument('```hotspots src="assets/a.png" alt="控制台"\n[{"x":10,"y":20,"title":"<img src=x onerror=alert(1)>","text":"从这里开始"}]\n```\n');
    const mark = body.querySelector<HTMLElement>(".pd-hotspots__mark")!;
    expect(mark.textContent).toBe("1");
    expect(mark.style.left).toBe("10%");
    expect(mark.style.top).toBe("20%");
    expect(body.querySelector(".pd-hotspots__legend li strong")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(body.querySelector(".pd-hotspots__legend img")).toBeNull();
  });

  it("say so instead of guessing when a screenshot's marks cannot be read", async () => {
    const { body } = await renderDocument('```hotspots src="assets/a.png"\n不是 JSON\n```\n');
    expect(body.textContent).toContain("截图标注无法显示");
    expect(body.querySelector(".pd-hotspots")).toBeNull();
  });

  it("show an image's title as its caption, and no longer as a tooltip", async () => {
    const { body } = await renderDocument('![图](/a.png "图片说明 align=center")\n');
    const figure = body.querySelector(".pd-figure")!;
    expect(figure.getAttribute("data-align")).toBe("center");
    expect(figure.querySelector("img")?.getAttribute("title")).toBeNull();
    expect(figure.querySelector(".pd-figure__caption")?.textContent).toBe("图片说明");
  });

  it("title the footnotes in the reader's language and keep them out of the outline", async () => {
    const page = JSON.stringify((await renderMarkdown("带脚注[^1]\n\n[^1]: 内容\n", { title: "" })).hast);
    expect(page).toContain('"value":"脚注"');
    expect(page).toContain("rp-toc-exclude");
  });
});

describe("formulas", () => {
  it("display a formula alone on its line, and keep one inside a sentence inline", async () => {
    const { hast } = await renderMarkdown("$$x^2$$\n\n句子里 $$y$$ 的公式\n", { title: "" });
    const html = JSON.stringify(hast);
    expect(html.match(/katex-display/gu)?.length).toBe(1);
    expect(html.match(/"katex"/gu)?.length).toBe(2);
  });

  it("show the source instead of failing when the LaTeX is wrong", async () => {
    await expect(renderMarkdown("$$\\notacommand{$$\n", { title: "" })).resolves.toBeDefined();
  });
});

describe("the editor keeps the new syntax as written", () => {
  const opened: Editor[] = [];
  afterEach(async () => {
    for (const editor of opened.splice(0)) editor.destroy();
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  const open = (body: string) => {
    const marked = createDialectMarked();
    const editor = new Editor({ element: document.createElement("div"), extensions: [...createDialectExtensions(), createMarkdownExtension(marked)], content: body, contentType: "markdown" } as never);
    editor.view.dispatch(editor.state.tr);
    opened.push(editor);
    return { editor, writeBack: createWriteBack(editor, marked, body) };
  };

  it("reads them as what they are", () => {
    const { manager } = createDialectManager();
    const nodes = JSON.stringify(manager.parse("水 H~2~O 面积 10^2^ 公式 $$E=mc^2$$\n\n$$\n\\sum x\n$$\n"));
    expect(nodes).toContain('"subscript"');
    expect(nodes).toContain('"superscript"');
    expect(nodes).toContain('"mathInline"');
    expect(nodes).toContain('"mathBlock"');
  });

  it("writes every block back the same after editing elsewhere", () => {
    const blocks = ["水 H~2~O 面积 10^2^ 公式 $$E=mc^2$$", "$$\n\\sum_i x_i\n$$", '![图](/a.png "align=center")', "```tree\nsrc\n└── a.ts\n```"];
    const { editor, writeBack } = open(`${blocks.join("\n\n")}\n`);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, { type: "paragraph", content: [{ type: "text", text: "新增的段落" }] });
    const markdown = writeBack.markdown();
    for (const block of blocks) expect(markdown).toContain(block);
    expect(markdown).toContain("新增的段落");
  });

  it("does not lose footnotes when the paragraph that cites one is edited", () => {
    const source = "这句话有脚注[^1]。\n\n[^1]: 脚注的内容。\n\n结尾。\n";
    const { editor, writeBack } = open(source);
    expect(writeBack.aligned).toBe(true);
    editor.commands.insertContentAt(1, "新增");
    expect(writeBack.markdown()).toBe("新增这句话有脚注[^1]。\n\n[^1]: 脚注的内容。\n\n结尾。\n");
  });

  it("writes them back correctly when the block itself was edited", () => {
    const manager = createDialectManager().manager;
    const json = manager.parse("水 H~2~O 面积 10^2^ 公式 $$E=mc^2$$\n\n$$\n\\sum x\n$$\n");
    const markdown = manager.serialize(json);
    expect(markdown).toContain("H~2~O");
    expect(markdown).toContain("10^2^");
    expect(markdown).toContain("$$E=mc^2$$");
    expect(markdown).toContain("$$\n\\sum x\n$$");
  });

  it("shows an aligned image without changing its Markdown", () => {
    const { editor } = open('![图](/a.png "说明 align=right width=200")\n');
    const image = editor.view.dom.querySelector("img")!;
    expect(image.getAttribute("data-align")).toBe("right");
    expect(image.getAttribute("title")).toBe("说明");
    expect(image.getAttribute("style")).toContain("200px");
    // Each is an attribute of its own in the editor, so that two people changing different ones keep both, and the Markdown is as it was.
    expect(editor.getJSON().content?.[0]?.attrs).toMatchObject({ title: "说明", align: "right", width: 200 });
    expect(createDialectManager().manager.serialize(editor.getJSON()).trim()).toBe('![图](/a.png "说明 align=right width=200")');
  });
});

describe("image layout", () => {
  it("reads alignment and width out of the title, leaving the title itself", () => {
    expect(parseImageTitle("示意图 align=center width=320")).toEqual({ title: "示意图", align: "center", width: 320 });
    expect(parseImageTitle("示意图")).toEqual({ title: "示意图" });
    expect(parseImageTitle("align=middle")).toEqual({ title: "align=middle" });
  });

  it("writes back what it read", () => {
    expect(formatImageTitle(parseImageTitle("示意图 align=center width=320"))).toBe("示意图 align=center width=320");
    expect(formatImageTitle({ title: "" })).toBeNull();
    expect(formatImageTitle({ title: "", align: "right" })).toBe("align=right");
  });

  it("reaches the rendered page", async () => {
    const { hast } = await renderMarkdown('![图](/a.png "说明 align=center width=320")\n', { title: "" });
    const image = JSON.stringify(hast);
    expect(image).toContain('"dataAlign":"center"');
    expect(image).toContain("width: 320px");
    expect(image).toContain('"title":"说明"');
  });
});

describe("file trees", () => {
  it("read what the tree command prints", () => {
    const nodes = parseFileTree(["src", "├── index.ts", "├── pages  # 页面", "│   └── home.tsx", "└── README.md"].join("\n"));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.folder).toBe(true);
    expect(nodes[0]!.children.map(node => [node.name, node.folder, node.comment])).toEqual([["index.ts", false, ""], ["pages", true, "页面"], ["README.md", false, ""]]);
    expect(nodes[0]!.children[1]!.children[0]!.name).toBe("home.tsx");
  });

  it("read plain indented lists, and a trailing slash marks an empty folder", () => {
    const nodes = parseFileTree(["docs/", "  - a.md", "  - sub/", "    - b.md", "empty/"].join("\n"));
    expect(nodes.map(node => [node.name, node.folder])).toEqual([["docs", true], ["empty", true]]);
    expect(nodes[0]!.children.map(node => node.name)).toEqual(["a.md", "sub"]);
    expect(nodes[0]!.children[1]!.children[0]!.name).toBe("b.md");
  });

  it("render as a collapsible tree that does not count as text", () => {
    const { container } = render(<FileTree source={"src\n└── a.ts"} title="结构" />);
    expect(container.querySelector("figure")?.hasAttribute("data-pandocs-nontext")).toBe(true);
    expect(container.textContent).toContain("a.ts");
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("reading time", () => {
  const tree = (value: string) => ({ type: "root" as const, children: [{ type: "text" as const, value }] });

  it("counts Chinese characters and English words at their own pace, never less than a minute", () => {
    expect(readingMinutes(tree("短"))).toBe(1);
    expect(readingMinutes(tree("字".repeat(2000)))).toBe(5);
    expect(readingMinutes(tree("word ".repeat(1000)))).toBe(5);
    expect(readingMinutes(tree(`${"字".repeat(400)} ${"word ".repeat(200)}`))).toBe(2);
  });
});

describe("page layout from front matter", () => {
  it("passes through what chooses a layout, and nothing else", () => {
    const layout = layoutFromFrontMatter("---\npageType: home\noutline: false\nsecret: x\nhero:\n  name: 手册\n  actions:\n    - text: 开始\n      link: /a\n      theme: alt\nfeatures:\n  - title: 一\n    details: 说明\n    span: 6\n---\n\n正文\n");
    expect(layout).toEqual({
      pageType: "home",
      outline: false,
      hero: { name: "手册", actions: [{ theme: "alt", text: "开始", link: "/a" }] },
      features: [{ title: "一", details: "说明", span: 6 }]
    });
  });

  it("cannot be used to put HTML or scripts on the page", () => {
    const layout = layoutFromFrontMatter('---\nhero:\n  name: <img src=x onerror=alert(1)>\n  actions:\n    - text: 点我\n      link: javascript:alert(1)\n  image:\n    src: javascript:alert(1)\nfeatures:\n  - title: <b>一</b>\n    icon: <svg onload=alert(1)>\n    link: data:text/html,x\n---\n');
    expect(JSON.stringify(layout)).not.toMatch(/[<>]|javascript:|data:text/u);
    expect((layout.hero as { actions: unknown[] }).actions).toEqual([]);
  });

  it("ignores a page without front matter or with broken YAML", () => {
    expect(layoutFromFrontMatter("正文\n")).toEqual({});
    expect(layoutFromFrontMatter("---\nhero: [\n---\n\n正文\n")).toEqual({});
    expect(layoutFromFrontMatter("---\npageType: evil\n---\n")).toEqual({});
  });
});

describe("tabs and folded blocks in a page", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("are tabs a keyboard can reach and move between", async () => {
    const { body } = await renderDocument("::::tabs\n\n:::tab[甲]\n\n甲的内容\n\n:::\n\n:::tab[乙]\n\n乙的内容\n\n:::\n\n::::");
    const tabs = within(body).getAllByRole("tab");
    expect(tabs.map(tab => [tab.textContent, tab.getAttribute("aria-selected"), tab.tabIndex])).toEqual([["甲", "true", 0], ["乙", "false", -1]]);
    expect(within(body).getByRole("tabpanel").textContent).toContain("甲的内容");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(within(body).getByRole("tabpanel").textContent).toContain("乙的内容");
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("follow each other in a group by label, whatever their number and order", async () => {
    const { body } = await renderDocument([
      '::::tabs{group="os"}\n\n:::tab[macOS]\n\n苹果\n\n:::\n\n:::tab[Windows]\n\n视窗\n\n:::\n\n::::',
      '::::tabs{group="os"}\n\n:::tab[Linux]\n\n企鹅\n\n:::\n\n:::tab[Windows]\n\n视窗二\n\n:::\n\n:::tab[macOS]\n\n苹果二\n\n:::\n\n::::'
    ].join("\n\n"));
    const [first, second] = within(body).getAllByRole("tablist").map(list => within(list).getAllByRole("tab"));
    const selected = (tabs: HTMLElement[]) => tabs.find(tab => tab.getAttribute("aria-selected") === "true")!.textContent;
    fireEvent.click(first!.find(tab => tab.textContent === "Windows")!);
    await waitFor(() => expect(selected(second!)).toBe("Windows"));
    fireEvent.click(second!.find(tab => tab.textContent === "Linux")!);
    await waitFor(() => expect(selected(second!)).toBe("Linux"));
    // The first has no Linux, so it stays where it was.
    expect(selected(first!)).toBe("Windows");
  });

  it("open what hides the target of a link to it", async () => {
    const { body } = await renderDocument("::::tabs\n\n:::tab[甲]\n\n甲的内容\n\n:::\n\n:::tab[乙]\n\n### 乙的小节\n\n乙的内容\n\n:::\n\n::::\n\n:::details[更多]\n\n### 折叠的小节\n\n折叠的内容\n\n:::");
    const { revealTarget } = await import("../src/markdown/reveal");
    const inTab = body.querySelector("h3")!;
    act(() => revealTarget(inTab));
    expect(inTab.closest("[role=tabpanel]")!.className).toContain("rp-tabs__content__item--active");
    const folded = body.querySelectorAll("h3")[1]!;
    expect(folded.closest("details")!.open).toBe(false);
    act(() => revealTarget(folded));
    expect(folded.closest("details")!.open).toBe(true);
  });

  it("print folded blocks open, and fold them again afterwards", async () => {
    const { usePrintsWhatIsFolded } = await import("../src/markdown/reveal");
    function Printing() {
      usePrintsWhatIsFolded();
      return null;
    }
    const { body } = await renderDocument(":::details[更多]\n\n折叠的内容\n\n:::");
    render(<Printing />);
    // As the theme lays out a page.
    body.classList.add("rp-doc");
    const details = body.querySelector("details")!;
    act(() => { window.dispatchEvent(new Event("beforeprint")); });
    expect(details.open).toBe(true);
    act(() => { window.dispatchEvent(new Event("afterprint")); });
    expect(details.open).toBe(false);
    // Saving as PDF prints again inside a print that has started, as a browser's own PDF does.
    act(() => { window.dispatchEvent(new Event("beforeprint")); });
    act(() => { window.dispatchEvent(new Event("beforeprint")); });
    act(() => { window.dispatchEvent(new Event("afterprint")); });
    expect(details.open).toBe(false);
  });
});

describe("the page's menu beside its title", () => {
  // The other actions on that row ask the server about the page.
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "" } }), { status: 404, headers: { "content-type": "application/json" } }))));
  afterEach(() => vi.unstubAllGlobals());

  it("is a menu with a name, opened and moved through from the keyboard", async () => {
    const { body } = await renderDocument("# 测试文档\n\n正文\n", "测试文档");
    const trigger = within(body).getByRole("button", { name: "此页更多操作" });
    expect(trigger.querySelector("a, [role=menuitem]")).toBeNull();
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map(item => item.textContent)).toEqual(["复制 Markdown 链接", "演示", "脑图", "查看源码", "导出 PDF"]);
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
  });
});

describe("a comment on text folded away", () => {
  const scrollIntoView = Element.prototype.scrollIntoView;
  const scrolled = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    scrolled.mockReset();
    Element.prototype.scrollIntoView = function (this: Element) { scrolled(this.textContent); };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  const scrollToText = async (body: HTMLElement, words: string) => {
    const { scrollToAnchor } = await import("../src/annotations/highlights");
    const text = squashWhitespace(domText(body));
    const at = text.indexOf(words);
    act(() => scrollToAnchor({ start: at, end: at + words.length }));
  };

  it("scrolls to it once a long prompt has finished opening, not to where the prompt starts", async () => {
    const items = Array.from({ length: 30 }, (_, index) => `${index + 1}. 核验${index + 1}`).join("\n");
    const { body } = await renderDocument(`\`\`\`prompt title="清单"\n${items}\n\`\`\``);
    await scrollToText(body, "核验30");
    await waitFor(() => expect(body.querySelector(".rp-prompt__content--collapsed")).toBeNull());
    // Still growing: a scroll now would stop where the prompt starts.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(scrolled).not.toHaveBeenCalled();
    act(() => { body.querySelector(".rp-prompt__content")!.dispatchEvent(new Event("transitionend")); });
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect(scrolled.mock.calls[0]![0]).toContain("核验30");
  });

  it("opens the tab it is in, and then scrolls", async () => {
    const { body } = await renderDocument("::::tabs\n\n:::tab[甲]\n\n甲的内容\n\n:::\n\n:::tab[乙]\n\n乙的内容在这里\n\n:::\n\n::::");
    await scrollToText(body, "乙的内容在这里");
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect(within(body).getByRole("tab", { name: "乙" }).getAttribute("aria-selected")).toBe("true");
  });
});
