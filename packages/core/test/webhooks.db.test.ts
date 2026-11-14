import type { Principal, WebhookEvent, WebhookMessage, WebhookSendResult, WebhookTarget } from "@pandocs/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();

describe("webhooks", () => {
  let h: ReturnType<typeof createHarness>;
  let page = "";
  let hidden = "";
  const sent: { target: WebhookTarget; message: WebhookMessage }[] = [];
  let answer: WebhookSendResult = { ok: true, status: 200, error: null };

  const hookOf = async (body: object, principal: Principal = USERS.admin, path = "spaces/shop/webhooks") => {
    const created = await h.call(principal, "POST", path, {
      name: "Hook",
      kind: "generic",
      url: "https://hooks.example.com/in/secret-token",
      ...body
    });
    expect(created.error).toBeUndefined();
    return created.data as { id: string; url: string; hasSecret: boolean };
  };
  /** What a chat would be waiting for has arrived. */
  const dueNow = () =>
    h.pool.query("UPDATE pandocs.webhook_deliveries SET next_attempt_at = now() WHERE status = 'pending'");
  const drain = async () => {
    await dueNow();
    while (await h.services.webhooks.tick()) {
      /* until none are due */
    }
  };
  const save = async (id: string, markdown: string, message?: string) => {
    const { data: view } = await h.call(USERS.admin, "GET", `documents/${id}`);
    const result = await h.write(USERS.admin, "PUT", `documents/${id}/content`, {
      markdown,
      expectedRevision: view.revision.no,
      ...(message ? { message } : {})
    });
    expect(result.error).toBeUndefined();
  };
  const events = () => sent.flatMap(item => item.message.events.map((event: WebhookEvent) => event.event));

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString(), {
      webhookSender: {
        send: async (target, message) => {
          sent.push({ target, message });
          return answer;
        }
      }
    });
    await h.call(USERS.admin, "POST", "spaces", { slug: "shop", name: "Shop", defaultRole: "commenter" });
    await h.call(USERS.admin, "POST", "spaces", { slug: "other", name: "Other", defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", "spaces/shop/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    page = (
      await h.call(USERS.admin, "POST", "spaces/shop/documents", {
        title: "Returns",
        slug: "returns",
        markdown: "One\n"
      })
    ).data.document.id;
    hidden = (
      await h.call(USERS.admin, "POST", "spaces/shop/documents", {
        title: "Secret prices",
        slug: "cost",
        markdown: "One\n",
        restricted: true
      })
    ).data.document.id;
  });
  beforeEach(async () => {
    await h.pool.query("DELETE FROM pandocs.webhooks");
    sent.length = 0;
    answer = { ok: true, status: 200, error: null };
  });
  afterAll(() => h.close());

  it("never shows an address or a secret again, because they are what lets someone post there", async () => {
    const hook = await hookOf({ secret: "s3cret" });
    expect(hook.url).toBe("https://hooks.example.com/…");
    expect(hook.hasSecret).toBe(true);
    const { data: listed } = await h.call(USERS.admin, "GET", "spaces/shop/webhooks");
    expect(JSON.stringify(listed)).not.toContain("secret-token");
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    const { data: audit } = await h.call(USERS.admin, "GET", "spaces/shop/audit");
    expect(JSON.stringify(audit)).not.toContain("secret-token");
  });

  it("belongs to those who run the space, or the site", async () => {
    const hook = await hookOf({});
    expect((await h.call(USERS.editor, "GET", "spaces/shop/webhooks")).status).toBe(403);
    expect(
      (
        await h.call(USERS.editor, "POST", "spaces/shop/webhooks", {
          name: "x",
          kind: "generic",
          url: "https://example.com/"
        })
      ).status
    ).toBe(403);
    expect((await h.call(USERS.editor, "PATCH", `webhooks/${hook.id}`, { name: "Mine" })).status).toBe(404);
    expect((await h.call(USERS.editor, "DELETE", `webhooks/${hook.id}`)).status).toBe(404);
    expect((await h.call(USERS.editor, "GET", `webhooks/${hook.id}/deliveries`)).status).toBe(404);
    expect((await h.call(USERS.editor, "POST", `webhooks/${hook.id}/test`)).status).toBe(404);
    expect((await h.call(USERS.editor, "GET", "webhooks")).status).toBe(403);
    expect(
      (await h.call(USERS.editor, "POST", "webhooks", { name: "x", kind: "generic", url: "https://example.com/" }))
        .status
    ).toBe(403);
    expect((await h.call(USERS.agent, "GET", "webhooks")).status).toBe(403);
    expect((await h.call(USERS.admin, "GET", "webhooks")).status).toBe(200);
  });

  it("only takes addresses it can send to", async () => {
    for (const url of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "not a url", "http://"]) {
      expect(
        (await h.call(USERS.admin, "POST", "spaces/shop/webhooks", { name: "x", kind: "generic", url })).status,
        url
      ).toBe(422);
    }
    expect(
      (
        await h.call(USERS.admin, "POST", "spaces/shop/webhooks", {
          name: "x",
          kind: "carrier-pigeon",
          url: "https://example.com/"
        })
      ).status
    ).toBe(422);
    expect(
      (
        await h.call(USERS.admin, "POST", "spaces/shop/webhooks", {
          name: "x",
          kind: "generic",
          url: "https://example.com/",
          events: ["page.eaten"]
        })
      ).status
    ).toBe(422);
  });

  it("hears about what happens to pages, with what was said about it", async () => {
    await hookOf({});
    const { data: made } = await h.call(USERS.editor, "POST", "spaces/shop/documents", {
      title: "New page",
      slug: "new",
      markdown: "One\n",
      message: "First go"
    });
    const id = made.document.id as string;
    await save(id, "Two\n", "Second go");
    await h.call(USERS.admin, "POST", `documents/${id}/move`, { slug: "moved" });
    await h.call(USERS.admin, "DELETE", `documents/${id}`);
    await h.call(USERS.admin, "POST", `documents/${id}/restore`);
    await drain();
    expect(events()).toEqual(["page.created", "page.updated", "page.moved", "page.deleted", "page.restored"]);
    const [created, updated, moved] = sent.map(item => item.message.events[0]!);
    expect(created).toMatchObject({
      actor: { name: USERS.editor.displayName, kind: "user" },
      space: { slug: "shop", name: "Shop" },
      page: { id, title: "New page", path: "new", restricted: false },
      revision: 1,
      message: "First go"
    });
    expect(updated).toMatchObject({ revision: 2, message: "Second go" });
    expect(moved).toMatchObject({ from: "new", page: { path: "moved" } });
  });

  it("hears about discussions, suggestions and feedback", async () => {
    await hookOf({});
    const { data: thread } = await h.call(USERS.commenter, "POST", `documents/${page}/threads`, {
      anchor: { kind: "document" },
      body: "Is this right?"
    });
    await h.call(USERS.editor, "POST", `threads/${thread.id}/comments`, { body: "Yes" });
    await h.call(USERS.editor, "POST", `threads/${thread.id}/resolve`);
    const { data: view } = await h.call(USERS.admin, "GET", `documents/${page}`);
    const { data: proposal } = await h.write(USERS.commenter, "POST", `documents/${page}/proposals`, {
      baseRevision: view.revision.no,
      markdown: "Better\n",
      rationale: "Clearer"
    });
    await h.write(USERS.editor, "POST", `proposals/${proposal.id}/decide`, { decision: "accept" });
    await h.call(USERS.reader, "POST", `documents/${page}/feedback`, { kind: "helpful" });
    await h.call(USERS.reader, "POST", `documents/${page}/feedback`, {
      kind: "report",
      body: "It is wrong",
      quote: "Better"
    });
    await drain();
    expect(events()).toEqual([
      "comment.created",
      "comment.created",
      "thread.resolved",
      "proposal.created",
      "page.updated",
      "proposal.decided",
      "feedback.created"
    ]);
    const all = sent.map(item => item.message.events[0]!);
    expect(all[0]!.thread).toMatchObject({ id: thread.id, comment: "Is this right?" });
    expect(all[1]!.thread).toMatchObject({ comment: "Yes" });
    expect(all[3]!.proposal).toMatchObject({ id: proposal.id, status: "pending", rationale: "Clearer" });
    expect(all[5]!.proposal).toMatchObject({ status: "accepted" });
    expect(all[6]!.feedback).toEqual({ kind: "report", body: "It is wrong", quote: "Better" });
  });

  it("only sends what was asked for, for the space it belongs to, and keeps hidden pages out unless told otherwise", async () => {
    await hookOf({ name: "Saves only", events: ["page.updated"] });
    const { id: everything } = await hookOf({ name: "Hidden too", includeRestricted: true, events: ["page.updated"] });
    await hookOf({ name: "Other space" }, USERS.admin, "spaces/other/webhooks");
    const { id: wholeSite } = await hookOf({ name: "Whole site", events: ["page.updated"] }, USERS.admin, "webhooks");
    await save(page, "Three\n");
    await save(hidden, "Two\n");
    await h.call(USERS.commenter, "POST", `documents/${page}/threads`, {
      anchor: { kind: "document" },
      body: "A comment"
    });
    const counted = async (id: string) =>
      (await h.call(USERS.admin, "GET", `webhooks/${id}/deliveries`)).data.length as number;
    expect(await counted(everything)).toBe(2);
    expect(await counted(wholeSite)).toBe(1);
    const { rows } = await h.pool.query(
      `SELECT w.name, d.payload->'page'->>'title' AS title FROM pandocs.webhook_deliveries d JOIN pandocs.webhooks w ON w.id = d.webhook_id ORDER BY 1, 2`
    );
    expect(rows).toEqual([
      { name: "Hidden too", title: "Returns" },
      { name: "Hidden too", title: "Secret prices" },
      { name: "Saves only", title: "Returns" },
      { name: "Whole site", title: "Returns" }
    ]);
  });

  it("announces nothing for a change that did not happen", async () => {
    await hookOf({});
    expect(
      (await h.write(USERS.admin, "PUT", `documents/${page}/content`, { markdown: "Never\n", expectedRevision: 1 }))
        .status
    ).toBe(409);
    await drain();
    expect(sent).toEqual([]);
  });

  it("gathers what a chat would get a lot of into fewer messages, and sends a program everything on its own", async () => {
    await hookOf({ kind: "slack", events: ["page.updated"] });
    await hookOf({ name: "Program", kind: "generic", events: ["page.updated"] });
    for (const text of ["Four\n", "Five\n", "Six\n"]) await save(page, text);
    await drain();
    const toChat = sent.filter(item => item.target.kind === "slack");
    expect(toChat).toHaveLength(1);
    expect(toChat[0]!.message.events.map(event => event.revision)).toEqual(
      expect.arrayContaining([expect.any(Number), expect.any(Number), expect.any(Number)])
    );
    expect(toChat[0]!.message.events).toHaveLength(3);
    expect(sent.filter(item => item.target.kind === "generic")).toHaveLength(3);
  });

  it("lets a chat's messages wait for more, so a burst is not sent as it starts", async () => {
    await hookOf({ kind: "feishu", events: ["page.updated"] });
    await save(page, "Seven\n");
    expect(await h.services.webhooks.tick()).toBe(false);
    expect(sent).toEqual([]);
  });

  it("tries again later, with longer and longer waits, and then gives up", async () => {
    const { id } = await hookOf({ events: ["page.updated"] });
    await save(page, "Eight\n");
    answer = { ok: false, status: 500, error: "The other side answered 500" };
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await drain();
      const { rows } = await h.pool.query(
        `SELECT status, attempts, extract(epoch FROM next_attempt_at - now())::int AS wait FROM pandocs.webhook_deliveries WHERE webhook_id = $1`,
        [id]
      );
      expect(rows[0].attempts).toBe(attempt);
      if (attempt < 6) delays.push(rows[0].wait as number);
      expect(rows[0].status).toBe(attempt === 6 ? "failed" : "pending");
    }
    expect(delays.every((wait, at) => at === 0 || wait > delays[at - 1]!)).toBe(true);
    expect(delays[0]).toBeGreaterThanOrEqual(55);
    const { data: log } = await h.call(USERS.admin, "GET", `webhooks/${id}/deliveries`);
    expect(log[0]).toMatchObject({
      status: "failed",
      attempts: 6,
      responseStatus: 500,
      error: "The other side answered 500"
    });
    expect((await h.call(USERS.admin, "GET", "spaces/shop/webhooks")).data[0]).toMatchObject({
      lastStatus: "failed",
      consecutiveFailures: 6
    });

    answer = { ok: true, status: 200, error: null };
    sent.length = 0;
    expect((await h.call(USERS.admin, "POST", `webhooks/${id}/deliveries/${log[0].id}/retry`)).data.status).toBe(
      "pending"
    );
    await drain();
    expect(events()).toEqual(["page.updated"]);
    expect((await h.call(USERS.admin, "GET", "spaces/shop/webhooks")).data[0]).toMatchObject({
      lastStatus: "delivered",
      consecutiveFailures: 0
    });
    expect((await h.call(USERS.admin, "POST", `webhooks/${id}/deliveries/${log[0].id}/retry`)).status).toBe(404);
  });

  it("does not send a thing twice when two workers go at once", async () => {
    await hookOf({ events: ["page.updated"] });
    for (const text of ["Nine\n", "Ten\n", "Eleven\n"]) await save(page, text);
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (await h.services.webhooks.tick()) {
          /* until none are due */
        }
      })
    );
    expect(new Set(sent.map(item => item.message.id)).size).toBe(sent.length);
    expect(sent).toHaveLength(3);
  });

  it("brings back what a worker that died was sending", async () => {
    const { id } = await hookOf({ events: ["page.updated"] });
    await save(page, "Twelve\n");
    await h.pool.query(
      `UPDATE pandocs.webhook_deliveries SET attempts = 1, next_attempt_at = now() - interval '1 second' WHERE webhook_id = $1`,
      [id]
    );
    await h.services.webhooks.tick();
    expect(events()).toEqual(["page.updated"]);
    const { rows } = await h.pool.query(
      `SELECT attempts, status FROM pandocs.webhook_deliveries WHERE webhook_id = $1`,
      [id]
    );
    expect(rows[0]).toEqual({ attempts: 2, status: "delivered" });
  });

  it("turns itself off after failing for a long time, until someone turns it back on", async () => {
    const { id } = await hookOf({ events: ["page.updated"] });
    await h.pool.query(`UPDATE pandocs.webhooks SET consecutive_failures = 49 WHERE id = $1`, [id]);
    await save(page, "Thirteen\n");
    answer = { ok: false, status: null, error: "No answer in time" };
    await drain();
    expect((await h.call(USERS.admin, "GET", "spaces/shop/webhooks")).data[0]).toMatchObject({
      enabled: false,
      consecutiveFailures: 50
    });
    await save(page, "Fourteen\n");
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS waiting FROM pandocs.webhook_deliveries WHERE webhook_id = $1`,
      [id]
    );
    expect(rows[0].waiting).toBe(1);
    sent.length = 0;
    await drain();
    expect(sent).toEqual([]);
    expect((await h.call(USERS.admin, "PATCH", `webhooks/${id}`, { enabled: true })).data).toMatchObject({
      enabled: true,
      consecutiveFailures: 0
    });
  });

  it("keeps the address and secret when they are left out of a change, and tests with what is stored", async () => {
    const { id } = await hookOf({ kind: "feishu", secret: "keep-me" });
    expect((await h.call(USERS.admin, "PATCH", `webhooks/${id}`, { name: "Renamed" })).data).toMatchObject({
      name: "Renamed",
      hasSecret: true
    });
    const { data: tested } = await h.call(USERS.admin, "POST", `webhooks/${id}/test`);
    expect(tested).toEqual({ ok: true, status: 200, error: null });
    expect(sent[0]!.target).toEqual({
      kind: "feishu",
      url: "https://hooks.example.com/in/secret-token",
      secret: "keep-me"
    });
    expect(sent[0]!.message.events[0]!.event).toBe("ping");
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS kept FROM pandocs.webhook_deliveries WHERE webhook_id = $1`,
      [id]
    );
    expect(rows[0].kept).toBe(0);
  });

  it("forgets what it has finished with after a while, but never what is still to be sent", async () => {
    const { id } = await hookOf({ events: ["page.updated"] });
    await save(page, "Fifteen\n");
    await drain();
    await save(page, "Sixteen\n");
    await h.pool.query(
      `UPDATE pandocs.webhook_deliveries SET created_at = now() - interval '40 days' WHERE webhook_id = $1`,
      [id]
    );
    await h.services.webhooks.sweep();
    const { rows } = await h.pool.query(`SELECT status FROM pandocs.webhook_deliveries WHERE webhook_id = $1`, [id]);
    expect(rows).toEqual([{ status: "pending" }]);
  });
});
