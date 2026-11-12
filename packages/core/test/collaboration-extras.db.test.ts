import { ANONYMOUS_PRINCIPAL, DEFAULT_BRAND_COLOR, siteStyles, type NotificationEvent, type Principal } from "@pandocs/core";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();

describe("what the site looks like", () => {
  it("works out the theme's shades from one colour, and adds the site's own rules last", () => {
    const css = siteStyles({ brandColor: "#336699", customCss: ".rp-nav { height: 80px; }" });
    expect(css).toContain("--rp-c-brand: #336699;");
    expect(css).toContain("--rp-c-brand-light: #5c85ad;");
    expect(css).toContain("--rp-c-brand-dark: #2e5c8a;");
    expect(css).toContain("--rp-c-brand-tint: rgba(51, 102, 153, 0.16);");
    expect(css.indexOf("--rp-c-brand")).toBeLessThan(css.indexOf(".rp-nav"));
  });

  it("uses Pandocs' green when the site has no colour of its own, and the front page glows green to match", () => {
    const css = siteStyles({ brandColor: "", customCss: "  \n" });
    expect(css).toContain(`--rp-c-brand: ${DEFAULT_BRAND_COLOR};`);
    expect(css).toContain("--rp-home-hero-secondary-color");
    expect(siteStyles({ brandColor: "#336699", customCss: "" })).not.toContain("--rp-home-hero-secondary-color");
  });
});

describe("site settings for the look", () => {
  let h: ReturnType<typeof createHarness>;
  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
  });
  afterAll(() => h.close());

  it("takes a colour written as a colour, and only from an administrator", async () => {
    expect((await h.call(USERS.editor, "PATCH", "site", { brandColor: "#112233" })).status).toBe(403);
    expect((await h.call(USERS.admin, "PATCH", "site", { brandColor: "red" })).status).toBe(422);
    expect((await h.call(USERS.admin, "PATCH", "site", { brandColor: "#112233;}body{display:none" })).status).toBe(422);
    expect((await h.call(USERS.admin, "PATCH", "site", { brandColor: "#112233", customCss: "a { color: red; }" })).data.brandColor).toBe("#112233");
  });

  it("takes a favicon that is an image, by address or uploaded, and nothing else", async () => {
    for (const favicon of ["javascript:alert(1)", "data:text/html;base64,PGI+", "//elsewhere.example/icon.png", `data:image/png;base64,${"A".repeat(30_000)}`]) {
      expect((await h.call(USERS.admin, "PATCH", "site", { favicon })).status, favicon.slice(0, 30)).toBe(422);
    }
    for (const favicon of ["https://cdn.example.com/icon.png", "/icons/a.png", "data:image/svg+xml;base64,PHN2Zz4=", ""]) {
      expect((await h.call(USERS.admin, "PATCH", "site", { favicon })).data.favicon).toBe(favicon);
    }
  });

  it("keeps the custom CSS out of what every page carries, and in what the settings page reads", async () => {
    const { data: bootstrap } = await h.call(USERS.reader, "GET", "bootstrap");
    expect(bootstrap.site.brandColor).toBe("#112233");
    expect(bootstrap.site).not.toHaveProperty("customCss");
    expect(bootstrap.site).not.toHaveProperty("favicon");
    expect((await h.call(USERS.admin, "GET", "site")).data.customCss).toBe("a { color: red; }");
  });
});

