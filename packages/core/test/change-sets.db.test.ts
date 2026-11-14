import type { Principal } from "@pandocs/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const second: Principal = {
  id: "second-1",
  kind: "user",
  displayName: "Second editor",
  groups: [],
  isAdmin: false,
  scopes: ["read", "write"],
  channel: "web"
};

describe("change sets", () => {
  let h: ReturnType<typeof createHarness>;
  let guide = "";
  let faq = "";
  let notes = "";
  let hidden = "";
  let space = "";
  let serial = 0;

  const textOf = async (id: string, principal: Principal = USERS.admin) =>
    (await h.call(principal, "GET", `documents/${id}`)).data;
  const fresh = async (title = "Update") => {
    const created = await h.call(USERS.commenter, "POST", `spaces/${space}/change-sets`, { title });
    expect(created.error).toBeUndefined();
    return created.data.id as string;
  };
  const addEdit = async (id: string, document: string, markdown: string, principal: Principal = USERS.commenter) => {
    const { data: view } = await h.call(USERS.admin, "GET", `documents/${document}`);
    const result = await h.call(principal, "POST", `change-sets/${id}/pages`, {
      document,
      baseRevision: view.revision.no,
      markdown
    });
    expect(result.error).toBeUndefined();
    return result.data as { id: string };
  };
  const page = async (title: string, markdown = `${title}.\n`, extra: object = {}) =>
    (
      await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
        title,
        slug: `p${++serial}`,
        markdown,
        ...extra
      })
    ).data.document.id as string;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
  });
  beforeEach(async () => {
    await h.pool.query("DELETE FROM pandocs.spaces WHERE slug LIKE 'cs%'");
    space = `cs${++serial}`;
    await h.call(USERS.admin, "POST", "spaces", { slug: space, name: "Shop", defaultRole: "commenter" });
    for (const person of [USERS.editor, second])
      await h.call(USERS.admin, "PUT", `spaces/${space}/members`, { subject: `user:${person.id}`, role: "editor" });
    guide = (
      await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
        title: "Guide",
        slug: "guide",
        markdown: "# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n"
      })
    ).data.document.id;
    faq = (
      await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
        title: "FAQ",
        slug: "faq",
        markdown: "# FAQ\n\nAsk away.\n"
      })
    ).data.document.id;
    notes = (
      await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
        title: "Notes",
        slug: "notes",
        markdown: "Old notes.\n"
      })
    ).data.document.id;
    hidden = (
      await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
        title: "Prices",
        slug: "prices",
        markdown: "Secret.\n",
        restricted: true
      })
    ).data.document.id;
  });
  afterAll(() => h.close());

  it("lands every kind of change on several pages at once, as one change", async () => {
    const id = await fresh("Rework the help pages");
    await addEdit(id, guide, "# Guide\n\nFirst paragraph, better.\n\nSecond paragraph.\n");
    await addEdit(id, faq, "# FAQ\n\nAsk anything.\n");
    const { data: view } = await h.call(USERS.admin, "GET", `documents/${notes}`);
    expect(
      (
        await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
          document: notes,
          baseRevision: view.revision.no,
          delete: true
        })
      ).status
    ).toBe(201);
    expect(
      (
        await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
          path: "guide/start",
          title: "Getting started",
          markdown: "Start here.\n"
        })
      ).status
    ).toBe(201);

    expect((await textOf(guide)).markdown).toContain("First paragraph.");
    const merged = await h.call(USERS.editor, "POST", `change-sets/${id}/merge`);
    expect(merged.error).toBeUndefined();
    expect(merged.data.changeSet).toMatchObject({ status: "merged", decidedName: USERS.editor.displayName });
    expect(merged.data.pages).toHaveLength(4);

    const after = await textOf(guide);
    expect(after.markdown).toContain("First paragraph, better.");
    expect(after.revision).toMatchObject({
      changeSetId: id,
      actorName: USERS.editor.displayName,
      message: `${USERS.commenter.displayName}'s change set: Rework the help pages`
    });
    expect((await textOf(faq)).markdown).toContain("Ask anything.");
    expect((await h.call(USERS.admin, "GET", `documents/${notes}`)).status).toBe(404);
    const { data: tree } = await h.call(USERS.admin, "GET", `spaces/${space}/tree`);
    const made = tree.find((node: { path: string }) => node.path === "guide/start");
    expect(made).toMatchObject({ title: "Getting started", parentId: guide });
    expect((await textOf(made.id)).revision.changeSetId).toBe(id);
    expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).status).toBe(409);
  });

  it("makes parents before what goes under them, and deletes children before their parents", async () => {
    const id = await fresh();
    await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
      path: "new/deep/page",
      title: "Deep",
      markdown: "Deep.\n"
    });
    await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, { path: "new", title: "New", markdown: "New.\n" });
    await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
      path: "new/deep",
      title: "Middle",
      markdown: "Middle.\n"
    });
    expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).error).toBeUndefined();
    const { data: tree } = await h.call(USERS.admin, "GET", `spaces/${space}/tree`);
    const ids = new Map(tree.map((node: { path: string; id: string }) => [node.path, node.id]));
    expect(ids.has("new/deep/page")).toBe(true);

    const removal = await fresh("Remove them");
    for (const path of ["new", "new/deep", "new/deep/page"]) {
      const { data: view } = await h.call(USERS.admin, "GET", `documents/${ids.get(path) as string}`);
      expect(
        (
          await h.call(USERS.commenter, "POST", `change-sets/${removal}/pages`, {
            document: path,
            baseRevision: view.revision.no,
            delete: true
          })
        ).status
      ).toBe(201);
    }
    expect((await h.call(USERS.editor, "POST", `change-sets/${removal}/merge`)).error).toBeUndefined();
    const { data: left } = await h.call(USERS.admin, "GET", `spaces/${space}/tree`);
    expect(left.map((node: { path: string }) => node.path)).not.toContain("new");
  });

  it("merges with what happened to a page since, and keeps both", async () => {
    const id = await fresh();
    await addEdit(id, guide, "# Guide\n\nFirst paragraph, better.\n\nSecond paragraph.\n");
    const { data: before } = await h.call(USERS.admin, "GET", `documents/${guide}`);
    await h.write(USERS.editor, "PUT", `documents/${guide}/content`, {
      markdown: "# Guide\n\nFirst paragraph.\n\nSecond paragraph, edited since.\n",
      expectedRevision: before.revision.no
    });
    const { data: detail } = await h.call(USERS.admin, "GET", `change-sets/${id}`);
    expect(detail.blockers).toEqual([]);
    expect(detail.pages[0].currentRevisionNo).toBeGreaterThan(detail.pages[0].baseRevisionNo);
    expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).error).toBeUndefined();
    const { markdown } = await textOf(guide);
    expect(markdown).toContain("First paragraph, better.");
    expect(markdown).toContain("Second paragraph, edited since.");
  });

  it("changes nothing at all when one page cannot land, and says which", async () => {
    const id = await fresh();
    await addEdit(id, faq, "# FAQ\n\nA good change.\n");
    await addEdit(id, guide, "# Guide\n\nMine.\n\nSecond paragraph.\n");
    const { data: before } = await h.call(USERS.admin, "GET", `documents/${guide}`);
    await h.write(USERS.editor, "PUT", `documents/${guide}/content`, {
      markdown: "# Guide\n\nTheirs.\n\nSecond paragraph.\n",
      expectedRevision: before.revision.no
    });
    const { data: detail } = await h.call(USERS.admin, "GET", `change-sets/${id}`);
    expect(detail.canMerge).toBe(false);
    expect(detail.blockers).toMatchObject([{ code: "CHANGE_SET_CONFLICT", path: "guide" }]);
    const merged = await h.call(USERS.editor, "POST", `change-sets/${id}/merge`);
    expect(merged.status).toBe(409);
    expect(merged.error.code).toBe("CHANGE_SET_BLOCKED");
    expect(merged.error.details.blockers[0].path).toBe("guide");
    expect((await textOf(faq)).markdown).toContain("Ask away.");
    expect((await h.call(USERS.admin, "GET", `change-sets/${id}`)).data.status).toBe("open");
  });

  it("will not delete what has changed since someone decided to, or make a page where one now is", async () => {
    const id = await fresh();
    const { data: view } = await h.call(USERS.admin, "GET", `documents/${notes}`);
    await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
      document: notes,
      baseRevision: view.revision.no,
      delete: true
    });
    await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
      path: "fresh",
      title: "Fresh",
      markdown: "Fresh.\n"
    });
    await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
      path: "orphan/page",
      title: "Orphan",
      markdown: "Orphan.\n"
    });
    await h.write(USERS.editor, "PUT", `documents/${notes}/content`, {
      markdown: "Newer notes.\n",
      expectedRevision: view.revision.no
    });
    await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
      title: "Fresh",
      slug: "fresh",
      markdown: "Someone got there first.\n"
    });
    const { data: detail } = await h.call(USERS.admin, "GET", `change-sets/${id}`);
    expect(
      detail.blockers.map((blocker: { code: string; path: string }) => [blocker.code, blocker.path]).sort()
    ).toEqual([
      ["CHANGE_SET_CONFLICT", "notes"],
      ["CHANGE_SET_NO_PARENT", "orphan/page"],
      ["DOCUMENT_PATH_TAKEN", "fresh"]
    ]);
  });

  it("is for anyone who can comment to make, and those who can edit to merge", async () => {
    const id = await fresh();
    await addEdit(id, guide, "# Guide\n\nChanged.\n");
    expect((await h.call(USERS.commenter, "POST", `change-sets/${id}/merge`)).status).toBe(403);
    await h.call(USERS.admin, "PATCH", `spaces/${space}`, { defaultRole: "viewer" });
    expect((await h.call(USERS.commenter, "POST", `spaces/${space}/change-sets`, { title: "x" })).status).toBe(403);
    // What is proposed is not published, so reading it takes being able to comment.
    expect((await h.call(USERS.reader, "GET", `change-sets/${id}`)).status).toBe(404);
    await h.call(USERS.admin, "PATCH", `spaces/${space}`, { defaultRole: "none" });
    expect((await h.call(USERS.reader, "GET", `change-sets/${id}`)).status).toBe(404);
    expect((await h.call(USERS.reader, "GET", `spaces/${space}/change-sets`)).status).toBe(404);
    expect((await h.call(USERS.editor, "GET", "change-sets/not-one")).status).toBe(404);
  });

  it("lets its author and those who can edit change it, and nobody else", async () => {
    const id = await fresh();
    const { id: item } = await addEdit(id, guide, "# Guide\n\nChanged.\n");
    await h.call(USERS.admin, "PUT", `spaces/${space}/members`, {
      subject: `user:${USERS.reader.id}`,
      role: "commenter"
    });
    expect((await h.call(USERS.reader, "PATCH", `change-sets/${id}`, { title: "Mine now" })).status).toBe(403);
    expect((await h.call(USERS.reader, "POST", `change-sets/${id}/close`)).status).toBe(403);
    expect((await h.call(USERS.reader, "DELETE", `change-sets/${id}/pages/${item}`)).status).toBe(403);
    expect((await h.call(USERS.commenter, "PATCH", `change-sets/${id}`, { title: "Better title" })).data.title).toBe(
      "Better title"
    );
    expect((await h.call(USERS.editor, "PATCH", `change-sets/${id}`, { description: "Why" })).data.description).toBe(
      "Why"
    );
    expect((await h.call(USERS.commenter, "DELETE", `change-sets/${id}/pages/${item}`)).status).toBe(200);
    expect((await h.call(USERS.commenter, "DELETE", `change-sets/${id}/pages/${item}`)).status).toBe(404);
    expect((await h.call(USERS.admin, "GET", `change-sets/${id}`)).data.pages).toEqual([]);
  });

  it("replaces what it said about a page when told again", async () => {
    const id = await fresh();
    await addEdit(id, guide, "# Guide\n\nFirst try.\n");
    await addEdit(id, guide, "# Guide\n\nSecond try.\n");
    const { data: detail } = await h.call(USERS.admin, "GET", `change-sets/${id}`);
    expect(detail.pages).toHaveLength(1);
    expect(detail.pages[0].proposedMarkdown).toContain("Second try.");
    await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
      path: "same",
      title: "One",
      markdown: "One.\n"
    });
    await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
      path: "SAME",
      title: "Two",
      markdown: "Two.\n"
    });
    expect(
      (await h.call(USERS.admin, "GET", `change-sets/${id}`)).data.pages.filter(
        (item: { kind: string }) => item.kind === "create"
      )
    ).toMatchObject([{ title: "Two" }]);
  });

  it("refuses what could never land", async () => {
    const id = await fresh();
    const add = (body: object) => h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, body);
    expect((await add({ path: "bad/se:gment", title: "x", markdown: "" })).status).toBe(422);
    expect((await add({ path: "guide", title: "x", markdown: "" })).status).toBe(409);
    expect((await add({ document: guide, baseRevision: 99, markdown: "x" })).status).toBe(422);
    expect((await add({ document: guide, baseRevision: 1 })).status).toBe(422);
    expect((await add({ document: "nothing/here", baseRevision: 1, markdown: "x" })).status).toBe(404);
    expect((await add({ path: "big", title: "Big", markdown: "x".repeat(2 * 1024 * 1024 + 1) })).status).toBe(422);
    expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).error.details.blockers).toMatchObject([
      { code: "CHANGE_SET_EMPTY" }
    ]);
    await h.call(USERS.admin, "POST", "spaces", { slug: `${space}x`, name: "Elsewhere", defaultRole: "commenter" });
    const { data: other } = await h.call(USERS.admin, "POST", `spaces/${space}x/documents`, {
      title: "Other",
      slug: "other",
      markdown: "x\n"
    });
    expect((await add({ document: other.document.id, baseRevision: 1, markdown: "y" })).status).toBe(422);
  });

  it("can be closed and reopened, and takes no changes while closed", async () => {
    const id = await fresh();
    await addEdit(id, guide, "# Guide\n\nChanged.\n");
    expect((await h.call(USERS.commenter, "POST", `change-sets/${id}/close`)).data.status).toBe("closed");
    expect(
      (await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, { path: "x", title: "x", markdown: "" })).status
    ).toBe(409);
    expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).status).toBe(409);
    expect(
      (await h.call(USERS.admin, "GET", `spaces/${space}/change-sets?status=closed`)).data.map(
        (item: { id: string }) => item.id
      )
    ).toEqual([id]);
    expect((await h.call(USERS.admin, "GET", `spaces/${space}/change-sets?status=open`)).data).toEqual([]);
    expect((await h.call(USERS.admin, "GET", `spaces/${space}/change-sets?status=eaten`)).status).toBe(422);
    expect((await h.call(USERS.commenter, "POST", `change-sets/${id}/reopen`)).data).toMatchObject({
      status: "open",
      decidedName: null
    });
    expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).error).toBeUndefined();
    expect((await h.call(USERS.editor, "POST", `change-sets/${id}/reopen`)).status).toBe(409);
  });

  it("can be deleted by whoever made it, or whoever an agent made it for, and by the space's administrators, until it is merged", async () => {
    const id = await fresh("Made by mistake");
    await addEdit(id, guide, "# Guide\n\nChanged.\n");
    await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "changes_requested" });
    expect((await h.call(USERS.commenter, "GET", `change-sets/${id}`)).data.canDelete).toBe(true);
    expect((await h.call(USERS.admin, "GET", `change-sets/${id}`)).data.canDelete).toBe(true);
    expect((await h.call(USERS.editor, "GET", `change-sets/${id}`)).data.canDelete).toBe(false);
    expect((await h.call(USERS.editor, "DELETE", `change-sets/${id}`)).status).toBe(403);
    expect((await h.call(USERS.commenter, "DELETE", `change-sets/${id}`)).data).toEqual({ deleted: true });
    expect((await h.call(USERS.commenter, "GET", `change-sets/${id}`)).status).toBe(404);
    const { rows } = await h.pool.query(
      `SELECT (SELECT count(*)::int FROM pandocs.change_set_pages WHERE change_set_id = $1) AS pages, (SELECT count(*)::int FROM pandocs.change_set_reviews WHERE change_set_id = $1) AS reviews, (SELECT count(*)::int FROM pandocs.notifications WHERE change_set_id = $1) AS notices`,
      [id]
    );
    expect(rows[0]).toEqual({ pages: 0, reviews: 0, notices: 0 });
    const { data: audit } = await h.call(USERS.admin, "GET", `spaces/${space}/audit`);
    expect(JSON.stringify(audit)).toContain("space.change_set.delete");
    expect(JSON.stringify(audit)).toContain("Made by mistake");

    const closed = await fresh("Abandoned");
    await h.call(USERS.commenter, "POST", `change-sets/${closed}/close`);
    expect((await h.call(USERS.admin, "DELETE", `change-sets/${closed}`)).status).toBe(200);

    const fromAgent = (await h.call(USERS.agent, "POST", `spaces/${space}/change-sets`, { title: "From the agent" }))
      .data.id as string;
    expect((await h.call(USERS.agent, "GET", `change-sets/${fromAgent}`)).data.canDelete).toBe(false);
    expect((await h.call(USERS.agent, "DELETE", `change-sets/${fromAgent}`)).status).toBe(403);
    expect((await h.call(USERS.editor, "DELETE", `change-sets/${fromAgent}`)).status).toBe(200);

    const landed = await fresh("Landed");
    await addEdit(landed, faq, "# FAQ\n\nAsk anything.\n");
    expect((await h.call(USERS.editor, "POST", `change-sets/${landed}/merge`)).error).toBeUndefined();
    expect((await h.call(USERS.commenter, "GET", `change-sets/${landed}`)).data.canDelete).toBe(false);
    const refused = await h.call(USERS.admin, "DELETE", `change-sets/${landed}`);
    expect(refused.status).toBe(409);
    expect(refused.error.code).toBe("CHANGE_SET_MERGED");
    expect((await textOf(faq)).revision.changeSetId).toBe(landed);
  });

  describe("reviews and rules", () => {
    const rules = (requiredApprovals: number, requireChangeSets = false) =>
      h.call(USERS.admin, "PATCH", `spaces/${space}`, { mergeRules: { requiredApprovals, requireChangeSets } });

    it("are set by those who run the space, within reason", async () => {
      expect(
        (
          await h.call(USERS.editor, "PATCH", `spaces/${space}`, {
            mergeRules: { requiredApprovals: 0, requireChangeSets: true }
          })
        ).status
      ).toBe(403);
      expect(
        (
          await h.call(USERS.admin, "PATCH", `spaces/${space}`, {
            mergeRules: { requiredApprovals: 11, requireChangeSets: false }
          })
        ).status
      ).toBe(422);
      expect((await rules(2, true)).data.mergeRules).toEqual({ requiredApprovals: 2, requireChangeSets: true });
      expect(
        (await h.call(USERS.reader, "GET", "bootstrap")).data.spaces.find(
          (item: { slug: string }) => item.slug === space
        )?.mergeRules ?? (await h.call(USERS.admin, "GET", `spaces/${space}`)).data.mergeRules
      ).toEqual({ requiredApprovals: 2, requireChangeSets: true });
      const { data: audit } = await h.call(USERS.admin, "GET", `spaces/${space}/audit`);
      expect(audit.items?.[0]?.action ?? audit[0]?.action).toBe("space.merge_rules");
    });

    it("hold a merge back until enough people have approved", async () => {
      await rules(2);
      const id = await fresh();
      await addEdit(id, guide, "# Guide\n\nChanged.\n");
      const merge = () => h.call(USERS.editor, "POST", `change-sets/${id}/merge`);
      expect((await merge()).error.details.blockers).toMatchObject([{ code: "APPROVALS_NEEDED" }]);
      expect(
        (await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved", note: "Fine" })).status
      ).toBe(200);
      expect((await merge()).status).toBe(409);
      // Saying it twice is not two people saying it.
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      expect((await merge()).status).toBe(409);
      await h.call(second, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      const { data: detail } = await h.call(USERS.commenter, "GET", `change-sets/${id}`);
      expect(detail.reviews.map((review: { reviewerName: string }) => review.reviewerName).sort()).toEqual(
        [second.displayName, USERS.editor.displayName].sort()
      );
      expect(detail.canMerge).toBe(false);
      expect((await h.call(second, "GET", `change-sets/${id}`)).data.canMerge).toBe(true);
      expect((await merge()).error).toBeUndefined();
    });

    it("do not count what its author says, or anything an agent says", async () => {
      const id = await fresh();
      await addEdit(id, guide, "# Guide\n\nChanged.\n");
      await h.call(USERS.admin, "PUT", `spaces/${space}/members`, {
        subject: `user:${USERS.commenter.id}`,
        role: "editor"
      });
      expect((await h.call(USERS.commenter, "POST", `change-sets/${id}/reviews`, { verdict: "approved" })).status).toBe(
        403
      );
      expect((await h.call(USERS.agent, "POST", `change-sets/${id}/reviews`, { verdict: "approved" })).status).toBe(
        403
      );
      expect((await h.call(USERS.reader, "POST", `change-sets/${id}/reviews`, { verdict: "approved" })).status).toBe(
        403
      );
    });

    it("let whoever an agent works for review what it wrote", async () => {
      await rules(1);
      const made = await h.call(USERS.agent, "POST", `spaces/${space}/change-sets`, { title: "From the agent" });
      expect(made.data.authorKind).toBe("agent");
      await addEdit(made.data.id as string, guide, "# Guide\n\nThe agent's.\n", USERS.agent);
      expect((await h.call(USERS.agent, "POST", `change-sets/${made.data.id as string}/merge`)).status).toBe(403);
      expect(
        (await h.call(USERS.editor, "POST", `change-sets/${made.data.id as string}/reviews`, { verdict: "approved" }))
          .status
      ).toBe(200);
      expect((await h.call(USERS.editor, "POST", `change-sets/${made.data.id as string}/merge`)).error).toBeUndefined();
    });

    it("start over when what was reviewed changes", async () => {
      await rules(1);
      const id = await fresh();
      await addEdit(id, guide, "# Guide\n\nChanged.\n");
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      expect((await h.call(USERS.admin, "GET", `change-sets/${id}`)).data.blockers).toEqual([]);
      await addEdit(id, faq, "# FAQ\n\nSneaked in.\n");
      const { data: detail } = await h.call(USERS.admin, "GET", `change-sets/${id}`);
      expect(detail.blockers).toMatchObject([{ code: "APPROVALS_NEEDED" }]);
      expect(detail.reviews).toMatchObject([{ reviewerName: USERS.editor.displayName, stale: true }]);
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      expect((await h.call(USERS.admin, "GET", `change-sets/${id}`)).data.blockers).toEqual([]);
    });

    it("hold a merge back while someone has asked for changes", async () => {
      const id = await fresh();
      await addEdit(id, guide, "# Guide\n\nChanged.\n");
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, {
        verdict: "changes_requested",
        note: "Not yet"
      });
      await h.call(second, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      expect((await h.call(second, "POST", `change-sets/${id}/merge`)).error.details.blockers).toMatchObject([
        { code: "CHANGES_REQUESTED" }
      ]);
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      expect((await h.call(second, "POST", `change-sets/${id}/merge`)).error).toBeUndefined();
    });

    it("stop anyone saving directly when a space says so", async () => {
      await rules(0, true);
      const { data: view } = await h.call(USERS.admin, "GET", `documents/${guide}`);
      const refused = async (result: Promise<{ status: number; error?: { code: string } }>) => {
        const { status, error } = await result;
        expect([status, error?.code]).toEqual([403, "CHANGE_SET_REQUIRED"]);
      };
      await refused(
        h.write(USERS.admin, "PUT", `documents/${guide}/content`, {
          markdown: "Direct.\n",
          expectedRevision: view.revision.no
        })
      );
      await refused(
        h.write(USERS.admin, "POST", `documents/${guide}/ops`, {
          ops: [{ op: "str_replace", pattern: "First", content: "Direct" }],
          expectedRevision: view.revision.no
        })
      );
      await refused(
        h.write(USERS.admin, "POST", `documents/${guide}/rollback`, { to: 1, expectedRevision: view.revision.no })
      );
      await refused(
        h.call(USERS.admin, "POST", `spaces/${space}/documents`, { title: "Direct", slug: "direct", markdown: "x\n" })
      );
      await refused(h.call(USERS.admin, "POST", `documents/${notes}/move`, { slug: "moved" }));
      await refused(h.call(USERS.admin, "DELETE", `documents/${notes}`));

      const id = await fresh();
      await addEdit(id, guide, "# Guide\n\nThrough review.\n");
      expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).error).toBeUndefined();
      expect((await textOf(guide)).markdown).toContain("Through review.");
    });

    it("let one person accepting a suggestion count as a review only where that is enough", async () => {
      await rules(1, true);
      const { data: view } = await h.call(USERS.admin, "GET", `documents/${guide}`);
      const suggest = async (principal: Principal) =>
        (
          await h.write(principal, "POST", `documents/${guide}/proposals`, {
            baseRevision: view.revision.no,
            markdown: "# Guide\n\nSuggested.\n"
          })
        ).data.id as string;
      const own = await suggest(USERS.editor);
      expect((await h.write(USERS.editor, "POST", `proposals/${own}/decide`, { decision: "accept" })).error.code).toBe(
        "CHANGE_SET_REQUIRED"
      );
      const theirs = await suggest(USERS.commenter);
      expect(
        (await h.write(USERS.editor, "POST", `proposals/${theirs}/decide`, { decision: "accept" })).error
      ).toBeUndefined();
      await rules(2, true);
      const { data: now } = await h.call(USERS.admin, "GET", `documents/${guide}`);
      const next = (
        await h.write(USERS.commenter, "POST", `documents/${guide}/proposals`, {
          baseRevision: now.revision.no,
          markdown: "# Guide\n\nAgain.\n"
        })
      ).data.id as string;
      expect((await h.write(USERS.editor, "POST", `proposals/${next}/decide`, { decision: "accept" })).error.code).toBe(
        "CHANGE_SET_REQUIRED"
      );
    });

    it("keep a page's title and its place among its siblings to change sets too, and leave who can see it to its administrators", async () => {
      await rules(1, true);
      for (const patch of [{ title: "Renamed" }, { sortOrder: 99 }]) {
        expect((await h.call(USERS.editor, "PATCH", `documents/${guide}`, patch)).error?.code).toBe(
          "CHANGE_SET_REQUIRED"
        );
      }
      expect((await h.call(USERS.editor, "PATCH", `documents/${guide}`, { title: "Guide" })).status).toBe(200);
      expect((await h.call(USERS.admin, "PATCH", `documents/${guide}`, { restricted: true })).status).toBe(200);
      expect((await textOf(guide)).document).toMatchObject({ title: "Guide", restricted: true });
    });

    it("bring a page back from the trash once they land", async () => {
      expect((await h.call(USERS.admin, "DELETE", `documents/${notes}`)).status).toBe(200);
      await rules(0, true);
      expect((await h.call(USERS.editor, "POST", `documents/${notes}/restore`)).error?.code).toBe(
        "CHANGE_SET_REQUIRED"
      );
      const id = await fresh("Bring the notes back");
      const added = await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
        document: notes,
        restore: true
      });
      expect(added.status).toBe(201);
      expect(added.data).toMatchObject({ kind: "restore", path: "notes" });
      const { data: detail } = await h.call(USERS.editor, "GET", `change-sets/${id}`);
      expect(detail.pages).toMatchObject([
        { kind: "restore", path: "notes", documentId: notes, proposedMarkdown: "Old notes.\n" }
      ]);
      expect(detail.blockers).toEqual([]);
      expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).error).toBeUndefined();
      expect((await textOf(notes)).markdown).toBe("Old notes.\n");
      expect((await h.call(USERS.editor, "GET", `change-sets/${id}`)).data.status).toBe("merged");
    });

    it("only bring back what is in the trash, and say so once it no longer is", async () => {
      const id = await fresh();
      expect(
        (await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, { document: guide, restore: true })).error
          ?.code
      ).toBe("CHANGE_SET_NOT_IN_TRASH");
      await h.call(USERS.admin, "DELETE", `documents/${notes}`);
      expect(
        (await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, { document: notes, restore: true })).status
      ).toBe(201);
      expect((await h.call(USERS.admin, "POST", `documents/${notes}/restore`)).status).toBe(200);
      const { data: detail } = await h.call(USERS.editor, "GET", `change-sets/${id}`);
      expect(detail.blockers).toMatchObject([{ code: "CHANGE_SET_NOT_IN_TRASH", path: "notes" }]);
    });
  });

  describe("pages some people cannot read", () => {
    const withHidden = async () => {
      const made = await h.call(USERS.admin, "POST", `spaces/${space}/change-sets`, { title: "Including another" });
      const id = made.data.id as string;
      await addEdit(id, guide, "# Guide\n\nChanged.\n", USERS.admin);
      await addEdit(id, hidden, "New secret.\n", USERS.admin);
      return id;
    };

    it("are counted for them, and not shown", async () => {
      const id = await withHidden();
      const { data: detail } = await h.call(USERS.editor, "GET", `change-sets/${id}`);
      expect(detail.hiddenPages).toBe(1);
      expect(detail.pages.map((item: { path: string }) => item.path)).toEqual(["guide"]);
      expect(JSON.stringify(detail)).not.toContain("New secret");
      expect(JSON.stringify(detail)).not.toContain("prices");
      expect(detail.canMerge).toBe(false);
      expect((await h.call(USERS.admin, "GET", `change-sets/${id}`)).data.hiddenPages).toBe(0);
    });

    it("stop them reviewing or merging what they cannot read", async () => {
      const id = await withHidden();
      expect((await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved" })).status).toBe(
        403
      );
      expect((await h.call(USERS.editor, "POST", `change-sets/${id}/merge`)).status).toBe(404);
      expect((await textOf(guide)).markdown).toContain("First paragraph.");
    });

    it("cannot be added by someone who cannot read them", async () => {
      const id = await fresh();
      expect(
        (
          await h.call(USERS.commenter, "POST", `change-sets/${id}/pages`, {
            document: hidden,
            baseRevision: 1,
            markdown: "Mine.\n"
          })
        ).status
      ).toBe(404);
    });

    it("stay hidden once they are in the trash, and once they are gone for good", async () => {
      const id = await withHidden();
      expect((await h.call(USERS.admin, "DELETE", `documents/${hidden}`)).status).toBe(200);
      const trashed = (await h.call(USERS.editor, "GET", `change-sets/${id}`)).data;
      expect(trashed.hiddenPages).toBe(1);
      expect(JSON.stringify(trashed)).not.toMatch(/secret|prices/iu);
      expect((await h.call(USERS.admin, "POST", `change-sets/${id}/close`)).status).toBe(200);
      expect((await h.call(USERS.admin, "DELETE", `documents/${hidden}/purge`)).status).toBe(200);
      const gone = (await h.call(USERS.editor, "GET", `change-sets/${id}`)).data;
      expect(gone.hiddenPages).toBe(1);
      expect(JSON.stringify(gone)).not.toMatch(/secret|prices/iu);
      expect((await h.call(USERS.admin, "GET", `change-sets/${id}`)).data.hiddenPages).toBe(0);
    });
  });

  it("are for those who can comment in the space, not everyone who can read it", async () => {
    const id = await fresh();
    await addEdit(id, guide, "# Guide\n\nNot agreed yet.\n");
    await h.call(USERS.admin, "PATCH", `spaces/${space}`, { defaultRole: "viewer" });
    expect((await h.call(USERS.reader, "GET", `spaces/${space}/change-sets`)).status).toBe(403);
    expect((await h.call(USERS.reader, "GET", `change-sets/${id}`)).status).toBe(404);
    expect((await h.call(USERS.editor, "GET", `change-sets/${id}`)).data.pages).toHaveLength(1);
  });

  describe("who hears about them", () => {
    it("tells whoever can review that one is waiting, until they have answered", async () => {
      const id = await fresh("Waiting");
      const waiting = async (principal: Principal) =>
        (await h.call(principal, "GET", "me/inbox")).data.changeSets.map((item: { id: string }) => item.id);
      expect(await waiting(USERS.editor)).toEqual([]);
      await addEdit(id, guide, "# Guide\n\nChanged.\n");
      expect(await waiting(USERS.editor)).toEqual([id]);
      expect(await waiting(USERS.commenter)).toEqual([]);
      expect(await waiting(USERS.reader)).toEqual([]);
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      expect(await waiting(USERS.editor)).toEqual([]);
      await addEdit(id, guide, "# Guide\n\nChanged again.\n");
      expect(await waiting(USERS.editor)).toEqual([id]);
    });

    it("tells its author what became of it", async () => {
      const id = await fresh("My work");
      await addEdit(id, guide, "# Guide\n\nChanged.\n");
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "changes_requested" });
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      await h.call(USERS.editor, "POST", `change-sets/${id}/merge`);
      const { data } = await h.call(USERS.commenter, "GET", "me/inbox");
      const about = data.notifications.filter((item: { changeSetId: string }) => item.changeSetId === id);
      expect(about.map((item: { summary: string }) => item.summary)).toEqual([
        "merged your change set",
        "approved your change set",
        "asked for changes to your change set"
      ]);
      expect(about[0]).toMatchObject({
        kind: "change_set",
        documentTitle: "My work",
        spaceSlug: space,
        actorName: USERS.editor.displayName
      });
    });

    it("leaves a trail, and tells webhooks", async () => {
      await h.call(USERS.admin, "POST", `spaces/${space}/webhooks`, {
        name: "Hook",
        kind: "generic",
        url: "https://hooks.example.com/in",
        events: ["change_set.created", "change_set.reviewed", "change_set.merged", "change_set.closed", "page.updated"]
      });
      const id = await fresh("Announced");
      await addEdit(id, guide, "# Guide\n\nChanged.\n");
      await h.call(USERS.editor, "POST", `change-sets/${id}/reviews`, { verdict: "approved" });
      await h.call(USERS.editor, "POST", `change-sets/${id}/merge`);
      const { rows } = await h.pool.query(
        `SELECT d.event, d.payload FROM pandocs.webhook_deliveries d JOIN pandocs.webhooks w ON w.id = d.webhook_id WHERE w.space_id = (SELECT id FROM pandocs.spaces WHERE slug = $1) ORDER BY d.created_at`,
        [space]
      );
      expect(rows.map(row => row.event)).toEqual([
        "change_set.created",
        "change_set.reviewed",
        "page.updated",
        "change_set.merged"
      ]);
      expect(rows[3].payload.changeSet).toMatchObject({ id, title: "Announced", pages: 1 });
      expect(rows[3].payload.space.slug).toBe(space);
      const { data: audit } = await h.call(USERS.admin, "GET", `spaces/${space}/audit`);
      expect(JSON.stringify(audit)).toContain("space.change_set.merge");
    });
  });

  describe("for tools", () => {
    it("lets an agent propose across pages, and leaves the deciding to people", async () => {
      const { data: tools } = await h.call(USERS.admin, "GET", "tools");
      expect(tools.map((tool: { name: string }) => tool.name)).toEqual(
        expect.arrayContaining(["change_set_create", "change_set_add_page", "change_set_get", "change_set_merge"])
      );
      const made = await h.call(USERS.agent, "POST", "tools/change_set_create", { space, title: "Across pages" });
      const id = made.data.id as string;
      const { data: view } = await h.call(USERS.agent, "POST", "tools/doc_get", { doc: `${space}/guide` });
      expect(
        (
          await h.call(USERS.agent, "POST", "tools/change_set_add_page", {
            changeSet: id,
            doc: `${space}/guide`,
            baseRevision: view.revision.no,
            markdown: "# Guide\n\nFrom a tool.\n"
          })
        ).status
      ).toBe(200);
      expect(
        (
          await h.call(USERS.agent, "POST", "tools/change_set_add_page", {
            changeSet: id,
            path: "added",
            title: "Added",
            markdown: "Added.\n"
          })
        ).status
      ).toBe(200);
      expect(
        (await h.call(USERS.agent, "POST", "tools/change_set_add_page", { changeSet: id, title: "Neither" })).status
      ).toBe(422);
      const { data: read } = await h.call(USERS.agent, "POST", "tools/change_set_get", { changeSet: id });
      expect(read.pages).toHaveLength(2);
      expect((await h.call(USERS.agent, "POST", "tools/change_set_merge", { changeSet: id })).status).toBe(403);
      expect((await h.call(USERS.editor, "POST", "tools/change_set_merge", { changeSet: id })).status).toBe(200);
      expect((await textOf(guide)).markdown).toContain("From a tool.");
    });
  });
});
