import type { Principal } from "@pandocs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  )
);
const OTHER_PNG = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")
);

describe("share links", () => {
  let h: ReturnType<typeof createHarness>;
  let guide = "";
  let step = "";
  let hiddenStep = "";
  let other = "";
  let closed = "";
  let image = "";
  let otherImage = "";

  const make = async (title: string, slug: string, extra: object = {}, space = "shop") =>
    (await h.call(USERS.admin, "POST", `spaces/${space}/documents`, { title, slug, markdown: `${title}.\n`, ...extra }))
      .data.document.id as string;
  const share = async (id: string, body: object = {}) => {
    const created = await h.call(USERS.editor, "POST", `documents/${id}/share-links`, body);
    expect(created.error).toBeUndefined();
    return created.data as { id: string; token: string; path: string; expiresAt: string | null };
  };
  const as = (token: string) => h.services.shareLinks.principalOf(token);
  const visitor = async (id: string, body: object = {}) => (await as((await share(id, body)).token))!;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    await h.call(USERS.admin, "POST", "spaces", { slug: "shop", name: "Shop", defaultRole: "commenter" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "inside", name: "Inside", defaultRole: "none" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "open", name: "Open", defaultRole: "none" });
    await h.call(USERS.admin, "PATCH", "spaces/open", { publicRead: true });
    await h.call(USERS.admin, "PUT", "spaces/shop/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    image = (await h.call(USERS.admin, "POST", "spaces/shop/assets?filename=a.png", PNG)).data.path;
    otherImage = (await h.call(USERS.admin, "POST", "spaces/shop/assets?filename=b.png", OTHER_PNG)).data.path;
    guide = await make("Guide", "guide", { markdown: `Guide.\n\n![a](${image})\n` });
    step = await make("Step", "step", { parentPath: "guide" });
    hiddenStep = await make("Hidden step", "hidden", { parentPath: "guide", restricted: true });
    other = await make("Other page", "other", { markdown: `Other.\n\n![b](${otherImage})\n` });
    closed = await make("Inside note", "note", {}, "inside");
    await make("Public note", "public", {}, "open");
  });
  afterAll(() => h.close());

  it("is for those who can edit the page", async () => {
    expect((await h.call(USERS.commenter, "POST", `documents/${guide}/share-links`, {})).status).toBe(403);
    expect((await h.call(USERS.commenter, "GET", `documents/${guide}/share-links`)).status).toBe(403);
    expect((await h.call(USERS.agent, "POST", `documents/${guide}/share-links`, {})).status).toBe(403);
    expect((await h.call(USERS.stranger, "POST", `documents/${closed}/share-links`, {})).status).toBe(404);
    const link = await share(guide);
    expect((await h.call(USERS.commenter, "DELETE", `share-links/${link.id}`)).status).toBe(403);
    expect((await h.call(USERS.commenter, "DELETE", "share-links/not-a-link")).status).toBe(404);
  });

  it("makes a long, unguessable address, and can list it again for copying", async () => {
    const link = await share(guide, { expiresInDays: 7 });
    expect(link.token).toMatch(/^pds_[\w-]{32}$/u);
    expect(link.path).toBe(`/s/${link.token}`);
    expect(new Date(link.expiresAt!).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(
      (await h.call(USERS.editor, "GET", `documents/${guide}/share-links`)).data.map((item: { id: string }) => item.id)
    ).toContain(link.id);
    const { data: log } = await h.call(USERS.admin, "GET", "spaces/shop/audit");
    expect(JSON.stringify(log)).not.toContain(link.token);
  });

  it("runs for a while unless told otherwise, and only as long as anyone could want", async () => {
    expect(new Date((await share(guide)).expiresAt!).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await share(guide, { expiresInDays: null })).expiresAt).toBeNull();
    expect((await h.call(USERS.editor, "POST", `documents/${guide}/share-links`, { expiresInDays: 1000 })).status).toBe(
      422
    );
  });

  it("does not open a page only some people can read", async () => {
    expect((await h.call(USERS.admin, "POST", `documents/${hiddenStep}/share-links`, {})).status).toBe(422);
  });

  it("stops working when it expires, is revoked, or its page goes or is closed", async () => {
    const page = await make("Soon", "soon");
    const expired = await share(page);
    await h.pool.query("UPDATE pandocs.share_links SET expires_at = now() - interval '1 second' WHERE id = $1", [
      expired.id
    ]);
    expect(await as(expired.token)).toBeNull();
    expect((await h.call(USERS.editor, "GET", `documents/${page}/share-links`)).data).toEqual([]);

    const revoked = await share(page);
    expect(await as(revoked.token)).not.toBeNull();
    expect((await h.call(USERS.editor, "DELETE", `share-links/${revoked.id}`)).status).toBe(200);
    expect(await as(revoked.token)).toBeNull();
    expect((await h.call(USERS.editor, "DELETE", `share-links/${revoked.id}`)).status).toBe(404);

    const live = await share(page);
    await h.call(USERS.admin, "DELETE", `documents/${page}`);
    expect(await as(live.token)).toBeNull();
    await h.call(USERS.admin, "POST", `documents/${page}/restore`);
    expect(await as(live.token)).not.toBeNull();
    await h.call(USERS.admin, "PATCH", `documents/${page}`, { restricted: true });
    expect(await as(live.token)).toBeNull();
    expect(await as("pds_nothing-like-this")).toBeNull();
  });

  it("keeps working for a page that moves", async () => {
    const page = await make("Mover", "mover");
    const link = await share(page);
    await h.call(USERS.admin, "POST", `documents/${page}/move`, { slug: "moved" });
    expect((await as(link.token))!.shared!.documents).toEqual([page]);
  });

  it("gives the page and nothing else, even what anyone could read", async () => {
    const principal = await visitor(guide);
    expect((await h.call(principal, "GET", `documents/${guide}`)).status).toBe(200);
    expect((await h.call(principal, "GET", `documents/${step}`)).status).toBe(404);
    expect((await h.call(principal, "GET", `documents/${other}`)).status).toBe(404);
    expect((await h.call(principal, "GET", `documents/${closed}`)).status).toBe(404);
    const { data: bootstrap } = await h.call(principal, "GET", "bootstrap");
    expect(bootstrap.spaces.map((space: { slug: string }) => space.slug)).toEqual(["shop"]);
    expect(bootstrap.spaces[0].tree.map((node: { id: string }) => node.id)).toEqual([guide]);
    expect(bootstrap.me.anonymous).toBe(true);
    expect(bootstrap.ai.ask).toBe(false);
  });

  it("covers its subpages when asked, but not one that is closed", async () => {
    const principal = await visitor(guide, { includeChildren: true });
    expect((await h.call(principal, "GET", `documents/${step}`)).status).toBe(200);
    expect((await h.call(principal, "GET", `documents/${hiddenStep}`)).status).toBe(404);
    const { data: bootstrap } = await h.call(principal, "GET", "bootstrap");
    expect(bootstrap.spaces[0].tree.map((node: { id: string }) => node.id).sort()).toEqual([guide, step].sort());
  });

  it("does not share one visitor's answer with another, as it does for people with no link", async () => {
    const one = await visitor(guide);
    const two = await visitor(other);
    const treeOf = async (principal: Principal) =>
      (await h.call(principal, "GET", "bootstrap")).data.spaces[0].tree.map((node: { id: string }) => node.id);
    expect(await treeOf(one)).toEqual([guide]);
    expect(await treeOf(two)).toEqual([other]);
  });

  it("is for reading: nothing can be written, and nothing else asked for", async () => {
    const principal = await visitor(guide);
    const refused = [
      ["POST", `documents/${guide}/feedback`, { kind: "helpful" }],
      ["POST", `documents/${guide}/threads`, { anchor: { kind: "document" }, body: "Hello" }],
      ["PUT", `documents/${guide}/content`, { markdown: "Mine\n", expectedRevision: 1 }],
      ["POST", "ask", { question: "What else is there?" }],
      ["POST", "stats/views", { document: guide }],
      ["GET", "spaces"],
      ["GET", "spaces/shop"],
      ["GET", "spaces/shop/tree"],
      ["GET", "spaces/open/tree"],
      ["GET", "search?q=Other"],
      ["GET", "static/search_index.abc.json"],
      ["GET", "llms.txt"],
      ["GET", "spaces/shop/llms-full.txt"],
      ["GET", `documents/${guide}/threads`],
      ["GET", `documents/${guide}/revisions`],
      ["GET", "me/inbox"],
      ["GET", "changes"],
      ["POST", "tools/doc_search", { query: "Other" }]
    ] as const;
    for (const [method, path, body] of refused)
      expect((await h.call(principal, method, path, body)).status, `${method} ${path}`).toBe(404);
  });

  it("tells a visitor nothing about who wrote it, or how it read before", async () => {
    const principal = await visitor(guide);
    const { data: view } = await h.call(principal, "GET", `documents/${guide}`);
    expect(view.revision.actorName).toBe("");
    expect(view.editing).toBeNull();
    expect((await h.call(principal, "GET", `documents/${guide}?revision=1`)).status).toBe(404);
    expect((await h.call(principal, "GET", `documents/${guide}/content?revision=1`)).status).toBe(404);
  });

  it("shows the page's own images, not those of the rest of the space", async () => {
    const principal = await visitor(guide);
    const hash = (path: string) => /assets\/([a-f0-9]{64})/u.exec(path)![1]!;
    expect((await h.call(principal, "GET", `spaces/shop/assets/${hash(image)}`)).status).toBe(200);
    expect((await h.call(principal, "GET", `spaces/shop/assets/${hash(otherImage)}`)).status).toBe(404);
    expect((await h.call(principal, "GET", `spaces/open/assets/${hash(image)}`)).status).toBe(404);
  });

  it("finds a page by its address only within what it covers", async () => {
    const principal = await visitor(guide);
    expect((await h.call(principal, "GET", "spaces/shop/resolve?path=guide")).data.id).toBe(guide);
    expect((await h.call(principal, "GET", "spaces/shop/resolve?path=other")).status).toBe(404);
    expect((await h.call(principal, "GET", "spaces/open/resolve?path=public")).status).toBe(404);
  });

  it("does not exist on a site that must never be open", async () => {
    const link = await share(guide);
    const shut = createHarness(fixture.getConnectionString(), { publicSpacesDisabled: true });
    try {
      expect(await shut.services.shareLinks.principalOf(link.token)).toBeNull();
      expect((await shut.call(USERS.editor, "POST", `documents/${guide}/share-links`, {})).status).toBe(403);
      expect((await shut.call(USERS.editor, "GET", "bootstrap")).data.shareLinks).toBe(false);
    } finally {
      await shut.close();
    }
    expect((await h.call(USERS.editor, "GET", "bootstrap")).data.shareLinks).toBe(true);
  });
});