describe("labels", () => {
  let h: ReturnType<typeof createHarness>;
  let open = "";
  let hidden = "";

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    await h.call(USERS.admin, "POST", "spaces", { slug: "shop", name: "Shop", defaultRole: "viewer" });
    await h.call(USERS.admin, "PATCH", "spaces/shop", { publicRead: true });
    await h.call(USERS.admin, "PUT", "spaces/shop/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    open = (await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Returns", slug: "returns", markdown: "Seven days.\n" })).data.document.id;
    hidden = (await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Secret prices", slug: "cost", markdown: "Secret.\n", restricted: true })).data.document.id;
  });
  afterAll(() => h.close());

  it("counts as one label in any case, tidies what is typed, and makes no new version", async () => {
    const { status, data } = await h.call(USERS.editor, "PUT", `documents/${open}/labels`, { labels: ["  how  to ", "How To", "Policy"] });
    expect(status).toBe(200);
    expect(data.labels).toEqual(["How To", "Policy"]);
    const { data: view } = await h.call(USERS.reader, "GET", `documents/${open}`);
    expect(view.labels).toEqual(["How To", "Policy"]);
    expect(view.revision.no).toBe(1);
    const { data: tree } = await h.call(USERS.reader, "GET", "spaces/shop/tree");
    expect(tree.find((node: { id: string }) => node.id === open).labels).toEqual(["How To", "Policy"]);
  });

  it("is for people who can edit the page, within limits", async () => {
    expect((await h.call(USERS.reader, "PUT", `documents/${open}/labels`, { labels: ["mine"] })).status).toBe(403);
    expect((await h.call(USERS.editor, "PUT", `documents/${open}/labels`, { labels: Array.from({ length: 21 }, (_, at) => `l${at}`) })).status).toBe(422);
    expect((await h.call(USERS.editor, "PUT", `documents/${open}/labels`, { labels: ["x".repeat(41)] })).status).toBe(422);
    expect((await h.call(USERS.agent, "POST", "tools/doc_labels", { doc: "shop/returns", labels: ["agent"] })).status).toBe(403);
  });

  it("finds pages by label, with or without words, and only pages this person can read", async () => {
    await h.call(USERS.admin, "PUT", `documents/${hidden}/labels`, { labels: ["policy", "money"] });
    const titles = async (principal: Principal, query: string) => (await h.call(principal, "GET", `search?${query}`)).data.map((hit: { title: string }) => hit.title).sort();
    expect(await titles(USERS.admin, "label=POLICY")).toEqual(["Returns", "Secret prices"]);
    expect(await titles(USERS.reader, "label=policy")).toEqual(["Returns"]);
    expect(await titles(USERS.admin, "label=policy&q=secret")).toEqual(["Secret prices"]);
    expect(await titles(USERS.admin, "label=nothing")).toEqual([]);
    expect(await titles(ANONYMOUS_PRINCIPAL, "label=policy")).toEqual(["Returns"]);
  });

  it("counts labels by what this person can read, so a hidden page's labels stay hidden", async () => {
    const labels = async (principal: Principal) => (await h.call(principal, "GET", "spaces/shop/labels")).data;
    expect(await labels(USERS.admin)).toEqual([{ label: "How To", pages: 1 }, { label: "money", pages: 1 }, { label: "Policy", pages: 2 }].sort((a, b) => b.pages - a.pages || a.label.localeCompare(b.label)));
    expect(await labels(USERS.reader)).toEqual([{ label: "How To", pages: 1 }, { label: "Policy", pages: 1 }]);
    expect(await labels(ANONYMOUS_PRINCIPAL)).toEqual([{ label: "How To", pages: 1 }, { label: "Policy", pages: 1 }]);
  });

  it("lets an agent find pages by label through its search tool", async () => {
    const { data } = await h.call(USERS.agent, "POST", "tools/doc_search", { label: "how to" });
    expect(data.map((hit: { title: string }) => hit.title)).toEqual(["Returns"]);
    expect((await h.call(USERS.agent, "POST", "tools/doc_search", {})).status).toBe(422);
  });

  it("comes along in an export and goes back in on import, without counting as a change", async () => {
    const { response } = await h.call(USERS.admin, "GET", "spaces/shop/export");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const manifest = JSON.parse(strFromU8(unzipSync(bytes)["manifest.json"]!)) as { documents: { file: string; labels: string[] }[] };
    expect(manifest.documents.find(item => item.file === "returns.md")!.labels).toEqual(["How To", "Policy"]);

    await h.call(USERS.admin, "POST", "spaces", { slug: "copy", name: "Copy", defaultRole: "viewer" });
    expect((await h.call(USERS.admin, "POST", "spaces/copy/archive", bytes)).data.created).toBe(2);
    const { data: tree } = await h.call(USERS.admin, "GET", "spaces/copy/tree");
    expect(tree.find((node: { slug: string }) => node.slug === "returns").labels).toEqual(["How To", "Policy"]);

    await h.call(USERS.admin, "PUT", `documents/${tree.find((node: { slug: string }) => node.slug === "returns").id}/labels`, { labels: [] });
    const again = (await h.call(USERS.admin, "POST", "spaces/copy/archive", bytes)).data;
    expect(again.unchanged).toBe(2);
    const { data: restored } = await h.call(USERS.admin, "GET", "spaces/copy/tree");
    expect(restored.find((node: { slug: string }) => node.slug === "returns").labels).toEqual(["How To", "Policy"]);
  });

  it("refuses a manifest whose labels could not have come from an export", async () => {
    const files = { "manifest.json": strToU8(JSON.stringify({ documents: [{ file: "a.md", title: "A", labels: ["x".repeat(41)] }] })), "a.md": strToU8("A\n") };
    expect((await h.call(USERS.admin, "POST", "spaces/copy/archive", zipSync(files))).status).toBe(422);
  });
});

