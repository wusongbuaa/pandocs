import type { Principal } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";

export const WEBHOOK_EVENTS = [
  "page.created",
  "page.updated",
  "page.moved",
  "page.deleted",
  "page.restored",
  "comment.created",
  "thread.resolved",
  "proposal.created",
  "proposal.decided",
  "feedback.created",
  "change_set.created",
  "change_set.reviewed",
  "change_set.merged",
  "change_set.closed"
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** What a hook receives about something that happened. The server adds addresses when it sends it, since it knows where the site is. */
export interface WebhookEvent {
  readonly event: WebhookEventName | "ping";
  readonly occurredAt: string;
  readonly space?: { readonly slug: string; readonly name: string };
  readonly page?: { readonly id: string; readonly title: string; readonly path: string; readonly restricted: boolean };
  /** Empty for someone with no login. */
  readonly actor?: { readonly name: string; readonly kind: string };
  readonly revision?: number;
  /** What was said when saving. */
  readonly message?: string;
  /** Where a moved page was. */
  readonly from?: string;
  readonly thread?: { readonly id: string; readonly comment?: string };
  readonly proposal?: { readonly id: string; readonly status: string; readonly rationale: string };
  readonly feedback?: { readonly kind: string; readonly body: string; readonly quote: string };
  readonly changeSet?: {
    readonly id: string;
    readonly title: string;
    readonly verdict?: string;
    readonly pages?: number;
  };
}

const QUOTED_CHARS = 500;
/** How long a chat waits for more to happen, so a burst of changes is one message and not a wall of them. */
const GATHER_SECONDS = 10;

type Detail = Partial<WebhookEvent>;

/** One statement, so that a site with no hooks pays for little more than looking at an empty table. */
async function enqueue(
  tx: Queryable,
  principal: Principal,
  event: WebhookEventName,
  documentId: string,
  detail: Detail
): Promise<void> {
  const payload = {
    ...detail,
    event,
    occurredAt: new Date().toISOString(),
    actor: { name: principal.anonymous ? "" : principal.displayName, kind: principal.kind }
  };
  await tx.query(
    `INSERT INTO pandocs.webhook_deliveries (webhook_id, event, payload, next_attempt_at)
     SELECT w.id, $1, $2::jsonb || jsonb_build_object(
         'space', jsonb_build_object('slug', s.slug, 'name', s.name),
         'page', jsonb_build_object('id', d.id, 'title', d.title, 'path', d.path, 'restricted', d.restricted)),
       now() + CASE WHEN w.kind = 'generic' THEN interval '0 seconds' ELSE make_interval(secs => $4) END
     FROM pandocs.webhooks w
     JOIN pandocs.documents d ON d.id = $3
     JOIN pandocs.spaces s ON s.id = d.space_id
     WHERE w.enabled AND $1 = ANY(w.events) AND (w.space_id IS NULL OR w.space_id = d.space_id) AND (w.include_restricted OR NOT d.restricted)`,
    [event, JSON.stringify(payload), documentId, GATHER_SECONDS]
  );
}

const CHANGE_SET_EVENTS: Readonly<Record<string, WebhookEventName>> = {
  "space.change_set.create": "change_set.created",
  "space.change_set.review": "change_set.reviewed",
  "space.change_set.merge": "change_set.merged",
  "space.change_set.close": "change_set.closed"
};

/** About a space rather than one page in it. */
async function enqueueForSpace(
  tx: Queryable,
  principal: Principal,
  event: WebhookEventName,
  spaceId: string,
  detail: Detail
): Promise<void> {
  const payload = {
    ...detail,
    event,
    occurredAt: new Date().toISOString(),
    actor: { name: principal.displayName, kind: principal.kind }
  };
  await tx.query(
    `INSERT INTO pandocs.webhook_deliveries (webhook_id, event, payload, next_attempt_at)
     SELECT w.id, $1, $2::jsonb || jsonb_build_object('space', jsonb_build_object('slug', s.slug, 'name', s.name)),
       now() + CASE WHEN w.kind = 'generic' THEN interval '0 seconds' ELSE make_interval(secs => $4) END
     FROM pandocs.webhooks w JOIN pandocs.spaces s ON s.id = $3
     WHERE w.enabled AND $1 = ANY(w.events) AND (w.space_id IS NULL OR w.space_id = s.id)`,
    [event, JSON.stringify(payload), spaceId, GATHER_SECONDS]
  );
}

const PAGE_EVENTS: Readonly<Record<string, WebhookEventName>> = {
  "document.move": "page.moved",
  "document.delete": "page.deleted",
  "document.restore": "page.restored"
};

/**
 * Everything worth telling another system about is written to the audit log, in the same transaction as the change.
 * So is this: what rolls back was never announced, and nothing that happened can go unannounced.
 */
export async function announce(
  tx: Queryable,
  principal: Principal,
  action: string,
  targetId: string,
  detail: object
): Promise<void> {
  if (action === "document.commit") {
    const { revision } = detail as { revision: number };
    const { rows } = await tx.query<{ message: string }>(
      `SELECT message FROM pandocs.revisions WHERE document_id = $1 AND no = $2`,
      [targetId, revision]
    );
    await enqueue(tx, principal, revision === 1 ? "page.created" : "page.updated", targetId, {
      revision,
      message: (rows[0]?.message ?? "").slice(0, QUOTED_CHARS)
    });
    return;
  }
  const changeSetEvent = CHANGE_SET_EVENTS[action];
  if (changeSetEvent) {
    const { changeSet, title, verdict, pages } = detail as {
      changeSet: string;
      title: string;
      verdict?: string;
      pages?: number;
    };
    await enqueueForSpace(tx, principal, changeSetEvent, targetId, {
      changeSet: { id: changeSet, title, ...(verdict ? { verdict } : {}), ...(pages === undefined ? {} : { pages }) }
    });
    return;
  }
  const pageEvent = PAGE_EVENTS[action];
  if (pageEvent) {
    await enqueue(
      tx,
      principal,
      pageEvent,
      targetId,
      action === "document.move" ? { from: (detail as { from: string }).from } : {}
    );
    return;
  }
  if (action === "thread.create" || action === "thread.reply" || action === "thread.resolve") {
    const { rows } = await tx.query<{ document_id: string; body: string | null }>(
      `SELECT t.document_id, (SELECT c.body FROM pandocs.comments c WHERE c.thread_id = t.id AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS body FROM pandocs.threads t WHERE t.id = $1`,
      [targetId]
    );
    if (!rows[0]) return;
    await enqueue(
      tx,
      principal,
      action === "thread.resolve" ? "thread.resolved" : "comment.created",
      rows[0].document_id,
      {
        thread: {
          id: targetId,
          ...(action === "thread.resolve" ? {} : { comment: (rows[0].body ?? "").slice(0, QUOTED_CHARS) })
        }
      }
    );
    return;
  }
  if (action === "proposal.create" || action === "proposal.accept" || action === "proposal.reject") {
    const { rows } = await tx.query<{ document_id: string; status: string; rationale: string }>(
      `SELECT document_id, status, rationale FROM pandocs.proposals WHERE id = $1`,
      [targetId]
    );
    if (!rows[0]) return;
    await enqueue(
      tx,
      principal,
      action === "proposal.create" ? "proposal.created" : "proposal.decided",
      rows[0].document_id,
      {
        proposal: { id: targetId, status: rows[0].status, rationale: rows[0].rationale.slice(0, QUOTED_CHARS) }
      }
    );
  }
}

/** Votes and reports are not in the audit log: most of them are from people with no login, and they change nothing. */
export const announceFeedback = (
  tx: Queryable,
  principal: Principal,
  documentId: string,
  feedback: { kind: string; body: string; quote: string }
) =>
  enqueue(tx, principal, "feedback.created", documentId, {
    feedback: {
      kind: feedback.kind,
      body: feedback.body.slice(0, QUOTED_CHARS),
      quote: feedback.quote.slice(0, QUOTED_CHARS)
    }
  });
