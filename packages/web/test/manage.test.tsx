// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { canManage, manageableSpaces, managePages, manageSidebar, spaceManageRoute, spaceViews } from "../src/data/manage";
import { buildRoutes } from "../src/data/pages";
import { buildSiteData } from "../src/data/site";
import { dropTarget } from "../src/manage/pages-view";
import { entryOfItem } from "../src/theme/sidebar-actions";
import type { Role } from "../src/types";
import { bootstrap, entry, space } from "./support";

const withRole = (role: Role, isAdmin = false) => bootstrap({
  me: { id: "me", displayName: "测试用户", kind: "user", isAdmin, scopes: ["read", "write"] },
  spaces: [{ ...space("handbook", [entry("guide")]), role }]
});

describe("who sees which management pages", () => {
  const paths = (role: Role, isAdmin = false) => managePages(withRole(role, isAdmin), "").map(page => page.path);

  it("gives a reader their notifications and nothing to manage", () => {
    expect(paths("viewer")).toEqual(["/_/inbox", "/_/drafts", "/_/account", "/_/api", "/_/spaces"]);
    expect(canManage(withRole("viewer"))).toBe(false);
  });

  it("gives an editor the pages of the space, without its members or record", () => {
    expect(paths("editor")).toEqual(["/_/inbox", "/_/drafts", "/_/account", "/_/api", "/_/spaces", "/_/spaces/handbook/pages", "/_/spaces/handbook/change-sets", "/_/spaces/handbook/templates", "/_/spaces/handbook/insights", "/_/spaces/handbook/imports", "/_/spaces/handbook/trash"]);
    expect(canManage(withRole("editor"))).toBe(true);
  });

  it("gives a space admin all of it, and the site only to site administrators", () => {
    expect(paths("admin")).toContain("/_/spaces/handbook/members");
    expect(paths("admin")).toContain("/_/spaces/handbook/audit");
    expect(paths("admin")).toContain("/_/spaces/handbook/git-sync");
    expect(paths("admin")).not.toContain("/_/site");
    expect(paths("viewer", true)).toEqual(expect.arrayContaining(["/_/site", "/_/audit"]));
    expect(canManage(withRole("viewer", true))).toBe(true);
  });

  it("uses the theme's sidebar as the navigation, under its own address", () => {
    expect(manageableSpaces(withRole("editor")).map(space => space.slug)).toEqual(["handbook"]);
    expect(spaceViews({ role: "editor" }).map(item => item.view)).toContain("pages");
    expect(manageSidebar(withRole("editor"), "").map(item => ("link" in item ? item.link : null))).toContain("/_/spaces");
    const site = buildSiteData(withRole("editor")) as unknown as { themeConfig: { locales: { sidebar: Record<string, unknown> }[] } };
    expect(Object.keys(site.themeConfig.locales[0]!.sidebar)).toEqual(expect.arrayContaining(["/handbook/", "/_/"]));
  });
});

describe("a site with no spaces yet", () => {
  const home = async (isAdmin: boolean) => {
    const data = bootstrap({ spaces: [], me: { id: "me", displayName: "测试用户", kind: "user", isAdmin, scopes: ["read", "write"] } });
    const route = buildRoutes(data).find(item => item.path === "/") as unknown as { preload: () => Promise<{ frontmatter: Record<string, any> }> };
    return (await route.preload()).frontmatter;
  };

  it("shows an administrator what to do first", async () => {
    const frontmatter = await home(true);
    expect(frontmatter.hero.tagline).toContain("还没有空间");
    expect(frontmatter.hero.actions).toEqual([
      { theme: "brand", text: "新建空间", link: "/_/spaces?new=1" },
      { theme: "alt", text: "导入示例文档", link: "/_/spaces?sample=1" }
    ]);
  });

  it("tells anyone else who to ask, with nothing to click", async () => {
    const frontmatter = await home(false);
    expect(frontmatter.hero.tagline).toContain("管理员");
    expect(frontmatter.hero.actions).toEqual([]);
  });
});

