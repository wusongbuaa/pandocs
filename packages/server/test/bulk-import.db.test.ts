import type { BulkImporter } from "@pandocs/core";
import { PermanentIngestError } from "@pandocs/core";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { createFeishuImporter } from "../src/importers/feishu.js";
import { createConfluenceImporter } from "../src/importers/confluence.js";
import { createNotionImporter } from "../src/importers/notion.js";
import { ADMIN, signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";
import { confluenceExport, notionExport } from "./import-sources.js";

const postgres = usePostgresFixture();

/** Does what it is told to, for what the import job itself does about it. */
const scripted: { run: BulkImporter["run"] } = { run: async () => undefined };
const scriptedImporter: BulkImporter = { source: "scripted", input: "url", label: () => "Scripted", run: (input, sink) => scripted.run(input, sink) };

describe("importing a whole set of pages", () => {
  let server: TestServer;
  let admin: Client;
  let member: Client;

  const upload = async (person: Client, source: string, bytes: Uint8Array, fields: Record<string, string> = {}, space = "shop") => {
    const form = new FormData();
    form.set("source", source);
    form.set("file", new File([bytes as BlobPart], `${source}.zip`, { type: "application/zip" }));
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const response = await person.request(`/api/v1/spaces/${space}/bulk-imports`, { method: "POST", body: form });
    return { status: response.status, ...(await response.json() as { data: { id: string; status: string; report: any; error: string; progress: any }; error?: { code: string } }) };
  };
  const drain = async () => {
    while (await server.runtime.services.bulkImports.tick()) { /* until none are left */ }
  };
  const stateOf = async (id: string) => (await admin.json("GET", `/api/v1/bulk-imports/${id}`)).data;
  const treeOf = async (space = "shop") => (await admin.json("GET", `/api/v1/spaces/${space}/tree`)).data as { id: string; path: string; title: string; currentRevisionNo: number }[];

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString(), {}, { importers: [createNotionImporter(), createConfluenceImporter(), scriptedImporter] });
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "书店", defaultRole: "viewer" });
    await admin.json("POST", "/api/v1/spaces", { slug: "wiki", name: "Wiki", defaultRole: "viewer" });
    await admin.json("POST", "/api/v1/spaces", { slug: "under", name: "Under", defaultRole: "viewer" });
    member = server.client();
    const invited = await admin.json("POST", "/api/v1/admin/users", { email: "reader@example.test", displayName: "Reader", password: "a-long-enough-password" });
    expect(invited.status).toBe(201);
    await member.form("/login", { email: "reader@example.test", password: "a-long-enough-password", next: "/" });
  });
  beforeEach(() => {
    scripted.run = async () => undefined;
  });
  afterAll(() => server.close());

  it("says what it can import from", async () => {
    expect((await admin.json("GET", "/api/v1/bulk-imports/sources")).data).toEqual([{ source: "notion", input: "file" }, { source: "confluence", input: "file" }, { source: "scripted", input: "url" }]);
  });

  it("brings in a Notion export as real pages, as whoever asked, with their images", async () => {
    const { data: job, status } = await upload(admin, "notion", notionExport());
    expect(status).toBe(201);
    expect(job.status).toBe("queued");
    await drain();
    const done = await stateOf(job.id);
    expect(done.status).toBe("succeeded");
    expect(done.progress).toEqual({ done: 10, total: 10 });
    expect(done.report).toMatchObject({ created: 10, updated: 0, unchanged: 0, assets: 3 });

    const tree = await treeOf();
    expect(tree.map(node => node.path)).toEqual(expect.arrayContaining(["handbook", "handbook/returns", "handbook/returns/refund", "orders/first-order"]));
    const home = tree.find(node => node.path === "handbook")!;
    const { data: view } = await admin.json("GET", `/api/v1/documents/${home.id}`);
    expect(view.revision).toMatchObject({ actorName: ADMIN.displayName, message: "Imported from Notion" });
    expect(view.diagnostics.filter((item: { severity: string }) => item.severity === "error")).toEqual([]);
    const image = /assets\/([a-f0-9]{64})\.png/u.exec(view.markdown as string)![1]!;
    const stored = await admin.request(`/api/v1/spaces/shop/assets/${image}`);
    expect(stored.status).toBe(200);
    expect(stored.headers.get("content-type")).toBe("image/png");
  });

  it("changes only what has changed when done again", async () => {
    const before = await treeOf();
    const { data: job } = await upload(admin, "notion", notionExport());
    await drain();
    expect((await stateOf(job.id)).report).toMatchObject({ created: 0, updated: 0, unchanged: 10 });
    expect((await treeOf()).map(node => [node.path, node.currentRevisionNo])).toEqual(before.map(node => [node.path, node.currentRevisionNo]));
  });

  it("brings in a Confluence export, with its files, and its pages searchable", async () => {
    const { data: job } = await upload(admin, "confluence", confluenceExport(), {}, "wiki");
    await drain();
    expect((await stateOf(job.id)).report).toMatchObject({ created: 6, assets: 3, notes: [] });
    const hits = (await admin.json("GET", "/api/v1/search?q=Read%20this%20first&space=wiki")).data;
    expect(hits.map((hit: { path: string }) => hit.path)).toEqual(["docs-home"]);
  });

  it("puts everything under a page when told to, links still working", async () => {
    await admin.json("POST", "/api/v1/spaces/under/documents", { title: "Old wiki", slug: "old", markdown: "" });
    const { data: job } = await upload(admin, "confluence", confluenceExport(), { parentPath: "old" }, "under");
    await drain();
    expect((await stateOf(job.id)).status).toBe("succeeded");
    const tree = await treeOf("under");
    expect(tree.map(node => node.path)).toEqual(expect.arrayContaining(["old/docs-home", "old/docs-home/guide"]));
    const { data: guide } = await admin.json("GET", `/api/v1/documents/${tree.find(node => node.path === "old/docs-home/guide")!.id}`);
    expect(guide.markdown).toContain("[home](../docs-home.md)");
    expect((await upload(admin, "confluence", confluenceExport(), { parentPath: "nowhere" }, "under")).status).toBe(404);
  });

  it("is for those who can write in the space, whether to start one or look at one", async () => {
    const { data: job } = await upload(admin, "notion", notionExport());
    expect((await upload(member, "notion", notionExport())).status).toBe(403);
    expect((await member.json("GET", "/api/v1/spaces/shop/bulk-imports")).status).toBe(403);
    expect((await member.json("GET", `/api/v1/bulk-imports/${job.id}`)).status).toBe(404);
    expect((await member.json("POST", `/api/v1/bulk-imports/${job.id}/cancel`)).status).toBe(404);
    expect((await admin.json("POST", `/api/v1/bulk-imports/${job.id}/cancel`)).data.status).toBe("cancelled");
    await drain();
  });

  it("runs with the rights its starter has when it runs, not when they asked", async () => {
    await admin.json("POST", "/api/v1/spaces", { slug: "closed", name: "Closed", defaultRole: "none" });
    const created = await admin.json("POST", "/api/v1/admin/users", { email: "second@example.test", displayName: "Second", password: "a-long-enough-password", isAdmin: true });
    const second = server.client();
    await second.form("/login", { email: "second@example.test", password: "a-long-enough-password", next: "/" });
    scripted.run = async (_input, sink) => {
      await sink.page({ path: "written", title: "Written", markdown: "By an administrator.\n" });
    };
    const { data: job } = await second.json("POST", "/api/v1/spaces/closed/bulk-imports", { source: "scripted", url: "x" });
    expect(job.status).toBe("queued");
    // Only being an administrator let them into this space, and now they are not one.
    expect((await admin.json("PATCH", `/api/v1/admin/users/${created.data.id}`, { isAdmin: false })).status).toBe(200);
    await drain();
    expect((await stateOf(job.id)).status).not.toBe("succeeded");
    expect(await treeOf("closed")).toEqual([]);
    await admin.json("POST", `/api/v1/bulk-imports/${job.id}/cancel`);
  });

  it("does not say who it runs as", async () => {
    const { data: job } = await upload(admin, "notion", notionExport());
    expect(JSON.stringify(await stateOf(job.id))).not.toContain("scopes");
    await admin.json("POST", `/api/v1/bulk-imports/${job.id}/cancel`);
  });

  it("does not hold on to an uploaded file once it is done with it", async () => {
    const { data: job } = await upload(admin, "notion", notionExport());
    const stored = () => server.runtime.services.context.ports.assets.get(`imports/${job.id}`);
    expect(await stored()).not.toBeNull();
    await drain();
    expect(await stored()).toBeNull();
  });

  it("refuses what it has no way to read, and says why", async () => {
    expect((await upload(admin, "wordperfect", strToU8("x"))).error?.code).toBe("IMPORT_SOURCE_UNKNOWN");
    const { data: job } = await upload(admin, "notion", strToU8("not a zip"));
    await drain();
    const state = await stateOf(job.id);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("This is not a valid archive");
    expect((await admin.json("POST", `/api/v1/bulk-imports/${job.id}/retry`)).error.code).toBe("IMPORT_FILE_GONE");
  });

  it("needs an address for what reads from an address", async () => {
    expect((await admin.json("POST", "/api/v1/spaces/shop/bulk-imports", { source: "scripted", url: " " })).status).toBe(422);
    expect((await admin.json("POST", "/api/v1/spaces/shop/bulk-imports", { source: "notion", url: "https://example.com" })).status).toBe(422);
  });

  it("reports a page that cannot come in, and brings in the rest", async () => {
    scripted.run = async (_input, sink) => {
      await sink.page({ path: "bad path!/x", title: "Under nothing", markdown: "x\n" });
      await sink.page({ path: "a page that is far too long ".repeat(10), title: "Bad address", markdown: "x\n" });
      await sink.page({ path: "fine", title: "Fine", markdown: "Good.\n" });
    };
    const { data: job } = await admin.json("POST", "/api/v1/spaces/shop/bulk-imports", { source: "scripted", url: "x" });
    await drain();
    const state = await stateOf(job.id);
    expect(state.status).toBe("succeeded");
    expect(state.report.created).toBe(1);
    expect(state.report.notes.map((note: { file: string }) => note.file)).toEqual(["Under nothing", "Bad address"]);
  });

  it("tries again later when something goes wrong that might not next time, and then gives up", async () => {
    let tries = 0;
    scripted.run = async () => {
      tries += 1;
      throw new Error("The network went away");
    };
    const { data: job } = await admin.json("POST", "/api/v1/spaces/shop/bulk-imports", { source: "scripted", url: "x" });
    const dueNow = () => server.runtime.pool.query("UPDATE pandocs.bulk_imports SET next_run_at = now() WHERE id = $1", [job.id]);
    await drain();
    expect(await stateOf(job.id)).toMatchObject({ status: "queued", error: "The network went away" });
    await dueNow();
    await drain();
    await dueNow();
    await drain();
    expect(await stateOf(job.id)).toMatchObject({ status: "failed", error: "The network went away" });
    expect(tries).toBe(3);
    expect(await server.runtime.services.bulkImports.tick()).toBe(false);

    scripted.run = async () => undefined;
    expect((await admin.json("POST", `/api/v1/bulk-imports/${job.id}/retry`)).data.status).toBe("queued");
    await drain();
    expect((await stateOf(job.id)).status).toBe("succeeded");
    expect((await admin.json("POST", `/api/v1/bulk-imports/${job.id}/retry`)).status).toBe(422);
  });

  it("does not try again what trying again cannot help", async () => {
    let tries = 0;
    scripted.run = async () => {
      tries += 1;
      throw new PermanentIngestError("NOPE", "Never going to work");
    };
    const { data: job } = await admin.json("POST", "/api/v1/spaces/shop/bulk-imports", { source: "scripted", url: "x" });
    await drain();
    expect(await stateOf(job.id)).toMatchObject({ status: "failed", error: "Never going to work" });
    expect(tries).toBe(1);
  });

  it("stops part of the way through when cancelled, keeping what came in", async () => {
    let cancelled = false;
    let job = { id: "" };
    scripted.run = async (_input, sink) => {
      sink.expect(3);
      await sink.page({ path: "stops-1", title: "One", markdown: "x\n" });
      await admin.json("POST", `/api/v1/bulk-imports/${job.id}/cancel`);
      cancelled = true;
      await sink.page({ path: "stops-2", title: "Two", markdown: "x\n" });
      await sink.page({ path: "stops-3", title: "Three", markdown: "x\n" });
    };
    job = (await admin.json("POST", "/api/v1/spaces/shop/bulk-imports", { source: "scripted", url: "x" })).data;
    await drain();
    expect(cancelled).toBe(true);
    expect((await stateOf(job.id)).status).toBe("cancelled");
    const paths = (await treeOf()).map(node => node.path);
    expect(paths).toContain("stops-1");
    expect(paths).not.toContain("stops-2");
    expect((await admin.json("POST", `/api/v1/bulk-imports/${job.id}/cancel`)).status).toBe(422);
  });

  it("is picked up again after whatever was running it has died", async () => {
    let tries = 0;
    scripted.run = async (_input, sink) => {
      tries += 1;
      await sink.page({ path: "recovered", title: "Recovered", markdown: "x\n" });
    };
    const { data: job } = await admin.json("POST", "/api/v1/spaces/shop/bulk-imports", { source: "scripted", url: "x" });
    await server.runtime.pool.query("UPDATE pandocs.bulk_imports SET status = 'running', lease_owner = 'dead', lease_until = now() - interval '1 second', attempts = 1 WHERE id = $1", [job.id]);
    await drain();
    expect(tries).toBe(1);
    expect(await stateOf(job.id)).toMatchObject({ status: "succeeded" });
  });

  it("lets another worker alone while one is alive", async () => {
    const { data: job } = await admin.json("POST", "/api/v1/spaces/shop/bulk-imports", { source: "scripted", url: "x" });
    await server.runtime.pool.query("UPDATE pandocs.bulk_imports SET status = 'running', lease_owner = 'alive', lease_until = now() + interval '1 minute' WHERE id = $1", [job.id]);
    expect(await server.runtime.services.bulkImports.tick()).toBe(false);
    await admin.json("POST", `/api/v1/bulk-imports/${job.id}/cancel`);
  });
});

