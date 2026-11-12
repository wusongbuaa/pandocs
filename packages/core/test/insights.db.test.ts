import { ANONYMOUS_PRINCIPAL, type Principal } from "@pandocs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const viaApi: Principal = { ...USERS.reader, channel: "api" };

describe("how much the documents are read", () => {
  let h: ReturnType<typeof createHarness>;
  let returns = "";
  let hidden = "";
  let closed = "";

  const insights = async (principal: Principal = USERS.admin, path = "insights") => (await h.call(principal, "GET", path)).data;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    await h.call(USERS.admin, "POST", "spaces", { slug: "shop", name: "Shop", defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", "spaces/shop/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "inside", name: "Inside", defaultRole: "none" });
    returns = (await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Returns", slug: "returns", markdown: "Seven days.\n" })).data.document.id;
    hidden = (await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Secret prices", slug: "cost", markdown: "Secret.\n", restricted: true })).data.document.id;
    closed = (await h.call(USERS.admin, "POST", "spaces/inside/documents", { title: "Inside note", slug: "note", markdown: "Staff.\n" })).data.document.id;
  });
  afterAll(() => h.close());

  it("counts someone reading in a browser, once they say so, and only what they can open", async () => {
    expect((await h.call(USERS.reader, "POST", "stats/views", { document: returns })).status).toBe(200);
    expect((await h.call(USERS.reader, "POST", "stats/views", { document: returns })).status).toBe(200);
    expect((await h.call(USERS.reader, "POST", "stats/views", { document: closed })).status).toBe(404);
    const { totals, pages, daily } = await insights();
    expect(totals).toMatchObject({ people: 2, agents: 0 });
    expect(pages).toEqual([expect.objectContaining({ documentId: returns, title: "Returns", space: "shop", path: "returns", people: 2, agents: 0 })]);
    expect(daily).toEqual([{ day: new Date().toISOString().slice(0, 10), people: 2, agents: 0 }]);
  });

  it("counts programs on their own, without being asked, and not the browser's own reads", async () => {
    await h.call(viaApi, "GET", `documents/${returns}`);
    await h.call(viaApi, "GET", `documents/${returns}/content`);
    await h.call(USERS.agent, "POST", "tools/doc_get", { doc: returns });
    await h.call(USERS.reader, "GET", `documents/${returns}`);
    await h.call(ANONYMOUS_PRINCIPAL, "GET", `documents/${returns}`);
    expect((await insights()).totals).toMatchObject({ people: 2, agents: 3 });
  });

  it("adds up across replicas", async () => {
    const other = createHarness(fixture.getConnectionString());
    await other.call(USERS.reader, "POST", "stats/views", { document: returns });
    await other.services.stats.flush();
    await other.close();
    await h.call(USERS.reader, "POST", "stats/views", { document: returns });
    expect((await insights()).totals.people).toBe(4);
  });

  it("does not lose the rest over a page deleted in the meantime", async () => {
    const { data } = await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Brief", slug: "brief", markdown: "x\n" });
    await h.call(USERS.reader, "POST", "stats/views", { document: returns });
    await h.call(USERS.reader, "POST", "stats/views", { document: data.document.id });
    await h.pool.query(`DELETE FROM pandocs.documents WHERE id = $1`, [data.document.id]);
    expect((await insights()).totals.people).toBe(5);
  });

  it("keeps what was searched for, one count however it was typed, and what found nothing", async () => {
    await h.call(USERS.reader, "POST", "stats/searches", { term: "Refund", results: 2, space: "shop" });
    await h.call(ANONYMOUS_PRINCIPAL, "POST", "stats/searches", { term: "  refund ", results: 0, space: "shop" });
    await h.call(USERS.reader, "POST", "stats/searches", { term: "unicorn", results: 0, space: "shop" });
    await h.call(USERS.reader, "POST", "stats/searches", { term: "elsewhere", results: 1 });
    await h.call(viaApi, "GET", "search?q=Seven");
    await h.call(USERS.agent, "POST", "tools/doc_search", { query: "nothing like this" });
    await h.call(USERS.reader, "GET", "search?q=not+counted");
    const { totals, searches, emptySearches } = await insights();
    expect(totals).toMatchObject({ searches: 6, emptySearches: 3 });
    expect(searches[0]).toEqual({ term: "refund", people: 2, agents: 0, empty: 1 });
    expect(searches.map((row: { term: string }) => row.term)).toEqual(expect.arrayContaining(["unicorn", "elsewhere", "seven", "nothing like this"]));
    expect(searches.map((row: { term: string }) => row.term)).not.toContain("not counted");
    expect(emptySearches.map((row: { term: string }) => row.term)).toEqual(expect.arrayContaining(["refund", "unicorn", "nothing like this"]));
    const space = await insights(USERS.editor, "spaces/shop/insights");
    expect(space.searches.map((row: { term: string }) => row.term).sort()).toEqual(["refund", "unicorn"]);
  });

  it("is for those who look after the documents, and leaves out pages they cannot read", async () => {
    await h.call(USERS.admin, "POST", "stats/views", { document: hidden });
    await h.call(USERS.admin, "POST", "stats/views", { document: closed });
    expect((await h.call(USERS.reader, "GET", "spaces/shop/insights")).status).toBe(403);
    expect((await h.call(USERS.reader, "GET", "insights")).status).toBe(403);
    expect((await h.call(USERS.editor, "GET", "insights")).status).toBe(403);
    expect((await h.call(ANONYMOUS_PRINCIPAL, "GET", "insights")).status).toBe(401);
    const asEditor = await insights(USERS.editor, "spaces/shop/insights");
    expect(asEditor.pages.map((page: { title: string }) => page.title)).toEqual(["Returns"]);
    const asAdmin = await insights();
    expect(asAdmin.pages.map((page: { title: string }) => page.title)).toEqual(expect.arrayContaining(["Returns", "Secret prices", "Inside note"]));
    const inside = await insights(USERS.admin, "spaces/inside/insights");
    expect(inside.pages.map((page: { title: string }) => page.title)).toEqual(["Inside note"]);
  });

  it("looks back as far as asked, and lets old numbers go", async () => {
    await h.services.stats.flush();
    await h.pool.query(`INSERT INTO pandocs.page_views (day, document_id, audience, views) VALUES (CURRENT_DATE - 40, $1, 'person', 100), (CURRENT_DATE - 500, $1, 'person', 1000)`, [returns]);
    await h.pool.query(`INSERT INTO pandocs.search_terms (day, space, term, audience, searches) VALUES (CURRENT_DATE - 200, '', 'old words', 'person', 1)`);
    await h.pool.query(`INSERT INTO pandocs.questions (space, question, answer, answered, created_at) VALUES ('', 'old question', 'x', false, now() - interval '200 days')`);
    const recent = (await insights()).totals.people;
    expect((await insights(USERS.admin, "insights?days=60")).totals.people).toBe(recent + 100);
    expect((await h.call(USERS.admin, "GET", "insights?days=1000")).status).toBe(422);
    await h.services.stats.sweep();
    expect((await insights(USERS.admin, "insights?days=365")).totals.people).toBe(recent + 100);
    expect((await h.pool.query(`SELECT 1 FROM pandocs.search_terms WHERE term = 'old words'`)).rowCount).toBe(0);
    expect((await h.pool.query(`SELECT 1 FROM pandocs.questions WHERE question = 'old question'`)).rowCount).toBe(0);
  });

  it("lists questions, unanswered ones counted apart", async () => {
    await h.services.stats.recordQuestion({ space: "shop", question: "Refunds?", answer: "On the card [1].", citations: [{ title: "Returns", url: "/shop/returns" }], answered: true });
    await h.services.stats.recordQuestion({ space: "", question: "Unicorns?", answer: "Not here.", citations: [], answered: false });
    const site = await insights();
    expect(site.totals).toMatchObject({ questions: 2, unanswered: 1 });
    expect(site.questions.map((row: { question: string }) => row.question)).toEqual(["Unicorns?", "Refunds?"]);
    const space = await insights(USERS.editor, "spaces/shop/insights");
    expect(space.questions.map((row: { question: string }) => row.question)).toEqual(["Refunds?"]);
    expect(space.totals).toMatchObject({ questions: 1, unanswered: 0 });
  });
});