describe("a space's front page", () => {
  const home = async (tree: ReturnType<typeof entry>[], role: Role = "viewer") => {
    const data = bootstrap({ spaces: [{ ...space("handbook", tree), role }] });
    const route = buildRoutes(data).find(item => item.path === "/handbook/") as unknown as { preload: () => Promise<{ frontmatter: Record<string, any> }> };
    return (await route.preload()).frontmatter;
  };

  it("is the home layout built from the top level of the tree", async () => {
    const frontmatter = await home([entry("a", { id: "a", title: "第一章" }), entry("a/b", { id: "b", parentId: "a", title: "第一节" }), entry("c", { id: "c", title: "第二章" })]);
    expect(frontmatter.pageType).toBe("home");
    expect(frontmatter.hero.name).toBe("handbook 空间");
    expect(frontmatter.hero.actions).toEqual([{ theme: "brand", text: "开始阅读", link: "/handbook/a" }]);
    expect(frontmatter.features.map((item: { title: string; details: string; span: number }) => [item.title, item.details, item.span])).toEqual([["第一章", "第一节", 6], ["第二章", "", 6]]);
  });

  it("offers editors the way in, and an empty space a way to start", async () => {
    expect((await home([entry("a")], "editor")).hero.actions.map((action: { text: string }) => action.text)).toEqual(["开始阅读", "管理目录"]);
    const empty = await home([], "editor");
    expect(empty.hero.actions).toEqual([{ theme: "brand", text: "新建文档", link: "/_/spaces/handbook/pages?new=1" }]);
    expect(empty.hero.tagline).toContain("还没有文档");
  });

  it("gives way to a page written at the index path", () => {
    const data = bootstrap({ spaces: [space("handbook", [entry("index")])] });
    const routes = buildRoutes(data).filter(item => item.path === "/handbook/") as unknown as { filePath: string }[];
    expect(routes.map(route => route.filePath)).toEqual(["handbook/index.doc"]);
    expect((routes[0] as unknown as { preload: () => unknown }).preload).toBeTypeOf("function");
  });
});

describe("dropping a page in the tree", () => {
  const tree = [
    entry("a", { id: "a" }),
    entry("a/x", { id: "x", parentId: "a" }),
    entry("a/y", { id: "y", parentId: "a" }),
    entry("b", { id: "b" }),
    entry("c", { id: "c" })
  ];
  const by = (id: string) => tree.find(item => item.id === id)!;

  it("goes inside, before or after the page it lands on", () => {
    expect(dropTarget(tree, by("c"), by("a"), "inside")).toEqual({ parentId: "a", beforeId: null });
    expect(dropTarget(tree, by("c"), by("a"), "before")).toEqual({ parentId: null, beforeId: "a" });
    expect(dropTarget(tree, by("c"), by("a"), "after")).toEqual({ parentId: null, beforeId: "b" });
    expect(dropTarget(tree, by("b"), by("x"), "after")).toEqual({ parentId: "a", beforeId: "y" });
  });

  it("goes last when nothing comes after, not counting the page itself", () => {
    expect(dropTarget(tree, by("x"), by("y"), "after")).toEqual({ parentId: "a", beforeId: null });
    expect(dropTarget(tree, by("c"), by("b"), "after")).toEqual({ parentId: null, beforeId: null });
  });

  it("cannot land on itself or below itself", () => {
    expect(dropTarget(tree, by("a"), by("a"), "inside")).toBeNull();
    expect(dropTarget(tree, by("a"), by("x"), "before")).toBeNull();
  });
});

describe("finding the page behind a sidebar item", () => {
  const data = space("handbook", [
    entry("index", { id: "home" }),
    entry("章节/第一节", { id: "first" }),
    entry("章节", { id: "section", title: "章节", hasContent: false })
  ]);
  const item = (html: string) => {
    const box = document.createElement("div");
    box.innerHTML = html;
    return box.firstElementChild!;
  };

  it("reads the link, whichever way it is encoded", () => {
    expect(entryOfItem(item(`<a class="rp-sidebar-item" href="/handbook/${encodeURIComponent("章节")}/${encodeURIComponent("第一节")}"></a>`), data, "")?.id).toBe("first");
    expect(entryOfItem(item('<a class="rp-sidebar-item" href="/handbook/"></a>'), data, "")?.id).toBe("home");
    expect(entryOfItem(item('<div class="rp-sidebar-item"><a href="/en/handbook/"></a></div>'), data, "/en")?.id).toBe("home");
  });

  it("falls back to the text for a heading that has no page to link to", () => {
    expect(entryOfItem(item('<div class="rp-sidebar-section-header">章节</div>'), data, "")?.id).toBe("section");
    expect(entryOfItem(item('<div class="rp-sidebar-section-header">别的</div>'), data, "")).toBeUndefined();
  });

  it("ignores links out of the space", () => {
    expect(entryOfItem(item('<a class="rp-sidebar-item" href="/other/page"></a>'), data, "")).toBeUndefined();
  });
});