describe("importing from Feishu, only where an app is set up", () => {
  it("is not offered without credentials, and is with them", async () => {
    const without = await startServer(postgres.getConnectionString());
    try {
      const person = await signInFirstAdmin(without).catch(() => null) ?? without.client();
      await person.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/" });
      const sources = (await person.json("GET", "/api/v1/bulk-imports/sources")).data as { source: string }[];
      expect(sources.map(item => item.source)).toEqual(["notion", "confluence"]);
    } finally {
      await without.close();
    }
    const withApp = await startServer(postgres.getConnectionString(), { PANDOCS_FEISHU_APP_ID: "cli_test", PANDOCS_FEISHU_APP_SECRET: "secret" });
    try {
      const person = withApp.client();
      await person.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/" });
      const sources = (await person.json("GET", "/api/v1/bulk-imports/sources")).data as { source: string }[];
      expect(sources).toContainEqual({ source: "feishu", input: "url" });
    } finally {
      await withApp.close();
    }
  });

  it("writes pages from what the API gives, through the same job as everything else", async () => {
    const answer = (data: object) => new Response(JSON.stringify({ code: 0, msg: "ok", data }), { headers: { "content-type": "application/json" } });
    const fake: typeof fetch = async target => {
      const { pathname } = new URL(String(target));
      if (pathname.endsWith("/tenant_access_token/internal")) return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }), { headers: { "content-type": "application/json" } });
      if (pathname.endsWith("/blocks")) return answer({ items: [{ block_id: "r", block_type: 1, page: { elements: [] }, children: ["a"] }, { block_id: "a", block_type: 2, text: { elements: [{ text_run: { content: "From the API." } }] } }], has_more: false });
      return answer({ document: { document_id: "d", revision_id: 1, title: "API page" } });
    };
    const server = await startServer(postgres.getConnectionString(), {}, { importers: [createFeishuImporter({ appId: "a", appSecret: "b", baseUrl: "https://open.feishu.cn" }, { fetch: fake, sleep: async () => undefined })] });
    try {
      const person = server.client();
      await person.form("/login", { email: ADMIN.email, password: ADMIN.password, next: "/" });
      await person.json("POST", "/api/v1/spaces", { slug: "fromapi", name: "API", defaultRole: "viewer" });
      const { data: job } = await person.json("POST", "/api/v1/spaces/fromapi/bulk-imports", { source: "feishu", url: "https://example.feishu.cn/docx/d" });
      while (await server.runtime.services.bulkImports.tick()) { /* until none are left */ }
      expect((await person.json("GET", `/api/v1/bulk-imports/${job.id as string}`)).data.report).toMatchObject({ created: 1 });
      const [page] = (await person.json("GET", "/api/v1/spaces/fromapi/tree")).data as { id: string; title: string }[];
      expect(page!.title).toBe("API page");
      expect((await person.json("GET", `/api/v1/documents/${page!.id}`)).data.markdown).toBe("From the API.\n");
    } finally {
      await server.close();
    }
  });
});
