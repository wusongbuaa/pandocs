import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { BASE, createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();

describe("what a site offers beyond its pages", () => {
  const calls: { action: string; content: string; target?: string | undefined }[] = [];
  let h: ReturnType<typeof createHarness>;
  let space = "";
  let counter = 0;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString(), {
      llm: {
        complete: async () => "总结",
        assist: async ({ action, content, target }) => { calls.push({ action, content, target }); return `译：${content}`; }
      }
    });
    await h.call(USERS.admin, "PATCH", "site", { defaultLang: "zh", locales: [{ lang: "zh", label: "简体中文" }, { lang: "en", label: "English" }] });
  });
  afterAll(() => h.close());

  beforeEach(async () => {
    counter += 1;
    space = `content-${counter}`;
    calls.length = 0;
    await h.call(USERS.admin, "POST", "spaces", { slug: space, name: `内容 ${counter}`, description: "说明文字", defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", `spaces/${space}/members`, { subject: `user:${USERS.editor.id}`, role: "editor" });
  });

  const create = async (title: string, markdown: string, slug = title) => (await h.call(USERS.editor, "POST", `spaces/${space}/documents`, { title, slug, markdown })).data.document.id as string;
  const bodyOf = (result: { response: Response }) => result.response.text();

  describe("site settings", () => {
    it("refuse links that could run a script, in every list of links", async () => {
      for (const patch of [
        { nav: [{ text: "x", link: "javascript:alert(1)" }] },
        { socialLinks: [{ icon: "github", link: " JavaScript:alert(1)" }] },
        { appLinks: [{ text: "x", link: "data:text/html,x" }] },
        { actions: [{ id: "a", label: "x", href: "vbscript:x" }] },
        // Browsers leave these out when they read an address, so this is still what it looks like it is not.
        { nav: [{ text: "x", link: "java\tscript:alert(1)" }] },
        { socialLinks: [{ icon: "github", link: "\u0001javascript:alert(1)" }] },
        { appLinks: [{ text: "x", link: "jav\nascript:alert(1)" }] }
      ]) expect((await h.call(USERS.admin, "PATCH", "site", patch)).status, JSON.stringify(patch)).toBe(422);
      expect((await h.call(USERS.admin, "PATCH", "site", { nav: [{ text: "手册", link: "/handbook/" }, { text: "官网", link: "https://example.com" }] })).status).toBe(200);
      await h.call(USERS.admin, "PATCH", "site", { nav: null });
    });

    it("keep an uploaded logo", async () => {
      const logo = `data:image/png;base64,${"A".repeat(1000)}`;
      expect((await h.call(USERS.admin, "PATCH", "site", { logo })).data.logo).toBe(logo);
      expect((await h.call(USERS.admin, "PATCH", "site", { logo: "x".repeat(150_001) })).status).toBe(422);
      await h.call(USERS.admin, "PATCH", "site", { logo: "" });
    });
  });

  describe("glossary", () => {
    it("is kept with the space and only its admins change it", async () => {
      const glossary = [{ term: "智能体", definition: "替你完成开发的 AI" }];
      expect((await h.call(USERS.editor, "PATCH", `spaces/${space}`, { glossary })).status).toBe(403);
      expect((await h.call(USERS.admin, "PATCH", `spaces/${space}`, { glossary })).data.glossary).toEqual(glossary);
      expect((await h.call(USERS.reader, "GET", `spaces/${space}`)).data.glossary).toEqual(glossary);
      const { data } = await h.call(USERS.reader, "GET", "bootstrap");
      expect(data.spaces.find((item: { slug: string }) => item.slug === space).glossary).toEqual(glossary);
      expect((await h.call(USERS.admin, "PATCH", `spaces/${space}`, { glossary: [{ term: "", definition: "x" }] })).status).toBe(422);
      // Changing something else leaves it alone.
      expect((await h.call(USERS.admin, "PATCH", `spaces/${space}`, { name: "新名字" })).data.glossary).toEqual(glossary);
    });
  });

  describe("llms.txt", () => {
    it("lists what this person can read, with links relative to where it is served", async () => {
      await create("认识 Pandocs", "# 认识 Pandocs\n\n内容一\n", "intro");
      await h.call(USERS.admin, "POST", `spaces/${space}/documents`, { title: "受限", slug: "locked", markdown: "秘密内容\n", restricted: true });

      const index = await bodyOf(await h.call(USERS.reader, "GET", `spaces/${space}/llms.txt`));
      expect(index).toContain(`# 内容 ${counter}`);
      expect(index).toContain("> 说明文字");
      expect(index).toContain("- [认识 Pandocs](intro.md)");
      expect(index).not.toContain("受限");
      expect((await bodyOf(await h.call(USERS.admin, "GET", `spaces/${space}/llms.txt`)))).toContain("[受限](locked.md)");

      const site = await bodyOf(await h.call(USERS.reader, "GET", "llms.txt"));
      expect(site).toContain(`## 内容 ${counter}`);
      expect(site).toContain(`- [认识 Pandocs](${space}/intro.md)`);
    });

    it("lists pages in reading order, each followed by what is under it", async () => {
      await create("后面", "内容\n", "z");
      const parent = await create("前面", "内容\n", "a");
      await h.call(USERS.editor, "POST", `documents/${parent}/move`, { beforeId: (await h.call(USERS.editor, "GET", `spaces/${space}/tree`)).data[0].id });
      await h.call(USERS.editor, "POST", `spaces/${space}/documents`, { title: "子页面", slug: "c", parentPath: "a", markdown: "内容\n" });
      const index = await bodyOf(await h.call(USERS.reader, "GET", `spaces/${space}/llms.txt`));
      expect(index.match(/\[[^\]]+\]/gu)).toEqual(["[前面]", "[子页面]", "[后面]"]);
    });

    it("has everything in one file, titled once each", async () => {
      await create("第一页", "# 第一页\n\n内容一\n", "a");
      await create("第二页", "---\nouline: false\n---\n\n内容二\n", "b");
      const full = await bodyOf(await h.call(USERS.reader, "GET", `spaces/${space}/llms-full.txt`));
      expect(full.match(/# 第一页/gu)).toHaveLength(1);
      expect(full).toContain("# 第二页\n\n内容二");
      expect(full).not.toContain("ouline");
      expect((await h.call(USERS.stranger, "GET", "spaces/none/llms-full.txt")).status).toBe(404);
    });
  });

  describe("translations", () => {
    it("are kept beside the page, and say when the source has moved on", async () => {
      const id = await create("页面", "原文\n");
      expect((await h.call(USERS.reader, "GET", `documents/${id}/translations/en`)).status).toBe(404);
      expect((await h.call(USERS.reader, "PUT", `documents/${id}/translations/en`, { title: "Page", markdown: "Text\n", sourceRevision: 1 })).status).toBe(403);

      const saved = await h.call(USERS.editor, "PUT", `documents/${id}/translations/en`, { title: "Page", markdown: "Text\n", sourceRevision: 1, machine: true });
      expect(saved.data).toMatchObject({ lang: "en", title: "Page", stale: false, machine: true, updatedName: USERS.editor.displayName });
      expect((await h.call(USERS.reader, "GET", `documents/${id}/translations/en`)).data).toMatchObject({ markdown: "Text\n", stale: false });

      await h.write(USERS.editor, "PUT", `documents/${id}/content`, { markdown: "新的原文\n", expectedRevision: 1 });
      expect((await h.call(USERS.reader, "GET", `documents/${id}/translations/en`)).data.stale).toBe(true);
      expect((await h.call(USERS.reader, "GET", `documents/${id}/translations`)).data.map((item: { lang: string }) => item.lang)).toEqual(["en"]);

      expect((await h.call(USERS.editor, "DELETE", `documents/${id}/translations/en`)).status).toBe(200);
      expect((await h.call(USERS.reader, "GET", `documents/${id}/translations/en`)).status).toBe(404);
    });

    it("merge what two people changed in different places, and refuse to undo what someone changed in the same place", async () => {
      const id = await create("页面", "原文\n");
      const start = "One.\n\nTwo.\n";
      const first = (await h.call(USERS.editor, "PUT", `documents/${id}/translations/en`, { title: "Page", markdown: start, sourceRevision: 1 })).data;
      const base = { updatedAt: first.updatedAt, markdown: start, title: "Page" };
      expect((await h.call(USERS.editor, "PUT", `documents/${id}/translations/en`, { title: "Page", markdown: "One, charged first.\n\nTwo.\n", sourceRevision: 1, base })).status).toBe(200);
      expect((await h.call(USERS.admin, "PUT", `documents/${id}/translations/en`, { title: "Page", markdown: "One.\n\nTwo, with the driver.\n", sourceRevision: 1, base })).status).toBe(200);
      expect((await h.call(USERS.reader, "GET", `documents/${id}/translations/en`)).data.markdown).toBe("One, charged first.\n\nTwo, with the driver.\n");
      const clash = await h.call(USERS.admin, "PUT", `documents/${id}/translations/en`, { title: "Page", markdown: "One, otherwise.\n\nTwo.\n", sourceRevision: 1, base });
      expect(clash.error?.code).toBe("MERGE_CONFLICT");
      expect((await h.call(USERS.reader, "GET", `documents/${id}/translations/en`)).data.markdown).toBe("One, charged first.\n\nTwo, with the driver.\n");
    });

    it("only exist for languages the site has turned on, other than the source's", async () => {
      const id = await create("页面", "原文\n");
      const body = { title: "x", markdown: "y", sourceRevision: 1 };
      expect((await h.call(USERS.editor, "PUT", `documents/${id}/translations/ja`, body)).error.code).toBe("LANG_INVALID");
      expect((await h.call(USERS.editor, "PUT", `documents/${id}/translations/zh`, body)).error.code).toBe("LANG_INVALID");
      expect((await h.call(USERS.editor, "PUT", `documents/${id}/translations/en`, { ...body, sourceRevision: 9 })).error.code).toBe("REVISION_INVALID");
    });

    it("follow the page's visibility, and can show up as titles in the tree and in search", async () => {
      const id = await create("页面", "# 原标题\n\n原文内容\n");
      await h.call(USERS.editor, "PUT", `documents/${id}/translations/en`, { title: "Page", markdown: "## Heading\n\nEnglish words\n", sourceRevision: 1 });
      const tree = (await h.call(USERS.reader, "GET", `spaces/${space}/tree`)).data as { id: string; titles: Record<string, string> }[];
      expect(tree.find(node => node.id === id)?.titles).toEqual({ en: "Page" });

      const response = await h.handler(new Request(`http://pandocs.test${BASE}/static/search_index.en.abc.json`), USERS.reader);
      const index = await response.json() as { title: string; content: string; toc: { text: string }[]; routePath: string }[];
      const entry = index.find(item => item.routePath === `/en/${space}/页面`)!;
      expect(entry).toMatchObject({ title: "Page" });
      expect(entry.content).toContain("English words");
      expect(entry.toc.map(item => item.text)).toEqual(["Heading"]);

      await h.call(USERS.admin, "PATCH", `documents/${id}`, { restricted: true });
      expect((await h.call(USERS.reader, "GET", `documents/${id}/translations/en`)).status).toBe(404);
    });

    it("are what the API searches in their language, while pages without one are searched as written", async () => {
      const id = await create("退货", "退货在七天内办理\n");
      const other = await create("换货", "换货也在七天内办理\n");
      await h.call(USERS.editor, "PUT", `documents/${id}/translations/en`, { title: "Returns", markdown: "Returns within seven days\n", sourceRevision: 1 });
      const search = async (q: string, lang?: string) => (await h.call(USERS.reader, "GET", `search?q=${encodeURIComponent(q)}&space=${space}${lang ? `&lang=${lang}` : ""}`)).data as { id: string; title: string; snippet: string }[];
      expect((await search("seven days", "en")).map(hit => [hit.id, hit.title, hit.snippet])).toEqual([[id, "Returns", "Returns within seven days"]]);
      expect((await search("Returns", "en")).map(hit => hit.title)).toEqual(["Returns"]);
      // In English, the untranslated page is still found as written, and the translated one is not found by its original.
      expect((await search("七天", "en")).map(hit => hit.id)).toEqual([other]);
      // In the site's own language, or none given, pages are searched as written.
      for (const lang of [undefined, "zh"]) expect((await search("七天", lang)).map(hit => hit.id).sort()).toEqual([id, other].sort());
      expect(await search("seven days")).toEqual([]);
    });

    it("in the language the pages are written in, left from before the site changed its language, show up nowhere", async () => {
      const id = await create("页面", "原文内容\n");
      await h.call(USERS.editor, "PUT", `documents/${id}/translations/en`, { title: "Page", markdown: "English words\n", sourceRevision: 1 });
      const { data: site } = await h.call(USERS.admin, "GET", "site");
      await h.call(USERS.admin, "PATCH", "site", { defaultLang: "en" });
      try {
        const { data: bootstrap } = await h.call(USERS.reader, "GET", "bootstrap");
        const node = bootstrap.spaces.find((item: { slug: string }) => item.slug === space).tree.find((item: { id: string }) => item.id === id);
        expect(node.titles).toEqual({});
        const response = await h.handler(new Request(`http://pandocs.test${BASE}/static/search_index.en.abc.json`), USERS.reader);
        const entry = (await response.json() as { title: string; content: string; routePath: string }[]).find(item => item.routePath === `/${space}/页面`)!;
        expect(entry).toMatchObject({ title: "页面" });
        expect(entry.content).not.toContain("English words");
      } finally {
        await h.call(USERS.admin, "PATCH", "site", { defaultLang: site.defaultLang });
      }
    });

    it("are generated a run of blocks at a time, from the stored text, into the language asked for", async () => {
      const id = await create("页面", "第一段\n\n第二段\n\n第三段\n");
      const part = await h.call(USERS.editor, "POST", `documents/${id}/translations/en/generate`, { from: "b1", to: "b2" });
      expect(part.data.text).toBe("译：第一段\n\n第二段");
      expect(calls.at(-1)).toMatchObject({ action: "translate", target: "English" });
      expect((await h.call(USERS.editor, "POST", `documents/${id}/translations/en/generate`, { title: true })).data.text).toBe("译：页面");
      expect((await h.call(USERS.editor, "POST", `documents/${id}/translations/en/generate`, { from: "b9", to: "b9" })).error.code).toBe("BLOCK_NOT_FOUND");
      expect((await h.call(USERS.reader, "POST", `documents/${id}/translations/en/generate`, { title: true })).status).toBe(403);
      expect((await h.call(USERS.editor, "POST", `documents/${id}/translations/en/generate`, { content: "随便一段话" })).status).toBe(422);
    });

    it("refuse a run too long for one call instead of cutting it short", async () => {
      const id = await create("长页面", `${"字".repeat(3100)}\n`);
      const calledBefore = calls.length;
      expect((await h.call(USERS.editor, "POST", `documents/${id}/translations/en/generate`, { from: "b1", to: "b1" })).error.code).toBe("TRANSLATION_CHUNK_TOO_LONG");
      expect(calls).toHaveLength(calledBefore);
    });
  });
});

describe("hosts that replace the global Response", () => {
  it("still answers a save with its data, as HTTP libraries that patch the global do", async () => {
    await resetPandocs(fixture.getConnectionString());
    const h = createHarness(fixture.getConnectionString());
    const native = globalThis.Response;
    try {
      await h.call(USERS.admin, "POST", "spaces", { slug: "patched", name: "补丁", defaultRole: "viewer" });
      const { data } = await h.call(USERS.admin, "POST", "spaces/patched/documents", { title: "页面", markdown: "一\n" });
      // What `@hono/node-server` does: `Response.json()` then returns objects that are not instances of the global.
      class Patched extends native {}
      globalThis.Response = Patched as typeof Response;
      const saved = await h.write(USERS.admin, "PUT", `documents/${data.document.id}/content`, { markdown: "二\n", expectedRevision: 1 });
      expect(saved.data.revision.no).toBe(2);
    } finally {
      globalThis.Response = native;
      await h.close();
    }
  });
});
