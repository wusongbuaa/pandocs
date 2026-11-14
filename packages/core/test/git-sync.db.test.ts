import { createHash } from "node:crypto";
import { gitBlobId, type Principal } from "@pandocs/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeRepository } from "./fake-git.js";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const REPOSITORY = "https://git.example.com/acme/docs.git";

describe("keeping a space and a repository the same", () => {
  let h: ReturnType<typeof createHarness>;
  let repo: FakeRepository;
  let spaceNo = 0;
  let space = "";

  const connect = async (body: object = {}, principal: Principal = USERS.admin) =>
    h.call(principal, "PUT", `spaces/${space}/git-sync`, { repository: REPOSITORY, token: "secret-token", ...body });
  /** It is due now, and whatever is due gets looked at. */
  const sync = async () => {
    await h.pool.query(`UPDATE pandocs.git_syncs SET due_at = now()`);
    while (await h.services.gitSync.tick()) {
      /* until none are due */
    }
  };
  /** Long enough ago that nothing counts as having just changed. */
  const settle = () => h.pool.query(`UPDATE pandocs.documents SET updated_at = now() - interval '1 hour'`);
  const create = async (path: string, markdown: string, more: object = {}) => {
    const slash = path.lastIndexOf("/");
    const made = await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
      title: more && "title" in more ? more.title : path,
      slug: path.slice(slash + 1),
      markdown,
      ...(slash > 0 ? { parentPath: path.slice(0, slash) } : {}),
      ...more
    });
    expect(made.error).toBeUndefined();
    return made.data.document as { id: string; path: string };
  };
  const pages = async () => {
    const { rows } = await h.pool.query<{ path: string; markdown: string }>(
      `SELECT d.path, r.markdown FROM pandocs.documents d JOIN pandocs.spaces s ON s.id = d.space_id JOIN pandocs.revisions r ON r.document_id = d.id AND r.no = d.current_revision_no WHERE s.slug = $1 AND d.deleted_at IS NULL ORDER BY d.path`,
      [space]
    );
    return Object.fromEntries(rows.map(row => [row.path, row.markdown]));
  };
  const pageOf = async (path: string) => {
    const { rows } = await h.pool.query(
      `SELECT d.* FROM pandocs.documents d JOIN pandocs.spaces s ON s.id = d.space_id WHERE s.slug = $1 AND d.path = $2 AND d.deleted_at IS NULL`,
      [space, path]
    );
    return rows[0] as { id: string; title: string; sort_order: number; current_revision_no: number } | undefined;
  };
  const edit = async (path: string, markdown: string) => {
    const page = await pageOf(path);
    const saved = await h.write(USERS.admin, "PUT", `documents/${page!.id}/content`, {
      markdown,
      expectedRevision: page!.current_revision_no
    });
    expect(saved.error).toBeUndefined();
  };
  const notes = async () => {
    const { data } = await h.call(USERS.admin, "GET", `spaces/${space}/git-sync/runs`);
    return (data as { notes: { file: string; reason: string }[] }[]).flatMap(run => run.notes);
  };
  const status = async () =>
    (await h.call(USERS.admin, "GET", `spaces/${space}/git-sync`)).data.sync as {
      lastError: string | null;
      lastCommit: string | null;
      lastSuccessAt: string | null;
      hasToken: boolean;
      hookPath: string;
    };

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString(), {
      git: { head: remote => repo.head(remote), open: remote => repo.open(remote) }
    });
  });
  beforeEach(async () => {
    repo = new FakeRepository();
    spaceNo += 1;
    space = `space-${spaceNo}`;
    await h.pool.query(`DELETE FROM pandocs.git_syncs`);
    const made = await h.call(USERS.admin, "POST", "spaces", { slug: space, name: "Docs", defaultRole: "viewer" });
    expect(made.error).toBeUndefined();
    await h.call(USERS.admin, "PUT", `spaces/${space}/members`, { subject: `user:${USERS.editor.id}`, role: "editor" });
  });
  afterAll(() => h.close());

  describe("settings", () => {
    it("never shows a token again", async () => {
      const saved = await connect();
      expect(saved.error).toBeUndefined();
      expect(saved.data.hasToken).toBe(true);
      expect(JSON.stringify(saved.data)).not.toContain("secret-token");
      const { data: read } = await h.call(USERS.admin, "GET", `spaces/${space}/git-sync`);
      expect(read.available).toBe(true);
      expect(JSON.stringify(read)).not.toContain("secret-token");
      const { data: audit } = await h.call(USERS.admin, "GET", `spaces/${space}/audit`);
      expect(JSON.stringify(audit)).not.toContain("secret-token");
      await sync();
      expect(repo.remotes[0]).toEqual({ repository: REPOSITORY, branch: "main", token: "secret-token" });
    });

    it("keeps a token when the address stays, and drops it when the address changes, so that it cannot be sent somewhere else", async () => {
      await connect();
      expect((await connect({ token: undefined, branch: "docs" })).data.hasToken).toBe(true);
      expect(
        (await connect({ token: undefined, repository: "https://evil.example.com/collect.git" })).data.hasToken
      ).toBe(false);
      await sync();
      expect(repo.remotes.at(-1)).toMatchObject({ repository: "https://evil.example.com/collect.git", token: "" });
    });

    it("is for a space's administrators", async () => {
      expect((await connect({}, USERS.editor)).status).toBe(403);
      await connect();
      expect((await h.call(USERS.editor, "GET", `spaces/${space}/git-sync`)).status).toBe(403);
      expect((await h.call(USERS.editor, "GET", `spaces/${space}/git-sync/runs`)).status).toBe(403);
      expect((await h.call(USERS.editor, "POST", `spaces/${space}/git-sync/run`)).status).toBe(403);
      expect((await h.call(USERS.editor, "DELETE", `spaces/${space}/git-sync`)).status).toBe(403);
    });

    it.each([
      ["a file on this machine", { repository: "file:///etc/passwd" }],
      ["a command", { repository: "ext::sh -c id" }],
      ["SSH", { repository: "git@git.example.com:acme/docs.git" }],
      ["credentials in the address", { repository: "https://someone:hunter2@git.example.com/acme/docs.git" }],
      ["a branch that reads as an option", { branch: "--upload-pack=touch" }],
      ["a branch with a pattern", { branch: "main*" }],
      ["a folder outside the repository", { folder: "../../etc" }],
      ["an unknown field", { url: "https://git.example.com/x.git" }]
    ])("refuses %s", async (_name, body) => {
      expect((await connect(body)).status).toBe(422);
    });

    it("accepts a folder with a name in any language, and tidies its slashes", async () => {
      const { data } = await connect({ folder: "/文档/guide/" });
      expect(data.folder).toBe("文档/guide");
    });

    it("says so when this server cannot run Git", async () => {
      const without = createHarness(fixture.getConnectionString());
      try {
        const { data } = await without.call(USERS.admin, "GET", `spaces/${space}/git-sync`);
        expect(data).toEqual({ available: false, sync: null });
        const saved = await without.call(USERS.admin, "PUT", `spaces/${space}/git-sync`, { repository: REPOSITORY });
        expect(saved.status).toBe(422);
        expect(saved.error.code).toBe("GIT_UNAVAILABLE");
        expect(await without.services.gitSync.tick()).toBe(false);
      } finally {
        await without.close();
      }
    });

    it("leaves the pages and the repository alone when disconnected", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      expect((await h.call(USERS.admin, "DELETE", `spaces/${space}/git-sync`)).status).toBe(200);
      expect(await pages()).toEqual({ guide: "One\n" });
      expect(repo.read("guide.md")).toBe("One\n");
      expect((await h.call(USERS.admin, "GET", `spaces/${space}/git-sync`)).data.sync).toBeNull();
      expect((await h.call(USERS.admin, "POST", `spaces/${space}/git-sync/run`)).status).toBe(404);
    });
  });

  describe("sending to the repository", () => {
    it("writes a space into an empty repository, and a page that only holds others is just a folder", async () => {
      await create("guide", "# Guide\n");
      await create("team", "");
      await create("team/rules", "Rules\n", { title: "The rules" });
      await connect();
      await sync();
      expect(repo.paths).toEqual([".pandocs/pages.json", "guide.md", "team/rules.md"]);
      expect(repo.read("team/rules.md")).toBe("Rules\n");
      expect(repo.pushes).toHaveLength(1);
      expect(repo.pushes[0]!.message).toMatch(/2/u);
      const details = JSON.parse(repo.read(".pandocs/pages.json")!);
      expect(details.pages["team/rules"].title).toBe("The rules");
      expect(details.pages.team.title).toBe("team");
      const state = await status();
      expect(state.lastError).toBeNull();
      expect(state.lastCommit).toBe(repo.latest);
    });

    it("uses a folder, and leaves everything outside it alone", async () => {
      await create("guide", "Ours\n");
      repo.commit({ "README.md": "Theirs\n", "src/main.ts": "code\n" });
      await connect({ folder: "docs" });
      await sync();
      expect(repo.paths).toEqual(["README.md", "docs/.pandocs/pages.json", "docs/guide.md", "src/main.ts"]);
      expect(Object.keys(await pages())).toEqual(["guide"]);
    });

    it("stops once another replica has taken the sync over, writing down and sending nothing more", async () => {
      await connect();
      repo.commit({ "a.md": "# A\n\nFrom Git.\n", "b.md": "# B\n\nFrom Git too.\n" });
      // As if this run had stalled past its lease and another replica had started over meanwhile.
      repo.onRead = async () =>
        void (await h.pool.query(`UPDATE pandocs.git_syncs SET lease_owner = gen_random_uuid()`));
      await sync();
      const {
        rows: [state]
      } = await h.pool.query(
        `SELECT consecutive_failures, last_error, (SELECT count(*) FROM pandocs.git_sync_files f WHERE f.sync_id = s.id)::int AS remembered FROM pandocs.git_syncs s`
      );
      expect(state).toEqual({ consecutive_failures: 0, last_error: null, remembered: 0 });
      expect(repo.pushes).toEqual([]);
      expect(Object.keys(await pages()).length).toBeLessThanOrEqual(1);
    });

    it("does not even make a copy when nothing has happened on either side", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      await settle();
      const { opens } = repo;
      const pushes = repo.pushes.length;
      await sync();
      expect(repo.opens).toBe(opens);
      expect(repo.pushes).toHaveLength(pushes);
      expect((await status()).lastSuccessAt).not.toBeNull();
    });

    it("sends only what changed, in the name of whoever changed it", async () => {
      await create("guide", "One\n");
      await create("other", "Other\n");
      await connect();
      await sync();
      await edit("guide", "Two\n");
      await sync();
      expect(repo.pushes).toHaveLength(2);
      expect(repo.pushes[1]!.write).toEqual(["guide.md"]);
      expect(repo.pushes[1]!.author).toBe(USERS.admin.displayName);
      expect(repo.pushes[1]!.message).toContain("guide");
      expect(repo.read("guide.md")).toBe("Two\n");
    });

    it("soon after a save, a run of saves being one commit", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      await h.pool.query(`UPDATE pandocs.git_syncs SET due_at = now() + interval '1 hour'`);
      await edit("guide", "Two\n");
      const { rows } = await h.pool.query<{ soon: boolean }>(
        `SELECT due_at < now() + interval '6 seconds' AS soon FROM pandocs.git_syncs`
      );
      expect(rows[0]!.soon).toBe(true);
    });

    it("sends pictures with the pages, linked so that they work in the repository too", async () => {
      const asset = (await h.call(USERS.admin, "POST", `spaces/${space}/assets?filename=a.png`, PNG)).data as {
        path: string;
        sha256: string;
      };
      await create("top", `![a](${asset.path})\n`);
      await create("deep", "");
      await create("deep/down", `![a](${asset.path})\n`);
      await connect();
      await sync();
      expect(new Uint8Array(repo.files.get(asset.path)!)).toEqual(PNG);
      expect(repo.read("top.md")).toBe(`![a](${asset.path})\n`);
      expect(repo.read("deep/down.md")).toBe(`![a](../${asset.path})\n`);
      // And that does not come back as a change.
      repo.commit({ "other.md": "Another\n" });
      await sync();
      expect((await pages())["deep/down"]).toBe(`![a](${asset.path})\n`);
      expect(repo.pushes.at(-1)!.write).not.toContain("deep/down.md");
    });

    it("moves and removes files when pages move and go", async () => {
      await create("old", "Moves\n");
      await create("doomed", "Goes\n");
      await connect();
      await sync();
      const page = await pageOf("old");
      await h.call(USERS.admin, "POST", `documents/${page!.id}/move`, { slug: "new" });
      const doomed = await pageOf("doomed");
      await h.call(USERS.admin, "DELETE", `documents/${doomed!.id}`);
      await sync();
      expect(repo.paths).toEqual([".pandocs/pages.json", "new.md"]);
      expect(await pages()).toEqual({ new: "Moves\n" });
      expect(await notes()).toEqual([]);
    });

    it("takes titles along without calling that a page changing", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      const page = await pageOf("guide");
      await h.call(USERS.admin, "PATCH", `documents/${page!.id}`, { title: "A better title" });
      await sync();
      expect(JSON.parse(repo.read(".pandocs/pages.json")!).pages.guide.title).toBe("A better title");
      expect(repo.pushes.at(-1)!.write).toEqual([".pandocs/pages.json"]);
    });

    it("keeps pages only some people can read out of it, unless told otherwise", async () => {
      await create("open", "Open\n");
      await create("secret", "Secret\n", { restricted: true });
      await connect();
      await sync();
      expect(repo.paths).toEqual([".pandocs/pages.json", "open.md"]);
      expect(repo.read(".pandocs/pages.json")).not.toContain("secret");
      await connect({ includeRestricted: true });
      await sync();
      expect(repo.read("secret.md")).toBe("Secret\n");
    });

    it("takes a page out once only some people can read it", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      const page = await pageOf("guide");
      await h.call(USERS.admin, "PATCH", `documents/${page!.id}`, { restricted: true });
      await sync();
      expect(repo.files.has("guide.md")).toBe(false);
      expect(await pages()).toEqual({ guide: "One\n" });
    });
  });

  describe("taking from the repository", () => {
    it("turns a commit into a new version, under the name of whoever made it, and does not send it back", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      repo.commit({ "guide.md": "Two\n" }, "Fix the guide", "Grace");
      const pushes = repo.pushes.length;
      await sync();
      expect((await pages()).guide).toBe("Two\n");
      const page = await pageOf("guide");
      const { rows } = await h.pool.query(
        `SELECT actor_name, channel, message FROM pandocs.revisions WHERE document_id = $1 AND no = $2`,
        [page!.id, page!.current_revision_no]
      );
      expect(rows[0]).toMatchObject({ channel: "git", message: "Fix the guide" });
      expect(rows[0].actor_name).toContain("Grace");
      expect(repo.pushes).toHaveLength(pushes);
      const { data: runs } = await h.call(USERS.admin, "GET", `spaces/${space}/git-sync/runs`);
      expect(runs[0]).toMatchObject({ pulled: 1, pushed: 0, error: null });
    });

    it("leaves a followed page's readers told, and a saved draft's author warned, as any other change does", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      const page = await pageOf("guide");
      await h.call(USERS.editor, "PUT", `documents/${page!.id}/subscription`, {});
      repo.commit({ "guide.md": "Two\n" });
      await sync();
      const { data } = await h.call(USERS.editor, "GET", "me/inbox");
      expect(JSON.stringify(data)).toContain("guide");
    });

    it("makes new files into pages, with the folders they need, calling each what it calls itself", async () => {
      await connect();
      await sync();
      repo.commit({
        "plain.md": "No heading here\n",
        "headed.md": "```sh\n# not this\n```\n\n# The heading\n",
        "matter.md": '---\ntitle: "From front matter"\n---\n\n# Not this\n',
        "a/b/c.md": "Deep\n"
      });
      await sync();
      expect(Object.keys(await pages())).toEqual(["a", "a/b", "a/b/c", "headed", "matter", "plain"]);
      expect((await pageOf("plain"))!.title).toBe("plain");
      expect((await pageOf("headed"))!.title).toBe("The heading");
      expect((await pageOf("matter"))!.title).toBe("From front matter");
      expect((await pageOf("a"))!.title).toBe("a");
      expect((await pages())["a/b/c"]).toBe("Deep\n");
      // Folders stay folders.
      expect(repo.files.has("a.md")).toBe(false);
      expect(repo.files.has("a/b.md")).toBe(false);
    });

    it("gives a file arriving at a folder's page the page, as there is nothing there to lose", async () => {
      await connect();
      repo.commit({ "a/b.md": "Below\n" });
      await sync();
      expect((await pages()).a).toBe("");
      repo.commit({ "a.md": "Now with text\n" });
      await sync();
      expect((await pages()).a).toBe("Now with text\n");
      const page = await pageOf("a");
      const { data: proposals } = await h.call(USERS.admin, "GET", `documents/${page!.id}/proposals`);
      expect(proposals).toEqual([]);
    });

    it("merges changes in different places, and sends back what that makes", async () => {
      const base = "# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
      await create("guide", base);
      await connect();
      await sync();
      await edit("guide", base.replace("First", "Our first"));
      repo.commit({ "guide.md": base.replace("Third", "Their third") });
      await sync();
      const merged = "# Guide\n\nOur first paragraph.\n\nSecond paragraph.\n\nTheir third paragraph.\n";
      expect((await pages()).guide).toBe(merged);
      expect(repo.read("guide.md")).toBe(merged);
      await sync();
      expect((await pages()).guide).toBe(merged);
      expect(await notes()).toEqual([]);
    });

    it("leaves a real conflict for a person: the page keeps its text, the repository's is a suggestion, and neither is lost", async () => {
      await create("guide", "Line one.\n");
      await connect();
      await sync();
      await edit("guide", "Ours.\n");
      repo.commit({ "guide.md": "Theirs.\n" }, "Their version", "Grace");
      const theirs = repo.latest;
      await sync();
      expect((await pages()).guide).toBe("Ours.\n");
      expect(repo.read("guide.md")).toBe("Ours.\n");
      expect(repo.latest).not.toBe(theirs);
      const page = await pageOf("guide");
      const { data: proposals } = await h.call(USERS.admin, "GET", `documents/${page!.id}/proposals`);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].rationale).toContain("Their version");
      expect(proposals[0].authorName).toContain("Grace");
      expect(JSON.stringify(proposals[0].ops)).toContain("Theirs.");
      expect((await notes()).map(note => note.file)).toEqual(["guide.md"]);
      // And it has settled: another look does nothing more.
      const pushes = repo.pushes.length;
      await sync();
      expect(repo.pushes).toHaveLength(pushes);
      expect((await h.call(USERS.admin, "GET", `documents/${page!.id}/proposals`)).data).toHaveLength(1);
    });

    it("keeps a page and what is said about it when its file is renamed", async () => {
      await create("old", "Stays\n");
      await connect();
      await sync();
      const { id } = (await pageOf("old"))!;
      repo.commit({ "old.md": null, "guides/new.md": "Stays\n" }, "Move it");
      await sync();
      expect(Object.keys(await pages())).toEqual(["guides", "guides/new"]);
      expect((await pageOf("guides/new"))!.id).toBe(id);
      expect(repo.files.has("guides.md")).toBe(false);
      expect(await notes()).toEqual([]);
    });

    it("keeps a page when its file is renamed and edited in one commit, as Git itself would call that a rename", async () => {
      const base = "# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
      await create("old", base);
      await connect();
      await sync();
      const { id } = (await pageOf("old"))!;
      repo.commit(
        { "old.md": null, "guides/new.md": base.replace("Third paragraph.", "Third paragraph, edited.") },
        "Move and improve"
      );
      await sync();
      expect(await pages()).toEqual({
        guides: "",
        "guides/new": "# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph, edited.\n"
      });
      const page = (await pageOf("guides/new"))!;
      expect(page.id).toBe(id);
      expect(page.current_revision_no).toBe(2);
      expect(await notes()).toEqual([]);
    });

    it("merges what changed here into a page renamed and edited there", async () => {
      const base = "# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
      await create("old", base);
      await connect();
      await sync();
      await edit("old", base.replace("First", "Our first"));
      repo.commit({ "old.md": null, "new.md": base.replace("Third", "Their third") });
      await sync();
      const merged = "# Guide\n\nOur first paragraph.\n\nSecond paragraph.\n\nTheir third paragraph.\n";
      expect(await pages()).toEqual({ new: merged });
      expect(repo.read("new.md")).toBe(merged);
      expect(repo.files.has("old.md")).toBe(false);
    });

    it("does not take an unrelated new file for a rename of one deleted in the same commit", async () => {
      await create("old", "# Old\n\nSomething about one subject.\n\nAnd more about it.\n");
      await connect();
      await sync();
      const { id } = (await pageOf("old"))!;
      repo.commit({ "old.md": null, "new.md": "# New\n\nA different subject altogether.\n" });
      await sync();
      expect(Object.keys(await pages())).toEqual(["new"]);
      expect((await pageOf("new"))!.id).not.toBe(id);
    });

    it("moves a whole folder as a folder", async () => {
      await create("a", "Top\n");
      await create("a/x", "X\n");
      await create("a/y", "Y\n");
      await connect();
      await sync();
      const before = { a: (await pageOf("a"))!.id, x: (await pageOf("a/x"))!.id, y: (await pageOf("a/y"))!.id };
      repo.commit({ "a.md": null, "a/x.md": null, "a/y.md": null, "b.md": "Top\n", "b/x.md": "X\n", "b/y.md": "Y\n" });
      await sync();
      expect(Object.keys(await pages())).toEqual(["b", "b/x", "b/y"]);
      expect({ a: (await pageOf("b"))!.id, x: (await pageOf("b/x"))!.id, y: (await pageOf("b/y"))!.id }).toEqual(
        before
      );
      expect(repo.paths).toEqual([".pandocs/pages.json", "b.md", "b/x.md", "b/y.md"]);
    });

    it("clears away a folder's page once a move has left it empty", async () => {
      await connect();
      repo.commit({ "a/x.md": "X\n" });
      await sync();
      const { id } = (await pageOf("a/x"))!;
      repo.commit({ "a/x.md": null, "b/x.md": "X\n" });
      await sync();
      expect(Object.keys(await pages())).toEqual(["b", "b/x"]);
      expect((await pageOf("b/x"))!.id).toBe(id);
    });

    it("sends a page to the trash when its file is deleted", async () => {
      await create("guide", "One\n");
      await create("other", "Other\n");
      await connect();
      await sync();
      const { id } = (await pageOf("guide"))!;
      repo.commit({ "guide.md": null });
      await sync();
      expect(Object.keys(await pages())).toEqual(["other"]);
      const { data: trash } = await h.call(USERS.admin, "GET", `spaces/${space}/trash`);
      expect(trash.map((entry: { id: string }) => entry.id)).toContain(id);
      expect(repo.files.has("guide.md")).toBe(false);
    });

    it("keeps a page changed here when its file is deleted there, and puts the file back", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      await edit("guide", "Two\n");
      repo.commit({ "guide.md": null });
      await sync();
      expect((await pages()).guide).toBe("Two\n");
      expect(repo.read("guide.md")).toBe("Two\n");
      expect((await notes()).map(note => note.file)).toEqual(["guide.md"]);
    });

    it("brings a page deleted here back as new when its file changes there, as that is work someone just did", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      const page = await pageOf("guide");
      await h.call(USERS.admin, "DELETE", `documents/${page!.id}`);
      repo.commit({ "guide.md": "Two\n" });
      await sync();
      expect((await pages()).guide).toBe("Two\n");
      expect(repo.read("guide.md")).toBe("Two\n");
    });

    it("leaves a page with no text when its file is deleted but the pages below it are not", async () => {
      await create("a", "Top\n");
      await create("a/x", "X\n");
      await connect();
      await sync();
      repo.commit({ "a.md": null });
      await sync();
      expect(await pages()).toEqual({ a: "", "a/x": "X\n" });
      expect(repo.files.has("a.md")).toBe(false);
      expect(repo.read("a/x.md")).toBe("X\n");
    });

    it("deletes a whole folder together, from the bottom up", async () => {
      await create("a", "Top\n");
      await create("a/x", "X\n");
      await create("a/y", "");
      await create("a/y/z", "Z\n");
      await create("keep", "Keep\n");
      await connect();
      await sync();
      repo.commit({ "a.md": null, "a/x.md": null, "a/y/z.md": null });
      await sync();
      expect(await pages()).toEqual({ keep: "Keep\n" });
      expect(repo.paths).toEqual([".pandocs/pages.json", "keep.md"]);
    });

    it("takes titles, order and labels from the repository when that file changes, and not otherwise", async () => {
      await create("guide", "One\n", { title: "Guide" });
      await create("other", "Other\n", { title: "Other" });
      await connect();
      await sync();
      const details = JSON.parse(repo.read(".pandocs/pages.json")!);
      details.pages.guide = { title: "Renamed there", order: 5000, labels: ["alpha", "beta"] };
      repo.commit({ ".pandocs/pages.json": JSON.stringify(details) });
      await sync();
      const page = (await pageOf("guide"))!;
      expect(page.title).toBe("Renamed there");
      expect(page.sort_order).toBe(5000);
      const { rows } = await h.pool.query(
        `SELECT label FROM pandocs.document_labels WHERE document_id = $1 ORDER BY label`,
        [page.id]
      );
      expect(rows.map(row => row.label)).toEqual(["alpha", "beta"]);
      // It goes back in the form this side writes it, and a later rename here is not undone by an older file.
      await h.call(USERS.admin, "PATCH", `documents/${page.id}`, { title: "Renamed here" });
      repo.commit({ "other.md": "Other two\n" });
      await sync();
      expect((await pageOf("guide"))!.title).toBe("Renamed here");
      expect(JSON.parse(repo.read(".pandocs/pages.json")!).pages.guide.title).toBe("Renamed here");
    });

    it("carries on when that file makes no sense, and never lets it change who can read a page", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      repo.commit({ ".pandocs/pages.json": "{ not json", "guide.md": "Two\n" });
      await sync();
      expect((await pages()).guide).toBe("Two\n");
      expect((await notes()).map(note => note.file)).toEqual([".pandocs/pages.json"]);
      repo.commit({ ".pandocs/pages.json": JSON.stringify({ pages: { guide: { order: 1e12 } } }) });
      await sync();
      expect((await status()).lastError).toBeNull();
      repo.commit({ ".pandocs/pages.json": JSON.stringify({ pages: { guide: { restricted: true, title: "T" } } }) });
      await sync();
      const { rows } = await h.pool.query(
        `SELECT restricted, title FROM pandocs.documents WHERE path = 'guide' AND space_id = (SELECT id FROM pandocs.spaces WHERE slug = $1)`,
        [space]
      );
      expect(rows[0]).toEqual({ restricted: false, title: "T" });
    });

    it("stores pictures a file points to by its own path, and does not rewrite the file for it", async () => {
      await connect();
      repo.commit({
        "docs/images/a b.png": PNG,
        "docs/guide.md":
          '![a](images/a%20b.png)\n\n```md\n![not this](images/none.png)\n```\n\n![up](../logo.png "Logo")\n',
        "logo.png": PNG
      });
      await connect({ folder: "docs" });
      await sync();
      const sha = createHash("sha256").update(PNG).digest("hex");
      const markdown = (await pages()).guide!;
      expect(markdown).toContain(`![a](assets/${sha}`);
      expect(markdown).toContain(`![up](assets/${sha}`);
      expect(markdown).toContain("Logo");
      expect(markdown).toContain("![not this](images/none.png)");
      expect(repo.read("docs/guide.md")).toContain("images/a%20b.png");
      // Editing the page is what changes the file, as it has to say where its pictures are by then.
      await edit("guide", `${markdown}\nMore.\n`);
      await sync();
      expect(repo.read("docs/guide.md")).toContain(`![a](assets/${sha}`);
      expect(repo.paths).toContain(`docs/assets/${sha}.png`);
      expect(await notes()).toEqual([]);
    });

    it("says what it could not take, and takes the rest", async () => {
      await connect();
      repo.commit({
        "good.md": "Good\n",
        "bad name.md": "A space\n",
        "binary.md": new Uint8Array([1, 0, 2]),
        "huge.md": "x".repeat(2 * 1024 * 1024 + 1),
        "missing.md": "![a](not-there.png)\n",
        "broken.md": "![a](%E0%A4%A.png)\n"
      });
      await sync();
      const found = Object.keys(await pages());
      expect(found).toEqual(["broken", "good", "missing"]);
      expect((await pages()).missing).toBe("![a](not-there.png)\n");
      const said = await notes();
      expect(said.map(note => note.file).sort()).toEqual([
        "bad name.md",
        "binary.md",
        "broken.md",
        "huge.md",
        "missing.md"
      ]);
      expect((await status()).lastError).toBeNull();
    });

    it("leaves the file alone when a changed one is too large, rather than writing the page over it", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      const huge = "x".repeat(2 * 1024 * 1024 + 1);
      repo.commit({ "guide.md": huge });
      await sync();
      expect(repo.read("guide.md")).toBe(huge);
      expect((await pages()).guide).toBe("One\n");
    });

    it("has no interest in tooling folders or anything that is not Markdown", async () => {
      await connect();
      repo.commit({
        ".github/CONTRIBUTING.md": "x\n",
        "notes.txt": "x\n",
        "page.mdx": "x\n",
        "page.MD": "x\n",
        "real.md": "Real\n"
      });
      await sync();
      expect(Object.keys(await pages())).toEqual(["real"]);
      expect(await notes()).toEqual([]);
      expect(repo.paths).toContain(".github/CONTRIBUTING.md");
      expect(repo.paths).toContain("notes.txt");
    });

    it("normalises line endings, without calling that a change to send back", async () => {
      await connect();
      repo.commit({ "guide.md": "One\r\nTwo\r\n" });
      await sync();
      expect((await pages()).guide).toBe("One\nTwo\n");
      expect(repo.read("guide.md")).toBe("One\r\nTwo\r\n");
    });
  });

  describe("connecting to a repository that already has files", () => {
    it("keeps the space's text at the same address if the space comes first", async () => {
      await create("both", "Space\n");
      await create("space-only", "Space only\n");
      repo.commit({ "both.md": "Repository\n", "repository-only.md": "Repository only\n" });
      await connect({ firstSource: "space" });
      await sync();
      expect(await pages()).toEqual({
        both: "Space\n",
        "repository-only": "Repository only\n",
        "space-only": "Space only\n"
      });
      expect(repo.read("both.md")).toBe("Space\n");
      expect(repo.read("space-only.md")).toBe("Space only\n");
      expect(await notes()).toEqual([]);
    });

    it("takes the repository's text at the same address if the repository comes first", async () => {
      await create("both", "Space\n");
      await create("space-only", "Space only\n");
      repo.commit({ "both.md": "Repository\n", "repository-only.md": "Repository only\n" });
      await connect({ firstSource: "repository" });
      await sync();
      expect(await pages()).toEqual({
        both: "Repository\n",
        "repository-only": "Repository only\n",
        "space-only": "Space only\n"
      });
      expect(repo.read("both.md")).toBe("Repository\n");
      expect(repo.read("space-only.md")).toBe("Space only\n");
    });

    it("recognises the same text, so connecting twice changes nothing", async () => {
      await create("both", "Same\n");
      repo.commit({ "both.md": "Same\n" });
      await connect();
      await sync();
      const page = (await pageOf("both"))!;
      expect(page.current_revision_no).toBe(1);
      expect(repo.pushes.at(-1)!.write).toEqual([".pandocs/pages.json"]);
    });

    it("makes a suggestion later on, when a new file lands on a page that has text and was never in the repository", async () => {
      await connect();
      await sync();
      await create("both", "Space\n");
      repo.commit({ "both.md": "Repository\n" });
      await sync();
      expect((await pages()).both).toBe("Space\n");
      expect(repo.read("both.md")).toBe("Space\n");
      const page = (await pageOf("both"))!;
      expect((await h.call(USERS.admin, "GET", `documents/${page.id}/proposals`)).data).toHaveLength(1);
    });

    it("will not take two files whose names differ only in capitals as one page", async () => {
      await connect();
      repo.commit({ "Guide.md": "Capital\n" });
      await sync();
      repo.commit({ "guide.md": "Small\n" });
      await sync();
      expect(await pages()).toEqual({ Guide: "Capital\n" });
      expect(repo.read("guide.md")).toBe("Small\n");
      expect((await notes()).map(note => note.file)).toEqual(["guide.md"]);
    });
  });

  describe("pages only some people can read", () => {
    it("are not changed by a file with the same address, and the file stays", async () => {
      await create("secret", "Secret\n", { restricted: true });
      repo.commit({ "secret.md": "From the repository\n" });
      await connect({ firstSource: "repository" });
      await sync();
      expect((await pages()).secret).toBe("Secret\n");
      expect(repo.read("secret.md")).toBe("From the repository\n");
      expect((await notes()).map(note => note.file)).toEqual(["secret.md"]);
    });

    it("are not deleted by a file going missing around the time they became restricted", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      const page = (await pageOf("guide"))!;
      await h.call(USERS.admin, "PATCH", `documents/${page.id}`, { restricted: true });
      repo.commit({ "guide.md": null });
      await sync();
      expect(await pages()).toEqual({ guide: "One\n" });
    });
  });

  describe("a space where everything goes through review", () => {
    const protect = () =>
      h.call(USERS.admin, "PATCH", `spaces/${space}`, {
        mergeRules: { requiredApprovals: 1, requireChangeSets: true }
      });
    const openSets = async () =>
      (await h.call(USERS.admin, "GET", `spaces/${space}/change-sets?status=open`)).data as {
        id: string;
        title: string;
        authorName: string;
      }[];
    const mergeAll = async () => {
      const [changeSet] = await openSets();
      const reviewed = await h.call(USERS.editor, "POST", `change-sets/${changeSet!.id}/reviews`, {
        verdict: "approved"
      });
      expect(reviewed.error).toBeUndefined();
      const merged = await h.write(USERS.admin, "POST", `change-sets/${changeSet!.id}/merge`, {});
      expect(merged.error).toBeUndefined();
    };

    it("puts what comes from the repository in a change set, and only lands it when merged", async () => {
      await create("guide", "One\n");
      await create("doomed", "Goes\n");
      await protect();
      await connect();
      await sync();
      repo.commit({ "guide.md": "Two\n", "doomed.md": null, "folder/new.md": "# New page\n" }, "Three things");
      await sync();
      expect(await pages()).toEqual({ doomed: "Goes\n", guide: "One\n" });
      const sets = await openSets();
      expect(sets).toHaveLength(1);
      expect(sets[0]!.title).toContain("Three things");
      // Waiting does not mean the repository gets told it is wrong.
      expect(repo.read("guide.md")).toBe("Two\n");
      expect(repo.files.has("doomed.md")).toBe(false);
      expect(repo.read("folder/new.md")).toBe("# New page\n");
      const pushes = repo.pushes.length;
      await sync();
      expect(repo.pushes).toHaveLength(pushes);
      await mergeAll();
      expect(await pages()).toEqual({ folder: "", "folder/new": "# New page\n", guide: "Two\n" });
      expect((await pageOf("folder/new"))!.title).toBe("New page");
      await sync();
      expect(repo.read("guide.md")).toBe("Two\n");
      expect(repo.files.has("folder.md")).toBe(false);
      expect(repo.pushes.slice(pushes).flatMap(push => push.write)).toEqual([".pandocs/pages.json"]);
    });

    it("adds later commits to the change set still open, rather than starting another", async () => {
      await create("guide", "One\n");
      await protect();
      await connect();
      await sync();
      repo.commit({ "guide.md": "Two\n" });
      await sync();
      repo.commit({ "guide.md": "Three\n", "other.md": "Other\n" });
      await sync();
      const sets = await openSets();
      expect(sets).toHaveLength(1);
      await mergeAll();
      expect(await pages()).toEqual({ guide: "Three\n", other: "Other\n" });
    });

    it("sends a person's own edit in the meantime, once it has been merged with what is waiting", async () => {
      const base = "First.\n\nSecond.\n";
      await create("guide", base);
      await protect();
      await connect();
      await sync();
      repo.commit({ "guide.md": "First from Git.\n\nSecond.\n" });
      await sync();
      const page = (await pageOf("guide"))!;
      const [changeSet] = await openSets();
      const mine = await h.call(USERS.admin, "POST", `spaces/${space}/change-sets`, { title: "Mine" });
      await h.call(USERS.admin, "POST", `change-sets/${mine.data.id}/pages`, {
        document: page.id,
        baseRevision: page.current_revision_no,
        markdown: "First.\n\nSecond from here.\n"
      });
      await h.call(USERS.editor, "POST", `change-sets/${mine.data.id}/reviews`, { verdict: "approved" });
      expect((await h.write(USERS.admin, "POST", `change-sets/${mine.data.id}/merge`, {})).error).toBeUndefined();
      await h.call(USERS.editor, "POST", `change-sets/${changeSet!.id}/reviews`, { verdict: "approved" });
      expect((await h.write(USERS.admin, "POST", `change-sets/${changeSet!.id}/merge`, {})).error).toBeUndefined();
      await sync();
      const merged = "First from Git.\n\nSecond from here.\n";
      expect((await pages()).guide).toBe(merged);
      expect(repo.read("guide.md")).toBe(merged);
    });

    it("puts the page's text back in the repository if someone closes the change set", async () => {
      await create("guide", "One\n");
      await create("doomed", "Stays\n");
      await protect();
      await connect();
      await sync();
      repo.commit({ "guide.md": "Two\n", "doomed.md": null, "unwanted.md": "No thanks\n" });
      await sync();
      const [changeSet] = await openSets();
      expect((await h.call(USERS.admin, "POST", `change-sets/${changeSet!.id}/close`)).error).toBeUndefined();
      await sync();
      expect(await pages()).toEqual({ doomed: "Stays\n", guide: "One\n" });
      expect(repo.read("guide.md")).toBe("One\n");
      expect(repo.read("doomed.md")).toBe("Stays\n");
      expect(repo.files.has("unwanted.md")).toBe(false);
      // Having been turned down, it does not keep coming back.
      await sync();
      expect(await openSets()).toEqual([]);
    });

    it("notices a change set closing without anything else happening", async () => {
      await create("guide", "One\n");
      await protect();
      await connect();
      await sync();
      repo.commit({ "guide.md": "Two\n" });
      await sync();
      await settle();
      const [changeSet] = await openSets();
      await h.call(USERS.admin, "POST", `change-sets/${changeSet!.id}/close`);
      await settle();
      await sync();
      expect(repo.read("guide.md")).toBe("One\n");
    });

    it("does not need a change set for what is sent to the repository", async () => {
      await create("guide", "One\n");
      await protect();
      await connect();
      await sync();
      expect(repo.read("guide.md")).toBe("One\n");
      expect(await openSets()).toEqual([]);
    });
  });

  describe("when things go wrong", () => {
    it("records the failure, waits longer each time, and recovers by itself", async () => {
      await create("guide", "One\n");
      await connect();
      repo.failure = new Error("could not resolve host");
      await sync();
      const waits = async () =>
        (
          await h.pool.query<{ wait: number }>(
            `SELECT extract(epoch FROM due_at - now())::int AS wait FROM pandocs.git_syncs`
          )
        ).rows[0]!.wait;
      expect((await status()).lastError).toContain("could not resolve host");
      const first = await waits();
      await sync();
      expect(await waits()).toBeGreaterThan(first);
      const { data: runs } = await h.call(USERS.admin, "GET", `spaces/${space}/git-sync/runs`);
      expect(runs[0].error).toContain("could not resolve host");
      repo.failure = null;
      await sync();
      expect((await status()).lastError).toBeNull();
      expect(repo.read("guide.md")).toBe("One\n");
      const { rows } = await h.pool.query(`SELECT consecutive_failures, lease_owner FROM pandocs.git_syncs`);
      expect(rows[0]).toEqual({ consecutive_failures: 0, lease_owner: null });
    });

    it("loses nothing when someone pushes in between, and gets it right on the next look", async () => {
      await create("guide", "One\n");
      await create("other", "Other\n");
      await connect();
      await sync();
      await edit("guide", "Two\n");
      repo.beforePush = () => repo.commit({ "other.md": "Other two\n" });
      await sync();
      expect((await status()).lastError).toContain("rejected");
      expect(repo.read("guide.md")).toBe("One\n");
      await sync();
      expect((await status()).lastError).toBeNull();
      expect(repo.read("guide.md")).toBe("Two\n");
      expect((await pages()).other).toBe("Other two\n");
    });

    it("does not take a deleted branch to mean every page should go, and gives it all back", async () => {
      await create("guide", "One\n");
      await create("a", "");
      await create("a/x", "X\n");
      await connect();
      await sync();
      repo.files.clear();
      repo.latest = null;
      await sync();
      expect(await pages()).toEqual({ a: "", "a/x": "X\n", guide: "One\n" });
      expect(repo.read("guide.md")).toBe("One\n");
      expect(repo.read("a/x.md")).toBe("X\n");
    });

    it("does not take pointing somewhere else to mean every page should go", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      repo.files.clear();
      repo.commit({ "elsewhere.md": "Elsewhere\n" });
      await connect({ branch: "other" });
      await sync();
      expect(await pages()).toEqual({ elsewhere: "Elsewhere\n", guide: "One\n" });
      expect(repo.read("guide.md")).toBe("One\n");
    });

    it("does not look at a deleted space's repository", async () => {
      await connect();
      await h.call(USERS.admin, "DELETE", `spaces/${space}`);
      await sync();
      expect(repo.looks).toBe(0);
      const { rows } = await h.pool.query(`SELECT lease_owner FROM pandocs.git_syncs`);
      expect(rows[0].lease_owner).toBeNull();
    });

    it("is looked at by only one worker at a time, and not while off", async () => {
      await connect();
      await h.pool.query(`UPDATE pandocs.git_syncs SET due_at = now()`);
      const results = await Promise.all([h.services.gitSync.tick(), h.services.gitSync.tick()]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(repo.looks).toBe(1);
      await connect({ enabled: false });
      await sync();
      expect(repo.looks).toBe(1);
    });

    it("picks up a job left behind by a worker that died", async () => {
      await connect();
      await h.pool.query(
        `UPDATE pandocs.git_syncs SET due_at = now(), lease_owner = 'gone', lease_until = now() + interval '1 hour'`
      );
      expect(await h.services.gitSync.tick()).toBe(false);
      await h.pool.query(`UPDATE pandocs.git_syncs SET lease_until = now() - interval '1 second'`);
      expect(await h.services.gitSync.tick()).toBe(true);
    });

    it("keeps only the latest runs in its record", async () => {
      await create("guide", "One\n");
      await connect();
      await sync();
      const {
        rows: [row]
      } = await h.pool.query(`SELECT id FROM pandocs.git_syncs`);
      await h.pool.query(
        `INSERT INTO pandocs.git_sync_runs (sync_id, started_at, pushed) SELECT $1, now() - make_interval(hours => n), 1 FROM generate_series(1, 60) AS n`,
        [row.id]
      );
      repo.commit({ "guide.md": "Two\n" });
      await sync();
      const { rows } = await h.pool.query(`SELECT count(*)::int AS count FROM pandocs.git_sync_runs`);
      expect(rows[0].count).toBe(50);
    });
  });

  describe("being told a commit has arrived", () => {
    it("makes it due, from nothing but the address", async () => {
      await connect();
      await sync();
      const token = (await status()).hookPath.split("/").pop()!;
      await h.pool.query(`UPDATE pandocs.git_syncs SET due_at = now() + interval '1 hour'`);
      expect(await h.services.gitSync.hook("wrong")).toBe(false);
      const { rows: before } = await h.pool.query<{ due: boolean }>(
        `SELECT due_at <= now() AS due FROM pandocs.git_syncs`
      );
      expect(before[0]!.due).toBe(false);
      expect(await h.services.gitSync.hook(token)).toBe(true);
      const { rows: after } = await h.pool.query<{ due: boolean }>(
        `SELECT due_at <= now() AS due FROM pandocs.git_syncs`
      );
      expect(after[0]!.due).toBe(true);
    });

    it("keeps the address when the settings change, as it is in the repository's own settings", async () => {
      await connect();
      const { hookPath } = await status();
      await connect({ branch: "other" });
      expect((await status()).hookPath).toBe(hookPath);
    });

    it("does nothing while switched off", async () => {
      await connect({ enabled: false });
      const token = (await status()).hookPath.split("/").pop()!;
      expect(await h.services.gitSync.hook(token)).toBe(false);
    });
  });

  it("gets the same blob identifiers as Git", () => {
    expect(gitBlobId(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobId(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});
