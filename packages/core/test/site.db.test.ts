import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { BASE, createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();

describe("site settings and the app's bootstrap", () => {
  let h: ReturnType<typeof createHarness>;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString(), { siteDefaults: { title: "宿主文档", logo: "/brand.png" } });
    await h.call(USERS.admin, "POST", "spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "secret", name: "内部", defaultRole: "none" });
    await h.call(USERS.admin, "POST", "spaces/handbook/documents", {
      title: "首页",
      slug: "index",
      markdown: "欢迎\n"
    });
    await h.call(USERS.admin, "POST", "spaces/handbook/documents", {
      title: "入门",
      slug: "start",
      markdown: "::subpages\n"
    });
    await h.call(USERS.admin, "POST", "spaces/handbook/documents", {
      title: "安装",
      slug: "install",
      parentPath: "start",
      markdown: "# 下载\n\n从发布页下载\n\n## 升级\n\n覆盖旧文件\n"
    });
    await h.call(USERS.admin, "POST", "spaces/handbook/documents", {
      title: "管理员页",
      slug: "admin",
      markdown: "只有管理员能看\n",
      restricted: true
    });
    await h.call(USERS.admin, "POST", "spaces/secret/documents", { title: "机密", markdown: "机密内容\n" });
  });
  afterAll(async () => {
    expect(h.errors).toEqual([]);
    await h.close();
  });

  it("takes the host's defaults until an administrator stores something else", async () => {
    expect((await h.call(USERS.reader, "GET", "site")).data).toMatchObject({
      title: "宿主文档",
      logo: "/brand.png",
      defaultLang: "en",
      nav: null
    });
    expect((await h.call(USERS.reader, "PATCH", "site", { title: "别的名字" })).status).toBe(403);
    const updated = await h.call(USERS.admin, "PATCH", "site", {
      title: "团队文档",
      socialLinks: [{ icon: "github", link: "https://example.test/repo" }]
    });
    expect(updated.status).toBe(200);
    expect(updated.data).toMatchObject({ title: "团队文档", logo: "/brand.png", socialLinks: [{ icon: "github" }] });
    expect((await h.call(USERS.admin, "PATCH", "site", { footer: "页脚" })).data).toMatchObject({
      title: "团队文档",
      footer: "页脚"
    });
    expect((await h.call(USERS.admin, "PATCH", "site", { locales: [] })).status).toBe(422);
    // No page can be rendered in a language the site does not have, so this cannot be how it ends up.
    expect((await h.call(USERS.admin, "PATCH", "site", { defaultLang: "zh" })).status).toBe(422);
    expect((await h.call(USERS.admin, "GET", "site")).data.defaultLang).toBe("en");
    expect((await h.call(USERS.admin, "PATCH", "site", { locales: [{ lang: "zh", label: "简体中文" }] })).status).toBe(
      422
    );
    expect((await h.call(USERS.admin, "GET", "site")).data.locales).toEqual([{ lang: "en", label: "English" }]);
    expect(
      (await h.call(USERS.admin, "PATCH", "site", { defaultLang: "zh", locales: [{ lang: "zh", label: "简体中文" }] }))
        .status
    ).toBe(200);
    expect(
      (await h.call(USERS.admin, "PATCH", "site", { defaultLang: "en", locales: [{ lang: "en", label: "English" }] }))
        .status
    ).toBe(200);
  });

  it("forgets fields an older version stored, so the settings page can still save", async () => {
    await h.pool.query(
      `UPDATE pandocs.site_settings SET settings = settings || '{"retiredField": {"handbook": {"label": "旧", "href": "https://example.test"}}}'`
    );
    const stored = (await h.call(USERS.admin, "GET", "site")).data;
    expect(stored).not.toHaveProperty("retiredField");
    const saved = await h.call(USERS.admin, "PATCH", "site", stored);
    expect(saved.status).toBe(200);
    expect(saved.data).not.toHaveProperty("retiredField");
  });

  it("boots with the spaces and pages the person can read, and marks pages that only hold children", async () => {
    const { data } = await h.call(USERS.reader, "GET", "bootstrap");
    expect(data.me).toMatchObject({ id: USERS.reader.id, isAdmin: false });
    expect(data.spaces.map((space: { slug: string }) => space.slug)).toEqual(["handbook"]);
    const tree = data.spaces[0].tree as { path: string; hasContent: boolean }[];
    expect(tree.map(node => node.path).sort()).toEqual(["index", "start", "start/install"]);
    expect(tree.find(node => node.path === "start")?.hasContent).toBe(false);
    expect(tree.find(node => node.path === "start/install")?.hasContent).toBe(true);
    expect(data.searchIndexHash).toMatch(/^[a-f0-9]{12}$/u);
  });

  it("changes the index version when a page changes", async () => {
    const before = (await h.call(USERS.reader, "GET", "bootstrap")).data;
    const page = before.spaces[0].tree.find((node: { path: string }) => node.path === "index");
    await h.call(
      USERS.admin,
      "PUT",
      `documents/${page.id}/content`,
      { markdown: "欢迎光临\n", expectedRevision: page.currentRevisionNo },
      { "idempotency-key": "site-test-index-change" }
    );
    expect((await h.call(USERS.reader, "GET", "bootstrap")).data.searchIndexHash).not.toBe(before.searchIndexHash);
  });

  it("serves a search index that follows the same access rules", async () => {
    const read = (file: string) => h.handler(new Request(`http://pandocs.test${BASE}/static/${file}`), USERS.reader);
    const response = await read("search_index.en.abc123.json");
    expect(response.status).toBe(200);
    const pages = (await response.json()) as {
      title: string;
      routePath: string;
      content: string;
      toc: { id: string; text: string; charIndex: number }[];
      lang: string;
    }[];
    expect(pages.map(page => page.routePath).sort()).toEqual([
      "/handbook/",
      "/handbook/start",
      "/handbook/start/install"
    ]);
    expect(pages.some(page => page.content.includes("机密") || page.content.includes("只有管理员"))).toBe(false);
    const install = pages.find(page => page.routePath === "/handbook/start/install")!;
    expect(install.toc.map(header => header.text)).toEqual(["下载", "升级"]);
    expect(install.content.slice(install.toc[1]!.charIndex).startsWith("升级")).toBe(true);
    expect((await read("other.json")).status).toBe(404);
  });
});