describe("templates", () => {
  let h: ReturnType<typeof createHarness>;
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    await h.call(USERS.admin, "POST", "spaces", { slug: "shop", name: "Shop", defaultRole: "viewer" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "other", name: "Other", defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", "spaces/shop/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
  });
  afterAll(() => h.close());

  it("offers built-in ones that make clean pages in any space", async () => {
    const { data } = await h.call(USERS.editor, "GET", "spaces/shop/templates");
    expect(data.length).toBeGreaterThanOrEqual(4);
    for (const template of data as { id: string; builtIn: boolean; name: string }[]) {
      expect(template.builtIn).toBe(true);
      const { status, data: created } = await h.call(USERS.editor, "POST", "spaces/shop/documents", { title: template.name, template: template.id, strict: true });
      expect(status).toBe(201);
      expect(created.revision.no).toBe(1);
    }
  });

  it("are for those who can write in the space", async () => {
    expect((await h.call(USERS.reader, "GET", "spaces/shop/templates")).status).toBe(403);
    expect((await h.call(USERS.reader, "POST", "spaces/shop/templates", { name: "T", markdown: "x" })).status).toBe(403);
  });

  it("fills in the title and the date when a page is made from one", async () => {
    const { status, data: template } = await h.call(USERS.editor, "POST", "spaces/shop/templates", { name: " Weekly ", description: "Each week", markdown: "# {{title}}\n\nWritten {{date}}.\n" });
    expect(status).toBe(201);
    expect(template).toMatchObject({ name: "Weekly", description: "Each week", builtIn: false });
    const { data: made } = await h.call(USERS.editor, "POST", "spaces/shop/documents", { title: "Week 45", slug: "w45", template: template.id });
    const { data: view } = await h.call(USERS.editor, "GET", `documents/${made.document.id}`);
    expect(view.markdown).toBe(`# Week 45\n\nWritten ${today()}.\n`);
  });

  it("lets a template change without touching what was made from it", async () => {
    const { data: template } = await h.call(USERS.editor, "POST", "spaces/shop/templates", { name: "Note", markdown: "One\n" });
    const { data: made } = await h.call(USERS.editor, "POST", "spaces/shop/documents", { title: "A note", slug: "note", template: template.id });
    expect((await h.call(USERS.editor, "PATCH", `templates/${template.id}`, { markdown: "Two\n" })).data).toMatchObject({ name: "Note", markdown: "Two\n" });
    expect((await h.call(USERS.editor, "GET", `documents/${made.document.id}`)).data.markdown).toBe("One\n");
    expect((await h.call(USERS.editor, "DELETE", `templates/${template.id}`)).status).toBe(200);
    expect((await h.call(USERS.editor, "GET", `documents/${made.document.id}`)).data.markdown).toBe("One\n");
    expect((await h.call(USERS.editor, "DELETE", `templates/${template.id}`)).status).toBe(404);
    const record = (await h.call(USERS.admin, "GET", "spaces/shop/audit?category=space")).data as { action: string; detail: { name: string } }[];
    expect(record.filter(entry => entry.detail.name === "Note").map(entry => entry.action)).toEqual(["space.template.delete", "space.template.update", "space.template.create"]);
  });

  it("does not reach across spaces, or take two sources at once", async () => {
    const { data: template } = await h.call(USERS.admin, "POST", "spaces/other/templates", { name: "Other's", markdown: "Other\n" });
    expect((await h.call(USERS.editor, "POST", "spaces/shop/documents", { title: "Stolen", template: template.id })).status).toBe(422);
    expect((await h.call(USERS.editor, "PATCH", `templates/${template.id}`, { markdown: "Mine\n" })).status).toBe(403);
    expect((await h.call(USERS.editor, "DELETE", "templates/not-a-template")).status).toBe(404);
    expect((await h.call(USERS.editor, "POST", "spaces/shop/documents", { title: "Both", markdown: "Words", template: "builtin:meeting" })).status).toBe(422);
    expect((await h.call(USERS.editor, "POST", "spaces/shop/documents", { title: "None", template: "builtin:nothing" })).status).toBe(422);
  });

  it("are there for tools too", async () => {
    const editorViaApi = { ...USERS.editor, channel: "api" } as const;
    const { data: list } = await h.call(editorViaApi, "POST", "tools/doc_templates", { space: "shop" });
    expect(list.some((template: { id: string }) => template.id === "builtin:decision")).toBe(true);
    const { data: made } = await h.call(editorViaApi, "POST", "tools/doc_create", { space: "shop", title: "Pick a queue", slug: "queue", template: "builtin:decision" });
    expect(made.revision.no).toBe(1);
    expect((await h.call(editorViaApi, "GET", `documents/${made.document.id}`)).data.markdown).toContain(today());
  });
});

