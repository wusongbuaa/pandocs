import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialRedirect } from "../src/data/bootstrap";
import { asEditable, buildPages, buildRoutes, recentPages } from "../src/data/pages";
import { buildSiteData, sidebarOf } from "../src/data/site";
import { bootstrap, entry, space } from "./support";

beforeEach(() => {
  vi.stubGlobal("location", { origin: "https://docs.example.test" });
});

describe("what the theme would have got from Rspress's build", () => {
  it("shows a page that only holds children as a heading, and one with content as a group", () => {
    const tree = [
      entry("index"),
      entry("start", { id: "start", hasContent: false }),
      entry("start/login", { parentId: "start" }),
      entry("daily", { id: "daily" }),
      entry("daily/task", { parentId: "daily" })
    ];
    expect(sidebarOf(space("handbook", tree), "")).toEqual([
      { text: "index", link: "/handbook/" },
      { sectionHeaderText: "start" },
      { text: "start/login", link: "/handbook/start/login" },
      {
        text: "daily",
        link: "/handbook/daily",
        items: [{ text: "daily/task", link: "/handbook/daily/task" }],
        collapsible: true,
        collapsed: false
      }
    ]);
  });

  it("lists spaces in the nav until the site configures its own", () => {
    const auto = buildSiteData(bootstrap()).themeConfig.locales![0]!.nav as { text: string; link: string }[];
    expect(auto).toEqual([expect.objectContaining({ text: "handbook 空间", link: "/handbook/" })]);
    const own = buildSiteData(bootstrap({ site: { nav: [{ text: "博客", link: "https://blog.example.test" }] } }))
      .themeConfig.locales![0]!.nav;
    expect(own).toEqual([{ text: "博客", link: "https://blog.example.test" }]);
  });

  it("puts the spaces that do not fit in the top bar under one more item, rather than wrapping every name", () => {
    const named = (...names: string[]) =>
      bootstrap({ spaces: names.map((name, index) => ({ ...space(`s${index}`, []), name })) });
    const nav = (names: string[]) =>
      buildSiteData(named(...names)).themeConfig.locales![0]!.nav as {
        text: string;
        link?: string;
        items?: { text: string }[];
      }[];
    const many = Array.from({ length: 12 }, (_, index) => `星河物流 · 空间${index + 1}`);
    const listed = nav(many);
    expect(listed.at(-1)).toMatchObject({ text: "更多空间" });
    expect([...listed.slice(0, -1).map(item => item.text), ...listed.at(-1)!.items!.map(item => item.text)]).toEqual(
      many
    );
    expect(listed.length).toBeLessThan(5);
    // A few short ones are all in the bar, and one name too long for it goes in the list on its own.
    expect(nav(["手册", "接口", "常见问题"]).map(item => item.text)).toEqual(["手册", "接口", "常见问题"]);
    expect(
      nav(["星河物流客户使用指南与离线现场手册合订本以及大型知识库场景说明和附录"]).map(item => [
        item.text,
        item.items?.length
      ])
    ).toEqual([["空间", 1]]);
  });

  it("shows Pandocs' own logo until a site sets its own", () => {
    expect(buildSiteData(bootstrap({ site: { logo: "" } })).logo).toBe("/logo.svg");
    expect(buildSiteData(bootstrap({ site: { logo: "https://example.test/brand.png" } })).logo).toBe(
      "https://example.test/brand.png"
    );
  });

  it("leaves a root-relative logo as it is, the same wherever the page gets rendered", () => {
    const data = buildSiteData(bootstrap({ site: { logo: "/brand.png" } }));
    expect(data.logo).toBe("/brand.png");
    expect(data.base).toBe("/");
  });

  it("leaves chat services out of the page menu, since they cannot read pages behind a login", () => {
    const options = (
      buildSiteData(bootstrap()).themeConfig.llmsUI as { viewOptions: readonly (string | { title: string })[] }
    ).viewOptions;
    expect(options.map(option => (typeof option === "string" ? option : option.title))).toEqual([
      "markdownLink",
      "演示",
      "脑图",
      "查看源码",
      "导出 PDF"
    ]);
  });

  it("builds no second language unless the site turns one on, and the same pages under its prefix if it does", () => {
    const single = bootstrap();
    const contentRoutes = (routes: ReturnType<typeof buildRoutes>) =>
      routes.map(route => route.path).filter(path => !path.includes("/_/"));
    expect(contentRoutes(buildRoutes(single))).toEqual(["/", "/handbook/", "/handbook/guide"]);
    expect(buildSiteData(single).locales).toHaveLength(1);
    const both = bootstrap({
      site: {
        locales: [
          { lang: "zh", label: "简体中文" },
          { lang: "en", label: "English" }
        ]
      }
    });
    expect(contentRoutes(buildRoutes(both))).toEqual([
      "/",
      "/handbook/",
      "/handbook/guide",
      "/en/",
      "/en/handbook/",
      "/en/handbook/guide"
    ]);
    expect(
      buildPages(both)
        .filter(page => page.lang === "en")
        .map(page => page.routePath)
    ).toContain("/en/handbook/guide");
    const sidebars = buildSiteData(both).themeConfig.locales!.map(locale => Object.keys(locale.sidebar));
    expect(sidebars).toEqual([
      ["/handbook/", "/_/"],
      ["/en/handbook/", "/en/_/"]
    ]);
  });

  it("gives a space without a front page the theme's home layout", async () => {
    const routes = buildRoutes(bootstrap({ spaces: [space("handbook", [entry("guide")])] }));
    const root = routes.find(route => route.path === "/handbook/")!;
    await expect((root.preload as () => Promise<unknown>)()).resolves.toMatchObject({
      pandocs: { kind: "home" },
      frontmatter: { pageType: "home" }
    });
  });

  it("gives the site's front page its logo, a way in, and each space with what it holds", async () => {
    const spaces = [
      space("handbook", [entry("index"), entry("guide"), entry("empty", { hasContent: false })]),
      { ...space("finance", [entry("budget")]), description: "预算和报销" }
    ];
    const front = async (isAdmin: boolean) => {
      const base = bootstrap({ spaces });
      const routes = buildRoutes({ ...base, me: { ...base.me, isAdmin } });
      return (
        routes.find(route => route.path === "/")!.preload as unknown as () => Promise<{
          frontmatter: any;
          pandocs: unknown;
        }>
      )();
    };
    const reader = await front(false);
    expect(reader.pandocs).toEqual({ kind: "home", site: true });
    expect(reader.frontmatter.hero.image).toEqual({ src: "/logo.svg", alt: "" });
    expect(reader.frontmatter.hero.actions).toEqual([{ theme: "brand", text: "开始阅读", link: "/handbook/" }]);
    expect(
      reader.frontmatter.features.map((feature: { title: string; details: string; span: number }) => [
        feature.title,
        feature.details,
        feature.span
      ])
    ).toEqual([
      ["handbook 空间", "2 个页面", 6],
      ["finance 空间", "预算和报销", 6]
    ]);
    expect((await front(true)).frontmatter.hero.actions.map((action: { text: string }) => action.text)).toEqual([
      "开始阅读",
      "管理空间"
    ]);
  });

  it("lists what was saved last first, across spaces, leaving out headings with nothing in them", () => {
    const at = (day: number) => `2026-11-0${day}T08:00:00.000Z`;
    const spaces = [
      space("a", [
        entry("old", { updatedAt: at(1) }),
        entry("newest", { updatedAt: at(5) }),
        entry("heading", { updatedAt: at(9), hasContent: false })
      ]),
      space("b", [entry("middle", { updatedAt: at(3) })])
    ];
    expect(recentPages(spaces).map(({ space: owner, entry: page }) => `${owner.slug}/${page.path}`)).toEqual([
      "a/newest",
      "b/middle",
      "a/old"
    ]);
    expect(recentPages(spaces, 1)).toHaveLength(1);
  });

  it("goes straight into the only space, and shows the choice when there are more", () => {
    expect(initialRedirect(bootstrap(), "/")).toBe("/handbook/");
    expect(initialRedirect(bootstrap(), "/handbook/")).toBeNull();
    expect(initialRedirect(bootstrap({ spaces: [space("a", []), space("b", [])] }), "/")).toBeNull();
  });
});

describe("a page written as a front page", () => {
  const written = {
    pageType: "home",
    frontmatter: { pageType: "home", hero: { name: "现场手册" } },
    pandocs: { kind: "document" }
  };

  it("is shown as a document while it is edited, so that the editor has somewhere to be", () => {
    expect(asEditable(written, "edit")).toMatchObject({
      pageType: "doc",
      frontmatter: { pageType: "doc", hero: { name: "现场手册" } }
    });
    expect(asEditable(written, null)).toBe(written);
    const nobodyWroteIt = { ...written, pandocs: { kind: "home" } };
    expect(asEditable(nobodyWroteIt, "edit")).toBe(nobodyWroteIt);
  });
});
