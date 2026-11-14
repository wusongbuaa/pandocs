// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "hast";
import { applyBootstrap } from "../src/data/bootstrap";
import { buildRoutes } from "../src/data/pages";
import { sidebarOf } from "../src/data/site";
import { rehypeGlossary } from "../src/markdown/glossary";
import { renderMarkdown } from "../src/markdown/pipeline";
import { planTranslation } from "../src/review/translation-notice";
import { onSearch, pinyinMatches } from "../src/search/pinyin";
import { bootstrap, entry, space } from "./support";

const GLOSSARY = [
  { term: "智能体", definition: "替你完成开发的 AI" },
  { term: "智能体会话", definition: "和智能体的一次对话" },
  { term: "API", definition: "应用接口" }
];

const glossed = (tree: Root) => {
  rehypeGlossary(GLOSSARY)(tree);
  return tree;
};

const paragraph = (value: string): Root => ({
  type: "root",
  children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value }] }]
});
const abbrs = (tree: Root) => JSON.stringify(tree).match(/"tagName":"abbr"/gu)?.length ?? 0;
const textOf = (node: unknown): string => {
  const item = node as { type: string; value?: string; children?: unknown[] };
  return item.type === "text" ? (item.value ?? "") : (item.children ?? []).map(textOf).join("");
};

describe("the glossary", () => {
  it("marks the first use of a term and leaves the text exactly as it was", () => {
    const tree = glossed(paragraph("智能体很有用，智能体很快"));
    expect(abbrs(tree)).toBe(1);
    expect(textOf(tree)).toBe("智能体很有用，智能体很快");
    expect(JSON.stringify(tree)).toContain('"data-definition":"替你完成开发的 AI"');
  });

  it("prefers the longer term", () => {
    expect(JSON.stringify(glossed(paragraph("打开智能体会话")))).toContain("和智能体的一次对话");
  });

  it("matches whole Latin words, in any case", () => {
    expect(abbrs(glossed(paragraph("RAPID 和 APIS")))).toBe(0);
    const tree = glossed(paragraph("调用 api 接口"));
    expect(abbrs(tree)).toBe(1);
    expect(textOf(tree)).toBe("调用 api 接口");
  });

  it("marks several different terms in one sentence", () => {
    const tree = glossed(paragraph("前面智能体中间API后面"));
    expect(abbrs(tree)).toBe(2);
    expect(textOf(tree)).toBe("前面智能体中间API后面");
  });

  it("stays out of headings, links and code", async () => {
    const { hast } = await renderMarkdown("# 智能体\n\n[智能体](https://x) `智能体`\n\n正文的智能体\n", {
      title: "",
      glossary: GLOSSARY
    });
    expect(abbrs(hast)).toBe(1);
    expect(JSON.stringify(hast)).toContain('"children":[{"type":"text","value":"智能体"}]');
  });

  it("does nothing without terms", () => {
    const tree = paragraph("智能体");
    rehypeGlossary([])(tree);
    expect(abbrs(tree)).toBe(0);
  });
});

describe("searching titles by pronunciation", () => {
  // The search adds pages with exactly what was typed from the site's index, which has nothing in it here.
  beforeEach(() =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([]))
    )
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    applyBootstrap(bootstrap());
  });

  const withTitles = () =>
    applyBootstrap(
      bootstrap({
        spaces: [
          space("handbook", [
            entry("a", { title: "认证与权限" }),
            entry("b", { title: "Quick Start" }),
            entry("c", { title: "新建任务" })
          ])
        ]
      })
    );

  it("finds a page by its full pinyin or its initials", async () => {
    withTitles();
    expect((await pinyinMatches("renzheng", "zh", "")).map(item => item.title)).toEqual(["认证与权限"]);
    expect((await pinyinMatches("rz", "zh", "")).map(item => item.title)).toEqual(["认证与权限"]);
    expect((await pinyinMatches("xinjian", "zh", "")).map(item => item.link)).toEqual(["/handbook/c"]);
  });

  it("does not load anything for a query in Chinese", async () => {
    withTitles();
    expect(await pinyinMatches("认证", "zh", "")).toEqual([]);
    expect(await pinyinMatches("x", "zh", "")).toEqual([]);
  });

  it("adds to what the theme found, without repeating it", async () => {
    withTitles();
    const matched = [
      {
        group: "站内",
        renderType: "default",
        result: [
          {
            type: "content",
            title: "认证与权限",
            header: "",
            link: "/handbook/a#x",
            query: "rz",
            highlightInfoList: [],
            statement: ""
          }
        ]
      }
    ];
    await onSearch("xj", matched as never);
    expect(matched[0]!.result.map(item => item.link)).toEqual(["/handbook/c", "/handbook/a#x"]);
    await onSearch("rz", matched as never);
    expect(matched[0]!.result.filter(item => item.link.startsWith("/handbook/a"))).toHaveLength(1);
  });
});