describe("following pages and spaces", () => {
  let h: ReturnType<typeof createHarness>;
  let page = "";
  let other = "";
  let hidden = "";
  const sent: NotificationEvent[] = [];
  const people: Record<string, Principal> = Object.fromEntries(Object.values(USERS).map(user => [user.id, user]));

  const inbox = async (principal: Principal) => (await h.call(principal, "GET", "me/inbox")).data.notifications as { id: string; kind: string; documentId: string; actorName: string; summary: string; readAt: string | null }[];
  const save = async (principal: Principal, id: string, markdown: string, message?: string) => {
    const { data: view } = await h.call(principal, "GET", `documents/${id}`);
    return h.write(principal, "PUT", `documents/${id}/content`, { markdown, expectedRevision: view.revision.no, ...(message ? { message } : {}) });
  };
  const clear = async (...who: Principal[]) => {
    for (const person of who) await h.call(person, "POST", "me/inbox/read", { ids: "all" });
    await h.pool.query("UPDATE pandocs.notifications SET mail_due = false");
    sent.length = 0;
  };

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString(), {
      notifier: { notify: async event => { sent.push(event); } },
      directory: { search: async () => [], principal: async id => people[id] ?? null }
    });
    await h.call(USERS.admin, "POST", "spaces", { slug: "shop", name: "Shop", defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", "spaces/shop/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    page = (await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Returns", slug: "returns", markdown: "One\n" })).data.document.id;
    other = (await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Shipping", slug: "shipping", markdown: "One\n" })).data.document.id;
    hidden = (await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Secret prices", slug: "cost", markdown: "One\n", restricted: true })).data.document.id;
  });
  afterAll(() => h.close());

  it("says whether someone follows a page, and stops when they say so", async () => {
    expect((await h.call(USERS.reader, "GET", `documents/${page}/subscription`)).data).toEqual({ document: false, space: false });
    expect((await h.call(USERS.reader, "PUT", `documents/${page}/subscription`)).data).toEqual({ following: true });
    expect((await h.call(USERS.reader, "PUT", `documents/${page}/subscription`)).status).toBe(200);
    expect((await h.call(USERS.reader, "GET", `documents/${page}/subscription`)).data).toEqual({ document: true, space: false });
    expect((await h.call(USERS.reader, "DELETE", `documents/${page}/subscription`)).data).toEqual({ following: false });
    expect((await h.call(USERS.reader, "GET", "me/subscriptions")).data).toEqual([]);
  });

  it("is only for people with an account", async () => {
    expect((await h.call(USERS.agent, "PUT", `documents/${page}/subscription`)).status).toBe(403);
    const guest = { ...USERS.reader, id: "embed:app:someone", guest: true } satisfies Principal;
    expect((await h.call(guest, "PUT", "spaces/shop/subscription")).status).toBe(403);
    expect((await h.call(USERS.stranger, "PUT", `documents/${hidden}/subscription`)).status).toBe(404);
  });

  it("tells those following a page or its space, and not the one who changed it", async () => {
    await h.call(USERS.reader, "PUT", `documents/${page}/subscription`);
    await h.call(USERS.commenter, "PUT", "spaces/shop/subscription");
    await h.call(USERS.editor, "PUT", `documents/${page}/subscription`);
    await save(USERS.editor, page, "Two\n", "Longer window");
    const [forReader] = await inbox(USERS.reader);
    expect(forReader).toMatchObject({ kind: "page_updated", documentId: page, actorName: USERS.editor.displayName, summary: "Longer window" });
    expect((await inbox(USERS.commenter))[0]).toMatchObject({ kind: "page_updated", documentId: page });
    expect(await inbox(USERS.editor)).toEqual([]);
    await save(USERS.editor, other, "Two\n");
    expect((await inbox(USERS.commenter)).map(item => item.documentId)).toContain(other);
    expect((await inbox(USERS.reader)).map(item => item.documentId)).not.toContain(other);
  });

  it("makes one notice of a run of changes nobody has read yet", async () => {
    await clear(USERS.reader, USERS.commenter);
    await save(USERS.editor, page, "Three\n", "First");
    await save(USERS.editor, page, "Four\n", "Second");
    const unread = (await inbox(USERS.reader)).filter(item => !item.readAt);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.summary).toBe("Second");
    await h.call(USERS.reader, "POST", "me/inbox/read", { ids: "all" });
    const before = (await inbox(USERS.reader)).length;
    await save(USERS.editor, page, "Five\n", "Third");
    const after = await inbox(USERS.reader);
    expect(after.filter(item => !item.readAt).map(item => item.summary)).toEqual(["Third"]);
    expect(after).toHaveLength(before + 1);
  });

  it("says nothing about a page someone can no longer read, in the list or by mail", async () => {
    await h.call(USERS.admin, "PUT", `documents/${hidden}/members`, { subject: `user:${USERS.reader.id}`, role: "viewer" });
    await h.call(USERS.reader, "PUT", `documents/${hidden}/subscription`);
    await clear(USERS.reader);
    await save(USERS.admin, hidden, "Two\n");
    expect((await inbox(USERS.reader)).map(item => item.documentId)).toContain(hidden);
    await h.call(USERS.admin, "PUT", `documents/${hidden}/members`, { subject: `user:${USERS.reader.id}`, role: null });
    expect((await inbox(USERS.reader)).map(item => item.documentId)).not.toContain(hidden);
    expect((await h.call(USERS.reader, "GET", "me/subscriptions")).data.map((item: { documentId: string }) => item.documentId)).not.toContain(hidden);
    await h.services.subscriptions.sendDueMail(0);
    expect(sent.filter(event => event.recipientId === USERS.reader.id)).toEqual([]);
  });

  it("does not tell anyone about a change that did not happen", async () => {
    await clear(USERS.reader, USERS.commenter);
    const { status } = await h.write(USERS.editor, "PUT", `documents/${page}/content`, { markdown: "Never\n", expectedRevision: 1 });
    expect(status).toBe(409);
    expect((await inbox(USERS.reader)).filter(item => !item.readAt)).toEqual([]);
  });

  it("waits for things to go quiet before mailing, then sends each person one message", async () => {
    await clear(USERS.reader, USERS.commenter);
    await save(USERS.editor, page, "Six\n", "Longer");
    await save(USERS.editor, other, "Six\n", "Faster");
    expect(await h.services.subscriptions.sendDueMail()).toBe(0);
    expect(sent).toEqual([]);

    expect(await h.services.subscriptions.sendDueMail(0)).toBeGreaterThan(0);
    const toCommenter = sent.filter(event => event.recipientId === USERS.commenter.id);
    expect(toCommenter).toHaveLength(1);
    expect(toCommenter[0]).toMatchObject({ kind: "page_updated", documentTitle: "Returns", location: "shop/returns", summary: "Longer" });
    expect(toCommenter[0]!.alsoUpdated).toMatchObject([{ documentTitle: "Shipping", location: "shop/shipping" }]);
    const toReader = sent.filter(event => event.recipientId === USERS.reader.id);
    expect(toReader).toHaveLength(1);
    expect(toReader[0]!.alsoUpdated).toEqual([]);

    sent.length = 0;
    expect(await h.services.subscriptions.sendDueMail(0)).toBe(0);
    await save(USERS.editor, page, "Seven\n");
    await h.services.subscriptions.sendDueMail(0);
    expect(sent).toEqual([]);
  });

  it("drops the mail when a page is gone by the time it is due", async () => {
    await clear(USERS.reader, USERS.commenter);
    const { data } = await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Soon gone", slug: "gone", markdown: "One\n" });
    await h.call(USERS.reader, "PUT", `documents/${data.document.id}/subscription`);
    await save(USERS.editor, data.document.id, "Two\n");
    await h.call(USERS.admin, "DELETE", `documents/${data.document.id}`);
    await h.services.subscriptions.sendDueMail(0);
    expect(sent.filter(event => event.documentId === data.document.id)).toEqual([]);
    const { rows } = await h.pool.query("SELECT count(*)::int AS due FROM pandocs.notifications WHERE mail_due");
    expect(rows[0].due).toBe(0);
  });
});
