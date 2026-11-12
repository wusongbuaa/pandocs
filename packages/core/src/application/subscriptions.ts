import { t } from "@pandocs/i18n";
import { forbidden } from "../domain/errors.js";
import type { DocumentRecord, Principal } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import { requireDocument, requireSpace, type AppContext } from "./context.js";

const SUMMARY_CHARS = 140;
const MAIL_QUIET_SECONDS = 60;
const MAILS_AT_A_TIME = 500;

/**
 * Tells those following a page or its space that it changed, in the same transaction as the change. Someone who has not
 * read the last one gets that one brought up to date rather than another, so a run of saves is one notice, and one mail.
 */
export async function tellFollowers(
  tx: Queryable,
  principal: Principal,
  document: Pick<DocumentRecord, "id" | "spaceId">,
  message: string
): Promise<void> {
  const params = [document.id, document.spaceId, principal.id, principal.displayName, message.slice(0, SUMMARY_CHARS)];
  await tx.query(
    `UPDATE pandocs.notifications n SET actor_name = $4, summary = $5, created_at = now()
     FROM (SELECT DISTINCT user_id FROM pandocs.subscriptions WHERE (document_id = $1 OR space_id = $2) AND user_id <> $3) f
     WHERE n.recipient_id = f.user_id AND n.document_id = $1 AND n.kind = 'page_updated' AND n.read_at IS NULL`,
    params
  );
  await tx.query(
    `INSERT INTO pandocs.notifications (recipient_id, kind, document_id, actor_name, summary, mail_due)
     SELECT DISTINCT f.user_id, 'page_updated', $1::uuid, $4, $5, true FROM pandocs.subscriptions f
     WHERE (f.document_id = $1 OR f.space_id = $2) AND f.user_id <> $3
       AND NOT EXISTS (SELECT 1 FROM pandocs.notifications n WHERE n.recipient_id = f.user_id AND n.document_id = $1 AND n.kind = 'page_updated' AND n.read_at IS NULL)`,
    params
  );
}

/** Following is for people with an account: there is nowhere to tell anyone else. */
function requirePerson(principal: Principal): void {
  if (principal.kind !== "user" || principal.anonymous || principal.guest)
    throw forbidden(t("Following needs a person's account"));
}

export class SubscriptionService {
  constructor(private readonly context: AppContext) {}

  async ofDocument(
    principal: Principal,
    documentId: string
  ): Promise<{ readonly document: boolean; readonly space: boolean }> {
    const { db } = this.context;
    const { document } = await requireDocument(db, principal, documentId);
    const { rows } = await db.query<{ document_id: string | null }>(
      `SELECT document_id FROM pandocs.subscriptions WHERE user_id = $1 AND (document_id = $2 OR space_id = $3)`,
      [principal.id, documentId, document.spaceId]
    );
    return { document: rows.some(row => row.document_id !== null), space: rows.some(row => row.document_id === null) };
  }

  async followDocument(principal: Principal, documentId: string, following: boolean): Promise<void> {
    requirePerson(principal);
    const { db } = this.context;
    await requireDocument(db, principal, documentId);
    if (following)
      await db.query(
        `INSERT INTO pandocs.subscriptions (user_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [principal.id, documentId]
      );
    else
      await db.query(`DELETE FROM pandocs.subscriptions WHERE user_id = $1 AND document_id = $2`, [
        principal.id,
        documentId
      ]);
  }

  async followSpace(principal: Principal, spaceSlug: string, following: boolean): Promise<void> {
    requirePerson(principal);
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug);
    if (following)
      await db.query(`INSERT INTO pandocs.subscriptions (user_id, space_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        principal.id,
        space.id
      ]);
    else
      await db.query(`DELETE FROM pandocs.subscriptions WHERE user_id = $1 AND space_id = $2`, [
        principal.id,
        space.id
      ]);
  }

  async list(principal: Principal) {
    const { db } = this.context;
    const { rows } = await db.query(
      `SELECT sub.created_at, d.id AS document_id, d.title, d.path, d.deleted_at, COALESCE(ds.slug, ss.slug) AS space_slug, COALESCE(ds.name, ss.name) AS space_name
       FROM pandocs.subscriptions sub
       LEFT JOIN pandocs.documents d ON d.id = sub.document_id
       LEFT JOIN pandocs.spaces ds ON ds.id = d.space_id
       LEFT JOIN pandocs.spaces ss ON ss.id = sub.space_id
       WHERE sub.user_id = $1 ORDER BY sub.created_at DESC`,
      [principal.id]
    );
    const items = [];
    for (const row of rows) {
      const documentId = row.document_id ? String(row.document_id) : null;
      // Someone who has since lost access keeps the subscription, which says nothing until they get it back.
      const readable = documentId
        ? row.deleted_at === null &&
          (await requireDocument(db, principal, documentId).then(
            () => true,
            () => false
          ))
        : await requireSpace(db, principal, String(row.space_slug)).then(
            () => true,
            () => false
          );
      if (!readable) continue;
      items.push({
        kind: documentId ? ("document" as const) : ("space" as const),
        documentId,
        title: documentId ? String(row.title) : null,
        path: documentId ? String(row.path) : null,
        spaceSlug: String(row.space_slug),
        spaceName: String(row.space_name),
        createdAt: new Date(row.created_at as string).toISOString()
      });
    }
    return items;
  }

  /**
   * Mail goes out from the background, so that a change that rolled back sends none, and once a page has been left alone
   * for a while. Everything due for one person is one message: an import of a thousand pages must not be a thousand mails.
   * Returns how many notices it took on, for a caller to tell whether there may be more.
   */
  async sendDueMail(quietSeconds = MAIL_QUIET_SECONDS): Promise<number> {
    const {
      db,
      ports: { notifier, directory }
    } = this.context;
    if (!notifier || !directory?.principal) {
      await db.query(`UPDATE pandocs.notifications SET mail_due = false WHERE mail_due`);
      return 0;
    }
    const { rows } = await db.query<{ recipient_id: string; document_id: string; actor_name: string; summary: string }>(
      `UPDATE pandocs.notifications n SET mail_due = false
       FROM (SELECT id FROM pandocs.notifications WHERE mail_due AND created_at <= now() - make_interval(secs => $1)
             ORDER BY recipient_id, created_at LIMIT $2 FOR UPDATE SKIP LOCKED) due
       WHERE n.id = due.id RETURNING n.recipient_id, n.document_id, n.actor_name, n.summary`,
      [quietSeconds, MAILS_AT_A_TIME]
    );
    const byPerson = new Map<string, typeof rows>();
    for (const row of rows) byPerson.set(row.recipient_id, [...(byPerson.get(row.recipient_id) ?? []), row]);
    for (const [recipientId, notices] of byPerson) {
      const reader = await directory.principal(recipientId);
      if (!reader) continue;
      const pages = [];
      for (const notice of notices) {
        // Someone can lose access, or the page can go, between the change and the mail.
        const found = await requireDocument(db, reader, notice.document_id).catch(() => null);
        if (found)
          pages.push({
            documentId: found.document.id,
            documentTitle: found.document.title,
            location: `${found.space.slug}/${found.document.path}`,
            actorName: notice.actor_name,
            summary: notice.summary
          });
      }
      const [first, ...more] = pages;
      if (!first) continue;
      // It is in the app whatever happens to the mail, and one address that fails should not hold up the others.
      await notifier.notify({ kind: "page_updated", recipientId, ...first, alsoUpdated: more }).catch(() => undefined);
    }
    return rows.length;
  }
}
