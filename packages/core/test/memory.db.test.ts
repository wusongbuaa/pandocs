import { randomUUID } from "node:crypto";
import type { Principal } from "@pandocs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const postgres = usePostgresFixture();
const space = "project";
const agent: Principal = { ...USERS.agent, scopes: ["read", "write", "agent:direct"] };
const rules = { agentWrites: "direct" as const, requiredApprovals: 0, requireChangeSets: false };

describe("project memory tools", () => {
  let h: ReturnType<typeof createHarness>;
  const remember = (input: object, principal = agent) =>
    h.call(principal, "POST", "tools/memory_remember", { space, requestId: randomUUID(), ...input });
  const recall = (input: object, principal = agent) =>
    h.call(principal, "POST", "tools/memory_recall", { space, ...input });

  beforeAll(async () => {
    await resetPandocs(postgres.getConnectionString());
    h = createHarness(postgres.getConnectionString(), { siteUrl: "https://docs.example.test/pandocs" });
    for (const slug of [space, "separate", "review"]) {
      await h.services.spaces.create(USERS.admin, { slug, name: slug });
      if (slug !== "review") await h.services.spaces.update(USERS.admin, slug, { mergeRules: rules });
      if (slug !== "separate")
        await h.services.spaces.setMember(USERS.admin, slug, `user:${USERS.editor.id}`, "editor");
    }
  });
  afterAll(() => h.close());

  it("serializes concurrent first appends and replays a lost reply exactly once", async () => {
    const topic = "发布顺序";
    const first = { topic, content: "First author's note", requestId: randomUUID(), labels: ["memory/project"] };
    const second = { topic, content: "Second author's note", labels: ["memory/reference"] };
    const [a, retry, b] = await Promise.all([
      remember(first),
      remember(first),
      remember(second, { ...agent, id: "agent-2" })
    ]);
    expect(a.error ?? retry.error ?? b.error).toBeUndefined();
    expect(retry.data).toEqual(a.data);
    expect(b.data.id).toBe(a.data.id);
    expect([a.data.revision, b.data.revision].sort()).toEqual([1, 2]);
    expect(a.data.url).toMatch(/^https:\/\/docs\.example\.test\/pandocs\/project\/memory-/u);
    expect((await remember({ ...first, content: "Different operation" })).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const page = await h.services.documents.read(USERS.admin, a.data.id);
    expect(page.markdown?.split("\n\n").sort()).toEqual([first.content, second.content].sort());
    expect(page.labels).toEqual(["memory/project", "memory/reference"]);
    const found = await recall({ labels: ["Memory/Project", "memory/reference"] });
    expect(found.data).toEqual([expect.objectContaining({ id: a.data.id, revision: 2, url: a.data.url })]);
    expect((await recall({ query: "发布顺序", labels: ["missing"] })).data).toEqual([]);
    expect((await recall({ query: topic }, { ...agent, scopes: ["read"] })).data).toHaveLength(1);
  });

  it("addresses renamed pages by ID and preserves human changes on a stale replacement", async () => {
    const created = (await remember({ topic: "Build setup", content: "Starting point" })).data;
    await h.services.tree.move(USERS.editor, created.id, { slug: "renamed" });
    expect((await remember({ topic: "Build setup", content: "After moving" })).data).toMatchObject({
      id: created.id,
      path: "renamed",
      revision: 2
    });
    await h.services.documents.saveContent(USERS.editor, created.id, {
      expectedRevision: 2,
      markdown: "Human correction"
    });
    const replacement = { doc: created.id, content: "Revised after review", mode: "replace" };
    expect((await remember(replacement)).status).toBe(422);
    expect((await remember({ ...replacement, expectedRevision: 2 })).error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { currentRevision: 3 }
    });
    expect((await h.services.documents.read(USERS.editor, created.id)).markdown).toBe("Human correction");
    expect((await remember({ ...replacement, expectedRevision: 3 })).data.revision).toBe(4);
  });

  it("keeps long Unicode topics with the same readable prefix on separate pages", async () => {
    const prefix = "迁移".repeat(75);
    const topics = [prefix + "甲", prefix + "乙"];
    const pages = await Promise.all(topics.map(topic => remember({ topic, content: "Original" })));
    expect(pages.map(page => page.status)).toEqual([200, 200]);
    expect(pages[0]!.data.id).not.toBe(pages[1]!.data.id);
    expect((await remember({ topic: topics[0], content: "Next" })).data).toMatchObject({
      id: pages[0]!.data.id,
      revision: 2
    });
  });

  it("applies space and page access to searches, writes and replays", async () => {
    const write = { topic: "Boundary", content: "In project", requestId: randomUUID() };
    const { id } = (await remember(write)).data;
    expect((await remember({ ...write, space: "separate" })).status).toBe(404);
    expect((await recall({ space: "separate", query: "Boundary" })).status).toBe(404);
    const other = (
      await h.services.documents.create(USERS.admin, { space: "separate", title: "Boundary", markdown: "Elsewhere" })
    ).document;
    expect((await remember({ doc: other.id, content: "Wrong space" })).status).toBe(404);
    expect((await recall({ space: "review", query: "Boundary" })).error.code).toBe("MEMORY_SPACE_REQUIRED");
    expect((await remember({ ...write, space: "review" })).error).toMatchObject({
      code: "MEMORY_SPACE_REQUIRED",
      message: expect.stringContaining("proposal_create")
    });
    expect((await remember(write, USERS.agent)).status).toBe(403);
    expect((await remember(write, { ...agent, scopes: ["read"] })).status).toBe(403);
    const headers = { "idempotency-key": randomUUID() };
    const edit = () =>
      h.call(agent, "PUT", `documents/${id}/content`, { expectedRevision: 1, markdown: "Updated" }, headers);
    expect((await edit()).data.revision.no).toBe(2);
    expect((await edit()).response.headers.get("idempotent-replay")).toBe("true");
    await h.services.documents.updateMeta(USERS.admin, id, { restricted: true });
    expect((await recall({ query: "Boundary" })).data).toEqual([]);
    expect((await remember(write)).status).toBe(404);
    expect((await edit()).status).toBe(404);
    await h.services.documents.setDocumentMember(USERS.admin, id, `user:${USERS.editor.id}`, "viewer");
    expect((await remember(write)).status).toBe(403);
    expect((await edit()).status).toBe(403);
    expect((await recall({ query: "Boundary" })).data).toHaveLength(1);
  });

  it("rolls back the content and the receipt if adding labels fails", async () => {
    const labels = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    const { id } = (await remember({ topic: "Atomic save", content: "Original", labels })).data;
    const requestId = randomUUID();
    expect((await remember({ doc: id, content: "New", labels: ["extra"], requestId })).status).toBe(422);
    expect((await h.services.documents.read(USERS.editor, id)).revision.no).toBe(1);
    expect((await remember({ doc: id, content: "New", labels: [labels[0]], requestId })).data.revision).toBe(2);
  });
});
