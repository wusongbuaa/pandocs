import * as React from "react";
import { MDXProvider } from "@mdx-js/react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { renderMarkdown } from "../src/markdown/pipeline";
import { applyBootstrap } from "../src/data/bootstrap";
import type { Bootstrap, SpaceWithTree, TreeEntry } from "../src/types";

// happy-dom's Response has no `bytes()`, which Shiki's inlined engine reads itself from.
Response.prototype.bytes ??= async function bytes(this: Response) {
  return new Uint8Array(await this.arrayBuffer());
} as never;

export function entry(path: string, overrides: Partial<TreeEntry> = {}): TreeEntry {
  return {
    id: path,
    parentId: null,
    slug: path.split("/").at(-1)!,
    path,
    title: path,
    sortOrder: 0,
    restricted: false,
    currentRevisionNo: 1,
    updatedAt: "2026-11-06T00:00:00.000Z",
    hasContent: true,
    labels: [],
    ...overrides
  };
}

export function space(slug: string, tree: readonly TreeEntry[]): SpaceWithTree {
  return {
    id: slug,
    slug,
    name: `${slug} 空间`,
    description: "",
    defaultRole: "viewer",
    role: "viewer",
    glossary: [],
    tree
  };
}

export function bootstrap(
  overrides: Partial<Omit<Bootstrap, "site">> & { site?: Partial<Bootstrap["site"]> } = {}
): Bootstrap {
  return {
    me: { id: "me", displayName: "测试用户", kind: "user", isAdmin: false, scopes: ["read", "write"] },
    spaces: [space("handbook", [entry("index"), entry("guide")])],
    searchIndexHash: "abc",
    shareLinks: true,
    ...overrides,
    site: {
      title: "文档",
      description: "",
      logo: "",
      footer: "",
      defaultLang: "zh",
      locales: [{ lang: "zh", label: "简体中文" }],
      nav: null,
      socialLinks: [],
      appLinks: [],
      actions: [],
      trashRetentionDays: null,
      logoutUrl: "",
      askForVisitors: false,
      brandColor: "",
      ...overrides.site
    }
  };
}

/** The theme captures its data when it loads, so this runs before anything imports it. */
export async function renderDocument(markdown: string, title = "测试文档") {
  applyBootstrap(bootstrap());
  const [{ PageContext }, { getCustomMDXComponent }, { RenderedBody }] = await Promise.all([
    import("@rspress/core/runtime"),
    import("@rspress/core/theme"),
    import("../src/markdown/document-body")
  ]);
  const rendered = await renderMarkdown(markdown, { title });
  const page = {
    kind: "document" as const,
    translation: null,
    space: space("handbook", []),
    entry: entry("guide"),
    // Words the page shows that are not in its text, for what compares the two.
    view: { labels: ["Not in the text"] } as never,
    rendered
  };
  const data = {
    lang: "zh",
    frontmatter: {},
    title,
    toc: rendered.toc,
    routePath: "/handbook/guide",
    pandocs: page
  } as never;
  const result = render(
    <MemoryRouter>
      <PageContext.Provider value={{ data }}>
        <MDXProvider components={getCustomMDXComponent() as never}>
          <RenderedBody page={page} />
        </MDXProvider>
      </PageContext.Provider>
    </MemoryRouter>
  );
  return { ...result, rendered, body: result.container.querySelector("[data-pandocs-body]") as HTMLElement };
}
