import { createLiveCodec, LIVE_FIELD, LIVE_META } from "@pandocs/editor-model";
import type { LiveCodecPort, Principal } from "@pandocs/core";
import { mergeThreeWay } from "@pandocs/markdown";
import * as Y from "yjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const codec = createLiveCodec();
const liveCodec: LiveCodecPort = {
  seed: async (markdown, meta) => codec.seed(markdown, meta),
  markdownOf: async (state, baseMarkdown) => codec.markdownOf(state, baseMarkdown),
  align: async (state, markdown, meta) => codec.align(state, markdown, meta),
  merge: async (base, ours, theirs) => mergeThreeWay(base, ours, theirs)
};

/** Someone's copy of the draft. */
const opened = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
};
/** Types into a top-level paragraph. */
const typeInto = (doc: Y.Doc, block: number, at: number, text: string) => ((doc.getXmlFragment(LIVE_FIELD).get(block) as Y.XmlElement).get(0) as Y.XmlText).insert(at, text);

describe("the draft a page's editors share", () => {
  let h: ReturnType<typeof createHarness>;
  let spaceNo = 0;
  let space = "";
  let id = "";
  const BASE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

  const makePage = async (markdown = BASE) => {
    const made = await h.call(USERS.admin, "POST", `spaces/${space}/documents`, { title: "Guide", slug: `guide-${spaceNo}`, markdown });
    expect(made.error).toBeUndefined();
    return made.data.document.id as string;
  };
  const open = async (principal: Principal = USERS.admin) => {
    const { data, error } = await h.call(principal, "POST", `documents/${id}/live`);
    expect(error).toBeUndefined();
    return data as { available: true; name: string; baseRevision: number };
  };
  const state = async () => (await h.services.live.read(id))!.state;
  const draftText = async (base: string) => liveCodec.markdownOf(await state(), base);
  /** What a replica does with what its people typed. */
  const store = async (name: string, doc: Y.Doc, contributors: Record<string, string> = { [USERS.editor.id]: USERS.editor.displayName }) => {
    const version = await h.services.live.write(id, name, stored => {
      Y.applyUpdate(doc, stored);
      return Y.encodeStateAsUpdate(doc);
    }, { touched: true, contributors });
    expect(version).not.toBeNull();
  };
  const save = async (principal: Principal, markdown: string, more: object = {}) => {
    const view = (await h.call(principal, "GET", `documents/${id}`)).data;
    const saved = await h.write(principal, "PUT", `documents/${id}/content`, { markdown, expectedRevision: view.revision.no, ...more });
    expect(saved.error).toBeUndefined();
    return saved.data;
  };
  const row = async () => (await h.pool.query(`SELECT * FROM pandocs.live_drafts WHERE document_id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString(), { liveCodec });
  });
  beforeEach(async () => {
    spaceNo += 1;
    space = `space-${spaceNo}`;
    await h.call(USERS.admin, "POST", "spaces", { slug: space, name: "Docs", defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", `spaces/${space}/members`, { subject: `user:${USERS.editor.id}`, role: "editor" });
    await h.call(USERS.admin, "PUT", `spaces/${space}/members`, { subject: `user:${USERS.commenter.id}`, role: "commenter" });
    id = await makePage();
  });
  afterAll(() => h.close());

  describe("joining", () => {
    it("starts one draft for everyone, saying what the page says", async () => {
      const first = await open(USERS.admin);
      const second = await open(USERS.editor);
      expect(first.available).toBe(true);
      expect(second.name).toBe(first.name);
      expect(first.baseRevision).toBe(1);
      expect(await draftText(BASE)).toBe(BASE);
      expect(first.name.startsWith(`${id}.`)).toBe(true);
    });

    it("starts only one when everyone arrives at once, as two would mean everything twice", async () => {
      const names = await Promise.all(Array.from({ length: 8 }, () => open()));
      expect(new Set(names.map(name => name.name)).size).toBe(1);
      expect(await draftText(BASE)).toBe(BASE);
    });

    it("is for people who can edit the page and nobody else", async () => {
      expect((await h.call(USERS.commenter, "POST", `documents/${id}/live`)).status).toBe(403);
      expect((await h.call(USERS.reader, "POST", `documents/${id}/live`)).status).toBe(403);
      expect((await h.call(USERS.stranger, "DELETE", `documents/${id}/live`)).status).toBeGreaterThanOrEqual(403);
      expect((await h.call(USERS.agent, "POST", `documents/${id}/live`)).status).toBe(403);
      const readOnly = { ...USERS.editor, scopes: ["read"] } as Principal;
      await expect(h.services.live.open(readOnly, id)).rejects.toMatchObject({ status: 403 });
    });

    it("is not a way around a space's review rules", async () => {
      await h.call(USERS.admin, "PATCH", `spaces/${space}`, { mergeRules: { requiredApprovals: 0, requireChangeSets: true } });
      const refused = await h.call(USERS.editor, "POST", `documents/${id}/live`);
      expect(refused.status).toBe(403);
      expect(refused.error.code).toBe("CHANGE_SET_REQUIRED");
    });

    it("says so on a server that cannot do this", async () => {
      const without = createHarness(fixture.getConnectionString());
      try {
        expect((await without.call(USERS.admin, "POST", `documents/${id}/live`)).data).toEqual({ available: false });
        expect((await without.call(USERS.admin, "GET", `documents/${id}/live`)).data).toEqual({ available: false, unsaved: null });
      } finally {
        await without.close();
      }
    });

    it("lets a connection in only to the draft that is there now", async () => {
      const { name } = await open();
      await expect(h.services.live.admit(USERS.editor, name)).resolves.toBe(id);
      await expect(h.services.live.admit(USERS.editor, `${id}.something-older`)).rejects.toMatchObject({ code: "LIVE_DRAFT_STALE" });
      // Only exactly that name: a replica keeps one copy of a draft per page, and another name for it would get in the way of that.
      await expect(h.services.live.admit(USERS.editor, `${name}.more`)).rejects.toMatchObject({ code: "LIVE_DRAFT_STALE" });
      await expect(h.services.live.admit(USERS.reader, name)).rejects.toMatchObject({ status: 403 });
      await expect(h.services.live.admit(USERS.editor, "not-a-draft")).rejects.toMatchObject({ status: 404 });
    });

    it("stops letting someone in once they can no longer edit", async () => {
      const { name } = await open(USERS.editor);
      await h.call(USERS.admin, "PUT", `spaces/${space}/members`, { subject: `user:${USERS.editor.id}`, role: "viewer" });
      await expect(h.services.live.admit(USERS.editor, name)).rejects.toMatchObject({ status: 403 });
    });

    it("stops letting anyone in once the page is gone", async () => {
      const { name } = await open();
      await h.call(USERS.admin, "DELETE", `documents/${id}`);
      await expect(h.services.live.admit(USERS.admin, name)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("keeping what people typed", () => {
    it("adds up what several replicas hold, whatever order they write in", async () => {
      const { name } = await open();
      const seeded = await state();
      const one = opened(seeded);
      const other = opened(seeded);
      typeInto(one, 1, 5, " typed on one");
      typeInto(other, 2, 6, " typed on the other");
      await store(name, one);
      await store(name, other);
      await store(name, one);
      const expected = "# Title\n\nFirst typed on one paragraph.\n\nSecond typed on the other paragraph.\n\nThird paragraph.\n";
      expect(await draftText(BASE)).toBe(expected);
      expect(codec.markdownOf(Y.encodeStateAsUpdate(one), BASE)).toBe(expected);
    });

    it("refuses to write to a draft that has been started again", async () => {
      await open();
      expect(await h.services.live.write(id, `${id}.older`, stored => stored, { touched: true, contributors: {} })).toBeNull();
    });

    it("remembers who typed, and what is not saved", async () => {
      const { name } = await open();
      expect((await h.call(USERS.editor, "GET", `documents/${id}/live`)).data.unsaved).toBeNull();
      const doc = opened(await state());
      typeInto(doc, 1, 0, "Edited: ");
      await store(name, doc);
      const { data } = await h.call(USERS.admin, "GET", `documents/${id}/live`);
      expect(data.unsaved.contributors).toEqual([USERS.editor.displayName]);
      const { data: drafts } = await h.call(USERS.editor, "GET", "me/drafts");
      expect(drafts.find((draft: { documentId: string }) => draft.documentId === id)).toMatchObject({ shared: true, lang: "", title: "Guide" });
      const { data: others } = await h.call(USERS.admin, "GET", "me/drafts");
      expect(others.find((draft: { documentId: string }) => draft.documentId === id)).toBeUndefined();
    });

    it("does not list a shared draft for someone who can no longer edit the page", async () => {
      const { name } = await open();
      const doc = opened(await state());
      typeInto(doc, 1, 0, "Edited: ");
      await store(name, doc);
      await h.call(USERS.admin, "PUT", `spaces/${space}/members`, { subject: `user:${USERS.editor.id}`, role: "viewer" });
      const { data: drafts } = await h.call(USERS.editor, "GET", "me/drafts");
      expect(drafts.find((draft: { documentId: string }) => draft.documentId === id)).toBeUndefined();
    });
  });

  describe("when the page changes from elsewhere", () => {
    it("follows a version made while nobody has changed anything", async () => {
      const { name } = await open();
      const next = BASE.replace("Second", "Changed second");
      await save(USERS.admin, next);
      expect(await h.services.live.behind([id])).toEqual([id]);
      const caught = await h.services.live.catchUp(id);
      expect(caught).not.toBeNull();
      expect(await h.services.live.behind([id])).toEqual([]);
      expect(await draftText(next)).toBe(next);
      const row1 = await row();
      expect(row1.base_revision_no).toBe(2);
      expect(row1.has_changes).toBe(false);
      expect((await open()).name).toBe(name);
      expect(opened(await state()).getMap(LIVE_META).get("baseRevision")).toBe(2);
    });

    it("does it once, however many replicas try", async () => {
      await open();
      await save(USERS.admin, BASE.replace("Second", "Changed second"));
      const results = await Promise.all([h.services.live.catchUp(id), h.services.live.catchUp(id), h.services.live.catchUp(id)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await draftText(BASE.replace("Second", "Changed second"))).toBe(BASE.replace("Second", "Changed second"));
    });

    it("merges a version into what people are typing, so that they see it and their save does not undo it", async () => {
      const { name } = await open();
      const person = opened(await state());
      typeInto(person, 1, 5, " typed");
      await store(name, person);
      await save(USERS.admin, BASE.replace("Third", "Changed third"));
      const caught = await h.services.live.catchUp(id);
      Y.applyUpdate(person, caught!.change);
      const expected = "# Title\n\nFirst typed paragraph.\n\nSecond paragraph.\n\nChanged third paragraph.\n";
      expect(codec.markdownOf(Y.encodeStateAsUpdate(person), BASE.replace("Third", "Changed third"))).toBe(expected);
      expect(await draftText(BASE.replace("Third", "Changed third"))).toBe(expected);
      expect((await row()).has_changes).toBe(true);
    });

    it("merges with typing that has not even been stored yet", async () => {
      await open();
      const person = opened(await state());
      await save(USERS.admin, BASE.replace("Third", "Changed third"));
      typeInto(person, 1, 5, " typed");
      Y.applyUpdate(person, (await h.services.live.catchUp(id))!.change);
      expect(codec.markdownOf(Y.encodeStateAsUpdate(person), BASE)).toBe("# Title\n\nFirst typed paragraph.\n\nSecond paragraph.\n\nChanged third paragraph.\n");
    });

    it("keeps the draft's text where both changed the same place, and says so", async () => {
      const { name } = await open();
      const person = opened(await state());
      typeInto(person, 2, 0, "Ours: ");
      await store(name, person);
      await save(USERS.admin, BASE.replace("Second paragraph.", "Theirs entirely.").replace("Third", "Changed third"));
      const caught = await h.services.live.catchUp(id);
      Y.applyUpdate(person, caught!.change);
      const text = codec.markdownOf(Y.encodeStateAsUpdate(person), BASE);
      expect(text).toContain("Ours: Second paragraph.");
      expect(text).not.toContain("Theirs entirely.");
      expect(text).toContain("Changed third paragraph.");
      const meta = person.getMap(LIVE_META);
      expect(meta.get("conflictAt")).toBe(2);
      expect(meta.get("baseRevision")).toBe(2);
      expect(meta.get("savedBy")).toBe(USERS.admin.displayName);
      // A save after that overwrites it knowingly, and the version is still in the history.
      await save(USERS.editor, text);
      await h.services.live.catchUp(id);
      expect((await h.call(USERS.admin, "GET", `documents/${id}/revisions/2`)).data.markdown).toContain("Theirs entirely.");
    });

    it("follows every way a page can change, such as going back to an old version", async () => {
      await open();
      await save(USERS.admin, BASE.replace("Second", "Changed second"));
      await h.services.live.catchUp(id);
      const rolled = await h.write(USERS.admin, "POST", `documents/${id}/rollback`, { to: 1, expectedRevision: 2 });
      expect(rolled.error).toBeUndefined();
      await h.services.live.catchUp(id);
      expect(await draftText(BASE)).toBe(BASE);
    });

    it("catches up when someone joins, for a change made while nobody was there", async () => {
      await open();
      const next = BASE.replace("Second", "Changed second");
      await save(USERS.admin, next);
      expect((await open(USERS.editor)).baseRevision).toBe(2);
      expect(await draftText(next)).toBe(next);
    });

    it("says nothing is unsaved once a save has taken everything in", async () => {
      const { name } = await open();
      const person = opened(await state());
      typeInto(person, 1, 0, "Edited: ");
      await store(name, person);
      const text = await draftText(BASE);
      await save(USERS.admin, text, { fromLiveDraft: true });
      await h.services.live.catchUp(id);
      const after = await row();
      expect(after.has_changes).toBe(false);
      expect(after.contributors).toEqual({});
      expect((await h.call(USERS.admin, "GET", `documents/${id}/live`)).data.unsaved).toBeNull();
    });

    it("credits who else wrote what a save takes in", async () => {
      const { name } = await open();
      const person = opened(await state());
      typeInto(person, 1, 0, "Edited: ");
      await store(name, person);
      await save(USERS.admin, await draftText(BASE), { fromLiveDraft: true, message: "Tidied up" });
      const { data: revisions } = await h.call(USERS.admin, "GET", `documents/${id}/revisions`);
      expect(revisions[0].message).toContain("Tidied up");
      expect(revisions[0].message).toContain(USERS.editor.displayName);
      expect(revisions[0].actorName).toBe(USERS.admin.displayName);
    });

    it("does not credit anyone with what an unrelated change to the page says", async () => {
      const { name } = await open();
      const person = opened(await state());
      typeInto(person, 1, 0, "Edited: ");
      await store(name, person);
      await save(USERS.admin, BASE.replace("Third", "Changed third"));
      const { data: revisions } = await h.call(USERS.admin, "GET", `documents/${id}/revisions`);
      expect(revisions[0].message).not.toContain(USERS.editor.displayName);
    });
  });

  describe("discarding", () => {
    it("takes everyone back to what the page says, and is on record", async () => {
      const { name } = await open();
      const person = opened(await state());
      typeInto(person, 1, 0, "Edited: ");
      typeInto(person, 2, 0, "Also: ");
      await store(name, person);
      const before = Y.encodeStateVector(person);
      expect((await h.call(USERS.editor, "DELETE", `documents/${id}/live`)).status).toBe(200);
      expect(await draftText(BASE)).toBe(BASE);
      // Someone connected gets it as a change to what they have.
      Y.applyUpdate(person, await state());
      expect(Y.encodeStateVector(person)).not.toEqual(before);
      expect(codec.markdownOf(Y.encodeStateAsUpdate(person), BASE)).toBe(BASE);
      expect(person.getMap(LIVE_META).get("discardedBy")).toBe(USERS.editor.displayName);
      expect((await row()).has_changes).toBe(false);
      const { data: audit } = await h.call(USERS.admin, "GET", `spaces/${space}/audit`);
      expect(JSON.stringify(audit)).toContain("document.live_draft.discard");
    });

    it("needs edit rights", async () => {
      await open();
      expect((await h.call(USERS.commenter, "DELETE", `documents/${id}/live`)).status).toBe(403);
    });
  });

  describe("tidying up", () => {
    const longIdle = () => h.pool.query(`UPDATE pandocs.live_drafts SET last_seen_at = now() - interval '1 hour' WHERE document_id = $1`, [id]);
    const sweepAll = async () => {
      while (await h.services.live.sweep() > 0) { /* until none are left */ }
    };

    it("removes a draft nobody has been in that says what the page says, and the next one is a new one", async () => {
      const { name } = await open();
      await longIdle();
      await sweepAll();
      expect(await row()).toBeUndefined();
      const next = await open();
      expect(next.name).not.toBe(name);
      await expect(h.services.live.admit(USERS.admin, name)).rejects.toMatchObject({ code: "LIVE_DRAFT_STALE" });
    });

    it("keeps one with something unsaved in it, however long it has been", async () => {
      const { name } = await open();
      const person = opened(await state());
      typeInto(person, 1, 0, "Edited: ");
      await store(name, person);
      await longIdle();
      await sweepAll();
      const kept = await row();
      expect(kept).toBeDefined();
      expect(kept.settled).toBe(true);
      expect(kept.has_changes).toBe(true);
      expect((await open()).name).toBe(name);
      expect(await draftText(BASE)).toContain("Edited: First");
    });

    it("leaves alone one that someone is in", async () => {
      const { name } = await open();
      await sweepAll();
      expect((await open()).name).toBe(name);
      await longIdle();
      const seen = await h.services.live.stillOpen([id]);
      expect(seen.get(id)?.name).toBe(name);
      await sweepAll();
      expect((await open()).name).toBe(name);
    });

    it("does not call something unsaved because someone merely opened it", async () => {
      const { name } = await open();
      const person = opened(await state());
      // What an editor adds after a last block, and nothing else.
      const fragment = person.getXmlFragment(LIVE_FIELD);
      fragment.insert(fragment.length, [new Y.XmlElement("paragraph")]);
      await store(name, person);
      await longIdle();
      await sweepAll();
      expect(await row()).toBeUndefined();
    });

    it("looks again at a kept draft after someone has been back", async () => {
      const { name } = await open();
      const person = opened(await state());
      typeInto(person, 1, 0, "Edited: ");
      await store(name, person);
      await longIdle();
      await sweepAll();
      // Someone returns, and takes it back out.
      ((person.getXmlFragment(LIVE_FIELD).get(1) as Y.XmlElement).get(0) as Y.XmlText).delete(0, "Edited: ".length);
      await store(name, person);
      await longIdle();
      await sweepAll();
      expect(await row()).toBeUndefined();
    });

    it("goes with its page", async () => {
      await open();
      await h.pool.query(`DELETE FROM pandocs.documents WHERE id = $1`, [id]);
      expect(await row()).toBeUndefined();
    });
  });
});