describe("a site that keeps no numbers", () => {
  it("writes nothing down, and says so", async () => {
    const h = createHarness(fixture.getConnectionString(), { statsDisabled: true });
    await h.call(USERS.admin, "POST", "spaces", { slug: "quiet", name: "Quiet", defaultRole: "viewer" });
    const { data } = await h.call(USERS.admin, "POST", "spaces/quiet/documents", { title: "Page", slug: "page", markdown: "x\n" });
    expect((await h.call(USERS.reader, "POST", "stats/views", { document: data.document.id })).status).toBe(200);
    await h.call(USERS.reader, "POST", "stats/searches", { term: "quiet word", results: 0 });
    expect(await h.services.stats.recordQuestion({ space: "", question: "quiet question", answer: "", citations: [], answered: false })).toBeNull();
    const { collecting, pages } = (await h.call(USERS.admin, "GET", "spaces/quiet/insights")).data;
    expect(collecting).toBe(false);
    expect(pages).toEqual([]);
    expect((await h.pool.query(`SELECT 1 FROM pandocs.search_terms WHERE term = 'quiet word'`)).rowCount).toBe(0);
    await h.close();
  });
});

describe("what readers and agents say about a page", () => {
  let h: ReturnType<typeof createHarness>;
  let page = "";
  let closed = "";
  let hidden = "";

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    await h.call(USERS.admin, "POST", "spaces", { slug: "shop", name: "Shop", defaultRole: "viewer", });
    await h.call(USERS.admin, "PATCH", "spaces/shop", { publicRead: true });
    await h.call(USERS.admin, "PUT", "spaces/shop/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "inside", name: "Inside", defaultRole: "none" });
    page = (await h.call(USERS.editor, "POST", "spaces/shop/documents", { title: "Returns", slug: "returns", markdown: "Seven days.\n" })).data.document.id;
    hidden = (await h.call(USERS.admin, "POST", "spaces/shop/documents", { title: "Secret prices", slug: "cost", markdown: "Secret.\n", restricted: true })).data.document.id;
    closed = (await h.call(USERS.admin, "POST", "spaces/inside/documents", { title: "Inside note", slug: "note", markdown: "Staff.\n" })).data.document.id;
  });
  afterAll(() => h.close());

  const inbox = async (principal: Principal) => (await h.call(principal, "GET", "me/inbox")).data.notifications;
  const list = async (principal: Principal = USERS.editor, path = "spaces/shop/feedback") => (await h.call(principal, "GET", path)).data;

  it("takes a vote from anyone who can read the page, and nobody else", async () => {
    expect((await h.call(ANONYMOUS_PRINCIPAL, "POST", `documents/${page}/feedback`, { kind: "helpful" })).status).toBe(201);
    expect((await h.call(USERS.reader, "POST", `documents/${page}/feedback`, { kind: "unhelpful" })).status).toBe(201);
    expect((await h.call(USERS.reader, "POST", `documents/${closed}/feedback`, { kind: "unhelpful" })).status).toBe(404);
    expect((await h.call(ANONYMOUS_PRINCIPAL, "POST", `documents/${closed}/feedback`, { kind: "helpful" })).status).toBe(404);
    expect((await h.call(ANONYMOUS_PRINCIPAL, "POST", `documents/${hidden}/feedback`, { kind: "helpful" })).status).toBe(404);
    const { totals, pages } = (await h.call(USERS.editor, "GET", "spaces/shop/insights")).data;
    expect(totals).toMatchObject({ helpful: 1, unhelpful: 1 });
    expect(pages[0]).toMatchObject({ documentId: page, helpful: 1, unhelpful: 1, reports: 0 });
    // A vote alone is a number, not something to go through.
    expect(await list()).toEqual([]);
    expect(await inbox(USERS.editor)).toEqual([]);
  });

  it("takes words after a vote, once, from whoever has its id", async () => {
    const { data } = await h.call(ANONYMOUS_PRINCIPAL, "POST", `documents/${page}/feedback`, { kind: "unhelpful" });
    expect((await h.call(ANONYMOUS_PRINCIPAL, "PATCH", `documents/${page}/feedback/${data.id as string}`, { body: "The dates are wrong." })).status).toBe(200);
    expect((await h.call(ANONYMOUS_PRINCIPAL, "PATCH", `documents/${page}/feedback/${data.id as string}`, { body: "Something else." })).status).toBe(404);
    expect((await h.call(ANONYMOUS_PRINCIPAL, "PATCH", `documents/${page}/feedback/not-an-id`, { body: "x" })).status).toBe(404);
    const [first] = await list();
    expect(first).toMatchObject({ kind: "unhelpful", body: "The dates are wrong.", reporter: null, audience: "person", title: "Returns", space: "shop", path: "returns", revision: 1, resolvedAt: null });
  });

  it("tells whoever saved this version, unless that is who is talking", async () => {
    const notifications = await inbox(USERS.editor);
    expect(notifications[0]).toMatchObject({ kind: "feedback", documentId: page, actorName: "", summary: "The dates are wrong." });
    const before = notifications.length;
    await h.call(USERS.editor, "POST", `documents/${page}/feedback`, { kind: "report", body: "My own note." });
    await h.call(USERS.reader, "POST", `documents/${page}/feedback`, { kind: "helpful", body: "Thanks!" });
    expect(await inbox(USERS.editor)).toHaveLength(before);
    await h.call(USERS.reader, "POST", `documents/${page}/feedback`, { kind: "report", body: "Broken link." });
    expect((await inbox(USERS.editor))[0]).toMatchObject({ kind: "feedback", actorName: "读者", summary: "Broken link." });
  });

  it("needs a report to say something", async () => {
    const { status, error } = await h.call(USERS.reader, "POST", `documents/${page}/feedback`, { kind: "report" });
    expect(status).toBe(422);
    expect(error.code).toBe("FEEDBACK_EMPTY");
  });

  it("lets agents report what they find, over the same tools as everything else", async () => {
    const { status, data } = await h.call(USERS.agent, "POST", "tools/doc_report", { doc: page, problem: "The refund period contradicts the policy page.", quote: "Seven days" });
    expect(status).toBe(200);
    expect(data.id).toBeTruthy();
    expect((await list())[0]).toMatchObject({ kind: "report", audience: "agent", reporter: USERS.agent.displayName, quote: "Seven days", body: "The refund period contradicts the policy page." });
    expect((await h.call(ANONYMOUS_PRINCIPAL, "POST", "tools/doc_report", { doc: page, problem: "x" })).status).toBe(401);
  });

  it("is dealt with by those who can change the page, one at a time", async () => {
    const [latest] = await list();
    expect((await h.call(USERS.reader, "POST", `feedback/${latest.id as string}/resolve`, {})).status).toBe(403);
    expect((await h.call(USERS.editor, "POST", `feedback/${latest.id as string}/resolve`, {})).status).toBe(200);
    expect((await list()).map((row: { id: string }) => row.id)).not.toContain(latest.id);
    const resolved = await list(USERS.editor, "spaces/shop/feedback?status=resolved");
    expect(resolved[0]).toMatchObject({ id: latest.id, resolvedBy: USERS.editor.displayName, resolvedAt: expect.any(String) });
    expect((await h.call(USERS.editor, "POST", `feedback/${latest.id as string}/resolve`, { resolved: false })).status).toBe(200);
    expect((await list()).map((row: { id: string }) => row.id)).toContain(latest.id);
    expect((await h.call(USERS.editor, "POST", "feedback/not-an-id/resolve", {})).status).toBe(404);
    expect((await h.call(USERS.editor, "GET", "spaces/shop/feedback?status=nonsense")).status).toBe(422);
  });

  it("is only shown to those it is for, and leaves out pages they cannot read", async () => {
    await h.call(USERS.admin, "POST", `documents/${hidden}/feedback`, { kind: "report", body: "About the secret." });
    expect((await h.call(USERS.reader, "GET", "spaces/shop/feedback")).status).toBe(403);
    expect((await h.call(USERS.editor, "GET", "feedback")).status).toBe(403);
    expect((await list()).map((row: { title: string }) => row.title)).not.toContain("Secret prices");
    expect((await list(USERS.admin, "feedback")).map((row: { title: string }) => row.title)).toContain("Secret prices");
  });
});