describe("searching for exactly what was typed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    applyBootstrap(bootstrap());
  });

  it("finds a page whose title or text has it, where the theme's index came up with others", async () => {
    applyBootstrap(
      bootstrap({ searchIndexHash: "h1", spaces: [space("manual", [entry("case-0598"), entry("case-0599")])] })
    );
    const index = [598, 599].map(n => ({
      id: n,
      title: `案例 0${n}`,
      routePath: `/manual/case-0${n}`,
      toc: [],
      content: `处理步骤。检索码 QA-SCENARIO-0${n}-END。`,
      frontmatter: {},
      lang: "zh",
      version: ""
    }));
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(url);
        return Response.json(index);
      })
    );
    // What the theme's own index gave for these: its neighbours, which only share the first three digits.
    const near = (query: string) => [
      {
        group: "站内",
        renderType: "default",
        result: [
          {
            type: "content",
            title: "案例 0590",
            header: "",
            link: "/manual/case-0590#x",
            query,
            highlightInfoList: [],
            statement: ""
          }
        ]
      }
    ];
    const byCode = near("QA-SCENARIO-0599-END");
    await onSearch("QA-SCENARIO-0599-END", byCode as never);
    expect(byCode[0]!.result.map(item => item.link)).toContain("/manual/case-0599");
    expect(byCode[0]!.result.map(item => item.link)).not.toContain("/manual/case-0598");
    const byTitle = near("0599");
    await onSearch("0599", byTitle as never);
    expect(byTitle[0]!.result.map(item => item.link)).toContain("/manual/case-0599");
    expect(asked).toEqual(["/api/v1/static/search_index.zh.h1.json"]);
  });
});

describe("planning a page's translation", () => {
  it("groups blocks into calls and keeps what is not prose as written", () => {
    const markdown = "第一段\n\n第二段\n\n```ts\nconst a = 1;\n```\n\n第三段\n\n$$\nx^2\n$$\n";
    const { steps, tooLong } = planTranslation(markdown);
    expect(tooLong).toBe(0);
    expect(steps).toEqual([
      { from: "b1", to: "b2" },
      { keep: "```ts\nconst a = 1;\n```" },
      { from: "b4", to: "b4" },
      { keep: "$$\nx^2\n$$" }
    ]);
  });

  it("starts a new call when a run would get too long", () => {
    const long = "字".repeat(1500);
    expect(planTranslation(`${long}\n\n${long}\n\n短\n`).steps).toEqual([
      { from: "b1", to: "b1" },
      { from: "b2", to: "b3" }
    ]);
  });

  it("leaves a block too long for one call in the source language, and says so", () => {
    const huge = "字".repeat(4000);
    const { steps, tooLong } = planTranslation(`短\n\n${huge}\n`);
    expect(tooLong).toBe(1);
    expect(steps).toEqual([{ from: "b1", to: "b1" }, { keep: huge }]);
  });
});

describe("a page in another language", () => {
  const data = bootstrap({
    site: {
      locales: [
        { lang: "zh", label: "简体中文" },
        { lang: "en", label: "English" }
      ]
    },
    spaces: [
      space("handbook", [
        entry("guide", { id: "11111111-1111-4111-8111-111111111111", title: "指南", titles: { en: "Guide" } }),
        entry("other", { title: "其他" })
      ])
    ]
  });
  const load = async (path: string) =>
    (
      buildRoutes(data).find(route => route.path === path) as unknown as { preload: () => Promise<Record<string, any>> }
    ).preload();
  const source = {
    document: { id: "11111111-1111-4111-8111-111111111111", title: "指南" },
    role: "editor",
    markdown: "原文内容\n",
    revision: { no: 2, createdAt: "2026-11-06T00:00:00Z" },
    blocks: []
  };

  afterEach(() => vi.unstubAllGlobals());

  const stubApi = (translation: object | null) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/translations/"))
          return translation
            ? Response.json({ data: translation })
            : Response.json({ error: { code: "NOT_FOUND", message: "x" } }, { status: 404 });
        return Response.json({ data: source });
      })
    );

  it("reads the translation, with everything tied to the source's text switched off", async () => {
    stubApi({ lang: "en", title: "Guide", markdown: "English text\n", sourceRevision: 1, stale: true, machine: true });
    const { title, pandocs } = await load("/en/handbook/guide");
    expect(title).toBe("Guide");
    expect(pandocs.view.markdown).toBe("English text\n");
    expect(pandocs.view.role).toBe("viewer");
    expect(pandocs.translation).toEqual({
      lang: "en",
      label: "English",
      exists: true,
      stale: true,
      machine: true,
      canEdit: true
    });
  });

  it("falls back to the source when nobody has translated it", async () => {
    stubApi(null);
    const { title, pandocs } = await load("/en/handbook/other");
    expect(title).toBe("指南");
    expect(pandocs.view.markdown).toBe("原文内容\n");
    expect(pandocs.view.role).toBe("editor");
    expect(pandocs.translation).toMatchObject({ exists: false, canEdit: true });
  });

  it("reads the source without asking for a translation in the source language", async () => {
    stubApi(null);
    const { pandocs } = await load("/handbook/guide");
    expect(pandocs.translation).toBeNull();
    expect(
      (fetch as unknown as { mock: { calls: string[][] } }).mock.calls.some(([url]) => url!.includes("/translations/"))
    ).toBe(false);
  });

  it("shows translated titles in that language's sidebar only", () => {
    const handbook = data.spaces[0]!;
    expect(sidebarOf(handbook, "/en", "en")).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Guide" }), expect.objectContaining({ text: "其他" })])
    );
    expect(sidebarOf(handbook, "", "zh")).toEqual(expect.arrayContaining([expect.objectContaining({ text: "指南" })]));
  });
});
