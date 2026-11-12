import { t } from "@pandocs/i18n";
import { z } from "zod";
import { forbidden, invalid, notFound } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import { requireDocument, requireSpace, UUID, type AppContext } from "./context.js";
import type { DocumentService } from "./documents.js";
import type { SpaceService } from "./spaces.js";
import { audienceOf, type Audience } from "./stats.js";
import { announceFeedback } from "./webhook-events.js";

const MAX_LISTED = 200;
const SUMMARY_CHARS = 200;

export const feedbackInput = z.object({
  kind: z.enum(["helpful", "unhelpful", "report"]),
  body: z.string().trim().max(2000).optional(),
  quote: z.string().trim().max(500).optional()
}).strict();

export const feedbackBody = z.object({ body: z.string().trim().min(1).max(2000) }).strict();

type FeedbackInput = z.output<typeof feedbackInput>;

/** What readers and agents say about pages. Saying something only takes being able to read the page; what is said goes to those who can change it. */
export class FeedbackService {
  constructor(private readonly context: AppContext, private readonly documents: DocumentService, private readonly spaces: SpaceService) {}

  async leave(principal: Principal, documentId: string, input: FeedbackInput, audience: Audience = audienceOf(principal)): Promise<{ id: string }> {
    const { db } = this.context;
    const { document } = await requireDocument(db, principal, documentId);
    const body = input.body ?? "";
    if (input.kind === "report" && !body) throw invalid("FEEDBACK_EMPTY", t("Say what is wrong"));
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO pandocs.page_feedback (document_id, revision_no, kind, audience, reporter, body, quote) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [documentId, document.currentRevisionNo, input.kind, audience, principal.anonymous ? null : principal.displayName, body, input.quote ?? ""]
    );
    if (body && input.kind !== "helpful") {
      await this.tellAuthor(principal, documentId, body);
      await announceFeedback(db, principal, documentId, { kind: input.kind, body, quote: input.quote ?? "" });
    }
    return { id: rows[0]!.id };
  }

  /** Words to go with a vote already given. The id is known only to whoever gave it, and there is nothing to overwrite. */
  async explain(principal: Principal, documentId: string, feedbackId: string, body: string): Promise<void> {
    const { db } = this.context;
    await requireDocument(db, principal, documentId);
    if (!UUID.test(feedbackId)) throw notFound(t("Feedback"));
    const { rows } = await db.query<{ kind: string }>(
      `UPDATE pandocs.page_feedback SET body = $3 WHERE id = $1 AND document_id = $2 AND body = '' RETURNING kind`,
      [feedbackId, documentId, body]
    );
    if (!rows[0]) throw notFound(t("Feedback"));
    if (rows[0].kind !== "helpful") {
      await this.tellAuthor(principal, documentId, body);
      await announceFeedback(db, principal, documentId, { kind: rows[0].kind, body, quote: "" });
    }
  }

  /** Whoever saved this version is the likeliest to know, and it belongs in front of someone rather than only on a list. */
  private async tellAuthor(principal: Principal, documentId: string, body: string): Promise<void> {
    const { db } = this.context;
    const { rows } = await db.query<{ actor_id: string; actor_kind: string; on_behalf_of: string | null }>(
      `SELECT r.actor_id, r.actor_kind, r.on_behalf_of FROM pandocs.revisions r JOIN pandocs.documents d ON d.id = r.document_id AND d.current_revision_no = r.no WHERE d.id = $1`,
      [documentId]
    );
    const recipient = rows[0] && (rows[0].actor_kind === "user" ? rows[0].actor_id : rows[0].on_behalf_of);
    if (!recipient || recipient === principal.id) return;
    await db.query(
      `INSERT INTO pandocs.notifications (recipient_id, kind, document_id, actor_name, summary) VALUES ($1, 'feedback', $2, $3, $4)`,
      // Whoever reads this may read another language than whoever wrote it, so no name is left for the app to word.
      [recipient, documentId, principal.anonymous ? "" : principal.displayName, body.slice(0, SUMMARY_CHARS)]
    );
  }

  /** What has words to it: a vote alone only counts. For the whole site or one space, and only pages this person can read. */
  async list(principal: Principal, input: { readonly space?: string | undefined; readonly status: "open" | "resolved" | "all"; readonly limit?: number | undefined }) {
    const { db } = this.context;
    const { space, status } = input;
    if (space) await requireSpace(db, principal, space, "editor");
    else if (!principal.isAdmin) throw forbidden();
    const slugs = space ? [space] : (await this.spaces.list(principal)).map(item => item.slug);
    const pages = new Map<string, { space: string; path: string; title: string }>();
    for (const slug of slugs) for (const node of await this.documents.tree(principal, slug)) pages.set(node.id, { space: slug, path: node.path, title: node.title });
    const { rows } = await db.query(
      `SELECT * FROM pandocs.page_feedback WHERE document_id = ANY($1::uuid[]) AND (kind = 'report' OR body <> '')
         AND ($2::text = 'all' OR ($2 = 'open' AND resolved_at IS NULL) OR ($2 = 'resolved' AND resolved_at IS NOT NULL))
       ORDER BY created_at DESC LIMIT $3`,
      [[...pages.keys()], status, Math.min(input.limit ?? 100, MAX_LISTED)]
    );
    return rows.map(row => ({
      id: String(row.id),
      documentId: String(row.document_id),
      ...pages.get(String(row.document_id))!,
      revision: Number(row.revision_no),
      kind: String(row.kind),
      audience: String(row.audience),
      reporter: row.reporter === null ? null : String(row.reporter),
      body: String(row.body),
      quote: String(row.quote),
      createdAt: new Date(row.created_at as string).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at as string).toISOString() : null,
      resolvedBy: row.resolved_by === null ? null : String(row.resolved_by)
    }));
  }

  async resolve(principal: Principal, id: string, resolved: boolean): Promise<void> {
    const { db } = this.context;
    if (!UUID.test(id)) throw notFound(t("Feedback"));
    const { rows } = await db.query<{ document_id: string }>(`SELECT document_id FROM pandocs.page_feedback WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound(t("Feedback"));
    await requireDocument(db, principal, rows[0].document_id, "editor");
    await db.query(
      `UPDATE pandocs.page_feedback SET resolved_at = CASE WHEN $2 THEN now() END, resolved_by = CASE WHEN $2 THEN $3 END WHERE id = $1`,
      [id, resolved, principal.displayName]
    );
  }
}
