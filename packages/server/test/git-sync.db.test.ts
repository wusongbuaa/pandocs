import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { GitHost, hasGit, type Person } from "./git-host.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const fixture = usePostgresFixture();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe.skipIf(!hasGit)("a space and a real repository, kept the same", () => {
  const host = new GitHost();
  let server: TestServer;
  let admin: Client;
  let repoNo = 0;
  let space = "";
  let repository = "";
  let name = "";

  const sync = async () => {
    await server.pool.query(`UPDATE pandocs.git_syncs SET due_at = now()`);
    while (await server.runtime.services.gitSync.tick()) { /* until none are due */ }
  };
  const create = async (title: string, slug: string, markdown: string, parentPath?: string) => {
    const made = await admin.json("POST", `/api/v1/spaces/${space}/documents`, { title, slug, markdown, ...(parentPath ? { parentPath } : {}) });
    expect(made.error).toBeUndefined();
    return made.data.document as { id: string };
  };
  const pageText = async (path: string) => {
    const { data: found } = await admin.json("GET", `/api/v1/spaces/${space}/resolve?path=${encodeURIComponent(path)}`);
    const { data: view } = await admin.json("GET", `/api/v1/documents/${found.id as string}`);
    return view.markdown as string;
  };
  const connect = async (body: object = {}) => {
    const saved = await admin.json("PUT", `/api/v1/spaces/${space}/git-sync`, { repository, ...body });
    expect(saved.error).toBeUndefined();
    return saved.data as { hookPath: string; lastError: string | null };
  };
  const pulled = (person: Person) => {
    person.pull();
    return person;
  };

  beforeAll(async () => {
    await host.start();
    server = await startServer(fixture.getConnectionString(), { PANDOCS_GIT_ALLOW_PRIVATE: "true" });
    admin = await signInFirstAdmin(server);
  });
  afterAll(async () => {
    await server.close();
    await host.stop();
  });
  beforeEach(async () => {
    repoNo += 1;
    name = `docs-${repoNo}`;
    space = `space-${repoNo}`;
    repository = host.create(name);
    await server.pool.query(`DELETE FROM pandocs.git_syncs`);
    const made = await admin.json("POST", "/api/v1/spaces", { slug: space, name: "Docs" });
    expect(made.error).toBeUndefined();
  });

  it("goes both ways through real Git, with pictures, renames and deletions", async () => {
    const uploaded = await admin.request(`/api/v1/spaces/${space}/assets?filename=a.png`, { method: "POST", body: PNG });
    const asset = (await uploaded.json() as { data: { path: string; sha256: string } }).data;
    await create("Guide", "guide", `# Guide\n\n![a](${asset.path})\n`);
    await create("Team", "team", "");
    await create("Rules", "rules", `Rules\n\n![a](${asset.path})\n`, "team");
    await connect();
    await sync();

    const grace = host.person(name);
    expect(grace.files).toEqual([".pandocs/pages.json", asset.path, "guide.md", "team/rules.md"]);
    expect(grace.read("team/rules.md")).toBe(`Rules\n\n![a](../${asset.path})\n`);
    expect(grace.log("%s")).toMatch(/2/u);

    // Someone pushes an edit, a new page in a new folder, a rename and a deletion.
    grace.commit({ "guide.md": `# Guide\n\nEdited with Git.\n\n![a](${asset.path})\n`, "more/new.md": "# Brand new\n\nHello.\n" }, "Edit and add");
    await sync();
    expect(await pageText("guide")).toContain("Edited with Git.");
    expect(await pageText("more/new")).toContain("Hello.");
    const { data: tree } = await admin.json("GET", `/api/v1/spaces/${space}/tree`);
    expect(tree.find((node: { path: string }) => node.path === "more/new").title).toBe("Brand new");
    const rulesId = tree.find((node: { path: string }) => node.path === "team/rules").id as string;

    pulled(grace).commit({ "team/rules.md": null, "team/policies.md": grace.read("team/rules.md"), "more/new.md": null }, "Rename and delete");
    await sync();
    const { data: after } = await admin.json("GET", `/api/v1/spaces/${space}/tree`);
    const paths = after.map((node: { path: string }) => node.path).sort();
    expect(paths).toEqual(["guide", "team", "team/policies"]);
    expect(after.find((node: { path: string }) => node.path === "team/policies").id).toBe(rulesId);
    expect((await admin.json("GET", `/api/v1/spaces/${space}/git-sync`)).data.sync.lastError).toBeNull();

    // A page edited here reaches the repository, under the name of whoever edited it.
    const guide = after.find((node: { path: string }) => node.path === "guide");
    const { data: view } = await admin.json("GET", `/api/v1/documents/${guide.id as string}`);
    const saved = await admin.json("PUT", `/api/v1/documents/${guide.id as string}/content`, { markdown: `${await pageText("guide")}\nEdited here.\n`, expectedRevision: view.revision.no }, { "idempotency-key": crypto.randomUUID() });
    expect(saved.error, JSON.stringify(saved.error)).toBeUndefined();
    await sync();
    expect(pulled(grace).read("guide.md")).toContain("Edited here.");
    expect(grace.log("%cn")).toBe("Pandocs");
    expect(grace.log("%an")).not.toBe("Pandocs");
  });

  it("merges edits in different places made at once on both sides", async () => {
    const page = await create("Guide", "guide", "First.\n\nSecond.\n\nThird.\n");
    await connect();
    await sync();
    const grace = host.person(name);
    grace.commit({ "guide.md": "First.\n\nSecond.\n\nThird from Git.\n" }, "Change the end");
    const { data: view } = await admin.json("GET", `/api/v1/documents/${page.id}`);
    await admin.json("PUT", `/api/v1/documents/${page.id}/content`, { markdown: "First from here.\n\nSecond.\n\nThird.\n", expectedRevision: view.revision.no }, { "idempotency-key": crypto.randomUUID() });
    await sync();
    const merged = "First from here.\n\nSecond.\n\nThird from Git.\n";
    expect(await pageText("guide")).toBe(merged);
    expect(pulled(grace).read("guide.md")).toBe(merged);
  });

  it("pulls only what it needs from a repository with files it has no interest in", async () => {
    const grace = host.person(name);
    grace.commit({ "README.md": "Readme\n", "src/main.bin": new Uint8Array(4096), "docs/guide.md": "Guide\n" }, "Set up");
    host.requests.length = 0;
    await connect({ folder: "docs" });
    await sync();
    expect(await pageText("guide")).toBe("Guide\n");
    expect(pulled(grace).files).toEqual(["README.md", "docs/.pandocs/pages.json", "docs/guide.md", "src/main.bin"]);
  });

  it("wakes up when a repository's webhook calls, with no login and from nowhere in particular", async () => {
    const { hookPath } = await connect();
    await sync();
    await server.pool.query(`UPDATE pandocs.git_syncs SET due_at = now() + interval '1 hour'`);
    const stranger = server.client();
    const unknown = await stranger.request("/api/v1/git-hooks/not-a-real-one", { method: "POST" });
    expect(unknown.status).toBe(404);
    const due = async () => (await server.pool.query<{ due: boolean }>(`SELECT due_at <= now() AS due FROM pandocs.git_syncs`)).rows[0]!.due;
    expect(await due()).toBe(false);
    const called = await stranger.request(hookPath, { method: "POST", body: JSON.stringify({ ref: "refs/heads/main" }), headers: { "content-type": "application/json", "x-github-event": "push", origin: "https://github.com" } });
    expect(called.status).toBe(202);
    expect(await due()).toBe(true);
    expect((await stranger.request(hookPath)).status).not.toBe(202);
  });

  it("is what the background worker does", async () => {
    await create("Guide", "guide", "From the worker\n");
    await connect();
    server.runtime.worker.start();
    try {
      await expect.poll(() => host.head(name), { timeout: 10_000, interval: 100 }).not.toBeNull();
    } finally {
      server.runtime.worker.stop();
    }
    expect(host.person(name).read("guide.md")).toBe("From the worker\n");
  });

  it("refuses private addresses unless the server has said otherwise", async () => {
    const careful = await startServer(fixture.getConnectionString());
    try {
      await create("Guide", "guide", "One\n");
      await connect();
      host.requests.length = 0;
      await server.pool.query(`UPDATE pandocs.git_syncs SET due_at = now()`);
      while (await careful.runtime.services.gitSync.tick()) { /* until none are due */ }
      const { data } = await admin.json("GET", `/api/v1/spaces/${space}/git-sync`);
      expect(data.sync.lastError).toEqual(expect.any(String));
      expect(host.requests).toEqual([]);
      expect(host.head(name)).toBeNull();
    } finally {
      await careful.close();
    }
  });
});
