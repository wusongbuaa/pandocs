import type { Bootstrap, DocumentView, SpaceWithTree, TreeEntry } from "../src/types";

const documents = import.meta.glob<string>("./fixtures/*.md", { query: "?raw", import: "default", eager: true });

const pages = [
  { path: "elements", title: "元素样例" },
  { path: "second", title: "第二页" }
];

export const FIXTURE_NAV = [
  { text: "比对", link: "/parity/" },
  { text: "更多", items: [{ text: "第二页", link: "/parity/second" }] }
];

const tree: TreeEntry[] = pages.map((page, index) => ({
  id: page.path,
  parentId: null,
  slug: page.path,
  path: page.path,
  title: page.title,
  sortOrder: index,
  restricted: false,
  currentRevisionNo: 1,
  updatedAt: "2026-11-06T00:00:00.000Z",
  hasContent: true,
  labels: []
}));

const space: SpaceWithTree = { id: "parity", slug: "parity", name: "比对", description: "", defaultRole: "viewer", role: "viewer", glossary: [], tree };

const bootstrap: Bootstrap = {
  me: { id: "parity", displayName: "比对", kind: "user", isAdmin: false, scopes: ["read"] },
  site: {
    title: "比对站点",
    description: "",
    logo: "",
    footer: "页脚文字",
    defaultLang: "zh",
    locales: [{ lang: "zh", label: "简体中文" }],
    nav: FIXTURE_NAV,
    socialLinks: [{ icon: "github", link: "https://github.com/web-infra-dev/rspress" }],
    appLinks: [],
    actions: [],
  trashRetentionDays: null,
  logoutUrl: "",
  askForVisitors: false,
  brandColor: ""
  },
  spaces: [space],
  searchIndexHash: "parity",
  shareLinks: false
};

function documentView(id: string): DocumentView {
  const page = pages.find(item => item.path === id)!;
  return {
    document: { id, path: id, title: page.title, restricted: false, parentId: null, currentRevisionNo: 1, updatedAt: "2026-11-06T00:00:00.000Z" },
    spaceSlug: "parity",
    role: "viewer",
    labels: [],
    revision: { no: 1, sha256: "", actorId: "parity", actorName: "", actorKind: "user", channel: "web", proposalId: null, ingestJobId: null, message: "", createdAt: "2026-11-06T00:00:00.000Z" },
    markdown: documents[`./fixtures/${id}.md`] ?? "",
    outline: [],
    blocks: [],
    diagnostics: [],
    editing: null
  };
}

/** The comparison runs on the built app alone, with no server or database behind it. */
export function fixtureResponse(path: string): unknown {
  if (path === "bootstrap") return bootstrap;
  const match = /^documents\/([^/]+)$/u.exec(path);
  if (match) return documentView(match[1]!);
  throw new Error(`There is no data for ${path} in parity mode`);
}
