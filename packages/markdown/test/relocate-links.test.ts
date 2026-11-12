import { describe, expect, it } from "vitest";
import { relocateDocLinks, resolveDocLink } from "../src/index.js";

describe("relative links when a page moves", () => {
  const moved = (markdown: string, from = "a/x", to = "b/x", movedTo?: (path: string) => string) => relocateDocLinks(markdown, from, to, movedTo);

  it("keeps pointing at the same pages from the new place", () => {
    expect(moved("[同级](./y.md) 和 [上级](../c.md)\n")).toBe("[同级](../a/y.md) 和 [上级](../c.md)\n");
    expect(moved("[同级](./y.md)\n", "a/x", "x")).toBe("[同级](./a/y.md)\n");
    expect(moved("[顶层](../c.md)\n", "a/x", "b/d/x")).toBe("[顶层](../../c.md)\n");
    for (const [source, target] of [["../a/y.md", "a/y"], ["../c.md", "c"]] as const) expect(resolveDocLink("b/x", source)?.path).toBe(target);
  });

  it("follows a page that moved along with this one", () => {
    const along = (path: string) => (path.startsWith("a/x/") ? `b/x/${path.slice("a/x/".length)}` : path);
    expect(moved("[子页面](./x/child.md) [没动的](./y.md)\n", "a/x", "b/x", along)).toBe("[子页面](./x/child.md) [没动的](../a/y.md)\n");
    expect(moved("[上级的兄弟](../other.md)\n", "a/x/child", "b/x/child", along)).toBe("[上级的兄弟](../../a/other.md)\n");
  });

  it("leaves the text identical when nothing needs to change", () => {
    const source = "[同层](./y.md)\n\n正文\n";
    expect(relocateDocLinks(source, "a/x", "a/renamed")).toBe(source);
    expect(moved("没有链接\n")).toBe("没有链接\n");
  });

  it("keeps anchors, titles and reference-style links", () => {
    expect(moved('[锚点](./y.md#小节) [标题](./y.md "说明")\n')).toBe('[锚点](../a/y.md#小节) [标题](../a/y.md "说明")\n');
    expect(moved("[引用][r]\n\n[r]: ./y.md\n")).toBe("[引用][r]\n\n[r]: ../a/y.md\n");
  });

  it("reads encoded links and only touches the destination", () => {
    expect(moved(`[登录](./${encodeURIComponent("登录")}.md)\n`)).toBe("[登录](../a/登录.md)\n");
    expect(moved("[./y.md](./y.md)\n")).toBe("[./y.md](../a/y.md)\n");
  });

  it("does the same for a link to a page's address, written as it was", () => {
    expect(moved("[同级](./y) [上级](../c#小节) [裸写](y)\n")).toBe("[同级](../a/y) [上级](../c#小节) [裸写](../a/y)\n");
    expect(moved(':::card[甲]{href="./y"}\n\n说明\n\n:::\n')).toBe(':::card[甲]{href="../a/y"}\n\n说明\n\n:::\n');
    const elsewhere = "[文件](./report.pdf) [查询](./y?mode=edit) [目录](./guides/) [上一层](..)\n";
    expect(moved(elsewhere)).toBe(elsewhere);
  });

  it("leaves alone what is not a relative page link", () => {
    const source = "[外部](https://x.test/y.md) [根路径](/y.md) ![图](./y.md) [文件](./y.pdf) `[代码](./y.md)`\n\n```\n[代码块](./y.md)\n```\n";
    expect(moved(source)).toBe(source);
  });

  it("finds links inside containers and lists", () => {
    expect(moved(":::tip\n\n- [同级](./y.md)\n\n:::\n")).toBe(":::tip\n\n- [同级](../a/y.md)\n\n:::\n");
  });

  it("rewrites where a card points, not the card's words", () => {
    expect(moved(':::card[./y.md]{href="./y.md"}\n\n说明 [内联](./y.md)\n\n:::\n')).toBe(':::card[./y.md]{href="../a/y.md"}\n\n说明 [内联](../a/y.md)\n\n:::\n');
    expect(moved('::::cards\n\n:::card[甲]{href="./y.md#小节"}\n\n说明\n\n:::\n\n::::\n')).toBe('::::cards\n\n:::card[甲]{href="../a/y.md#小节"}\n\n说明\n\n:::\n\n::::\n');
    const elsewhere = ':::card[外部]{href="https://x.test/y.md"}\n\n说明\n\n:::\n';
    expect(moved(elsewhere)).toBe(elsewhere);
  });

  it("writes a destination Markdown can read back", () => {
    const rewritten = moved("[特殊](./y.md)\n", "a/x", "b/x", () => "a/(特殊) 名字");
    expect(rewritten).toBe("[特殊](../a/%28特殊%29%20名字.md)\n");
    expect(resolveDocLink("b/x", "../a/%28特殊%29%20名字.md")?.path).toBe("a/(特殊) 名字");
  });
});
