import { t } from "@pandocs/i18n";
import {
  anchorFromBlock,
  anchorFromQuote,
  anchorFromRange,
  AnchorError,
  outlineOf,
  parseDocument,
  relocateBlockAnchor,
  relocateTextAnchor,
  squashWhitespace,
  topLevelBlocks,
  visibleText,
  type Anchor,
  type AnchorableBlock,
  type AnchorState,
  type DocumentAnalysis,
  type ParsedDocument,
  type SourceBlock
} from "@pandocs/markdown";
import { atLeast } from "../domain/access.js";
import { PandocsError, forbidden, invalid, notFound } from "../domain/errors.js";
import type { CommentReaction, CommentRecord, Mention, Principal, ThreadRecord } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import { audit, requireDocument, type AppContext } from "./context.js";
import { loadRevision } from "./revisions.js";

export type AnchorInput =
  | { readonly kind: "text"; readonly start: number; readonly end: number; readonly exact?: string | undefined; readonly revision?: number | undefined }
  | { readonly kind: "quote"; readonly quote: string; readonly occurrence?: number | undefined; readonly revision?: number | undefined }
  | { readonly kind: "section"; readonly section: string }
  | { readonly kind: "block"; readonly ref: string; readonly revision?: number | undefined }
  | { readonly kind: "document" };

export interface ThreadView extends ThreadRecord {
  readonly comments: readonly CommentRecord[];
}

const THREAD_SUMMARY_LIMIT = 12_000;

/** How many notices the inbox reads at a time, and how far back it goes looking for ones the person can read. */
const INBOX_PAGE = 100;
const INBOX_SCAN = 2000;

function anchorableBlocks(markdown: string, blocks: readonly SourceBlock[]): AnchorableBlock[] {
  return blocks.map(block => ({ ...block, markdown: markdown.slice(block.start, block.end) }));
}

function relocate(anchor: Anchor, squashed: string, blocks: readonly AnchorableBlock[]): { state: AnchorState; anchor: Anchor } {
  if (anchor.kind === "text") return relocateTextAnchor(anchor, squashed);
  if (anchor.kind === "block") return relocateBlockAnchor(anchor, blocks);
  return { state: "exact", anchor };
}

/** Runs inside the commit transaction, so a new version never exists with stale anchors. */
export async function relocateOpenThreads(tx: Queryable, documentId: string, revisionNo: number, markdown: string, analysis: DocumentAnalysis): Promise<void> {
  const { rows } = await tx.query<{ id: string; anchor: Anchor; anchor_state: AnchorState }>(
    `SELECT id, anchor, anchor_state FROM pandocs.threads WHERE document_id = $1 AND status = 'open' AND anchor->>'kind' <> 'document'`,
    [documentId]
  );
  if (rows.length === 0) return;
  const squashed = squashWhitespace(analysis.visibleText);
  const blocks = anchorableBlocks(markdown, analysis.blocks);
  for (const row of rows) {
    const moved = relocate(row.anchor, squashed, blocks);
    await tx.query(
      `UPDATE pandocs.threads SET anchor = $2, anchor_state = $3, anchored_revision_no = $4, updated_at = now() WHERE id = $1`,
      [row.id, JSON.stringify(moved.anchor), moved.state, revisionNo]
    );
  }
}

function mapThread(row: Record<string, unknown>): ThreadRecord {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    anchor: row.anchor as Anchor,
    anchorState: row.anchor_state as AnchorState,
    anchoredRevisionNo: Number(row.anchored_revision_no),
    status: row.status as ThreadRecord["status"],
    summary: row.summary ? String(row.summary) : null,
    summaryAt: row.summary_at ? new Date(row.summary_at as string) : null,
    createdBy: String(row.created_by),
    createdName: String(row.created_name),
    createdKind: row.created_kind as ThreadRecord["createdKind"],
    resolvedName: row.resolved_name ? String(row.resolved_name) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string)
  };
}

function mapComment(row: Record<string, unknown>): CommentRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    authorKind: row.author_kind as CommentRecord["authorKind"],
    channel: String(row.channel),
    body: String(row.body),
    mentions: row.mentions as Mention[],
    createdAt: new Date(row.created_at as string),
    editedAt: row.edited_at ? new Date(row.edited_at as string) : null
  };
}

export class ThreadService {
  constructor(private readonly context: AppContext) {}

  private async resolveAnchor(tx: Queryable, documentId: string, currentNo: number, input: AnchorInput): Promise<{ anchor: Anchor; state: AnchorState }> {
    if (input.kind === "document") return { anchor: { kind: "document" }, state: "exact" };
    const { registry } = this.context;
    const baseNo = "revision" in input && input.revision ? input.revision : currentNo;
    const base = parseDocument((await loadRevision(tx, documentId, baseNo)).markdown, registry);
    const baseSquashed = squashWhitespace(visibleText(base, registry));
    const blocks = anchorableBlocks(base.markdown, topLevelBlocks(base));
    let anchor: Anchor;
    try {
      if (input.kind === "text") anchor = anchorFromRange(baseSquashed, input.start, input.end, input.exact);
      else if (input.kind === "quote") anchor = anchorFromQuote(baseSquashed, input.quote, input.occurrence);
      else {
        const ref = input.kind === "section" ? sectionRef(base, input.section) : input.ref;
        const block = blocks.find(item => item.ref === ref);
        if (!block) throw new AnchorError("ANCHOR_NOT_FOUND", t("Block {0} not found", ref));
        anchor = anchorFromBlock(block);
      }
    } catch (error) {
      if (error instanceof AnchorError) throw invalid(error.code, error.message);
      throw error;
    }
    if (baseNo === currentNo) return { anchor, state: "exact" };
    // The reader was looking at an older version; carry the anchor forward like any other edit would.
    const current = parseDocument((await loadRevision(tx, documentId, currentNo)).markdown, registry);
    return relocate(anchor, squashWhitespace(visibleText(current, registry)), anchorableBlocks(current.markdown, topLevelBlocks(current)));
  }

  async list(principal: Principal, documentId: string, status?: "open" | "resolved" | undefined): Promise<ThreadView[]> {
    const { db } = this.context;
    await requireDocument(db, principal, documentId);
    const { rows } = await db.query(
      `SELECT * FROM pandocs.threads WHERE document_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at`,
      [documentId, status ?? null]
    );
    const threads = rows.map(mapThread);
    if (threads.length === 0) return [];
    const { rows: commentRows } = await db.query(
      `SELECT * FROM pandocs.comments WHERE thread_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at`,
      [threads.map(thread => thread.id)]
    );
    const byThread = new Map<string, CommentRecord[]>();
    for (const comment of await this.withReactions(db, principal, commentRows.map(mapComment))) {
      byThread.set(comment.threadId, [...(byThread.get(comment.threadId) ?? []), comment]);
    }
    // A discussion every comment of which was taken back has nothing left to read or answer, nor anything to highlight.
    return threads.filter(thread => byThread.has(thread.id)).map(thread => ({ ...thread, comments: byThread.get(thread.id)! }));
  }

  /** Someone mentioned is who the directory says the id is, under the name it gives; an id it does not know is no one. */
  private async knownMentions(mentions: readonly Mention[]): Promise<Mention[]> {
    const names = this.context.ports.directory?.names;
    if (mentions.length === 0 || !names) return [...mentions];
    const known = new Map((await names(mentions.map(mention => mention.id))).map(person => [person.id, person.name]));
    return mentions.filter(mention => known.has(mention.id)).map(mention => ({ id: mention.id, name: known.get(mention.id)! }));
  }

  private async loadThread(db: Queryable, threadId: string, lock = false): Promise<ThreadRecord> {
    const { rows } = await db.query(`SELECT * FROM pandocs.threads WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [threadId]);
    if (!rows[0]) throw notFound(t("Discussion"));
    return mapThread(rows[0]);
  }

  async get(principal: Principal, threadId: string): Promise<ThreadView> {
    const { db } = this.context;
    const thread = await this.loadThread(db, threadId);
    await requireDocument(db, principal, thread.documentId);
    const { rows } = await db.query(`SELECT * FROM pandocs.comments WHERE thread_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [threadId]);
    return { ...thread, comments: await this.withReactions(db, principal, rows.map(mapComment)) };
  }

  private async withReactions(db: Queryable, principal: Principal, comments: readonly CommentRecord[]): Promise<CommentRecord[]> {
    if (comments.length === 0) return [];
    const { rows } = await db.query<{ comment_id: string; emoji: string; count: string; mine: boolean }>(
      `SELECT comment_id, emoji, count(*) AS count, bool_or(user_id = $2) AS mine FROM pandocs.comment_reactions
       WHERE comment_id = ANY($1::uuid[]) GROUP BY comment_id, emoji ORDER BY min(created_at)`,
      [comments.map(comment => comment.id), principal.id]
    );
    const byComment = new Map<string, CommentReaction[]>();
    for (const row of rows) {
      byComment.set(row.comment_id, [...(byComment.get(row.comment_id) ?? []), { emoji: row.emoji, count: Number(row.count), mine: row.mine }]);
    }
    return comments.map(comment => ({ ...comment, reactions: byComment.get(comment.id) ?? [] }));
  }

  async create(principal: Principal, documentId: string, input: { anchor: AnchorInput; body: string; mentions?: readonly Mention[] | undefined }): Promise<ThreadView> {
    const created = await this.context.db.transaction(async tx => {
      const { document } = await requireDocument(tx, principal, documentId, "commenter");
      const { anchor, state } = await this.resolveAnchor(tx, documentId, document.currentRevisionNo, input.anchor);
      const { rows } = await tx.query(
        `INSERT INTO pandocs.threads (document_id, anchor, anchor_state, anchored_revision_no, created_by, created_name, created_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [documentId, JSON.stringify(anchor), state, document.currentRevisionNo, principal.id, principal.displayName, principal.kind]
      );
      const thread = mapThread(rows[0]!);
      const comment = await this.insertComment(tx, principal, thread, input.body, input.mentions ?? []);
      await audit(tx, principal, "thread.create", "thread", thread.id, { documentId, kind: anchor.kind });
      return { thread, comment };
    });
    await this.pushMentions(principal, created.thread, created.comment);
    return { ...created.thread, comments: [created.comment] };
  }

  async reply(principal: Principal, threadId: string, input: { body: string; mentions?: readonly Mention[] | undefined }): Promise<CommentRecord> {
    const result = await this.context.db.transaction(async tx => {
      const thread = await this.loadThread(tx, threadId, true);
      await requireDocument(tx, principal, thread.documentId, "commenter");
      const comment = await this.insertComment(tx, principal, thread, input.body, input.mentions ?? []);
      await tx.query(`UPDATE pandocs.threads SET updated_at = now() WHERE id = $1`, [threadId]);
      await audit(tx, principal, "thread.reply", "thread", threadId);
      return { thread, comment };
    });
    await this.pushMentions(principal, result.thread, result.comment);
    return result.comment;
  }

  private async insertComment(tx: Queryable, principal: Principal, thread: ThreadRecord, body: string, given: readonly Mention[]): Promise<CommentRecord> {
    const text = body.trim();
    if (!text) throw invalid("COMMENT_EMPTY", t("A comment cannot be empty"));
    const mentions = await this.knownMentions(given);
    const { rows } = await tx.query(
      `INSERT INTO pandocs.comments (thread_id, author_id, author_name, author_kind, channel, body, mentions)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [thread.id, principal.id, principal.displayName, principal.kind, principal.channel, text, JSON.stringify(mentions)]
    );
    const comment = mapComment(rows[0]!);
    const { rows: participants } = await tx.query<{ author_id: string }>(
      `SELECT DISTINCT author_id FROM pandocs.comments WHERE thread_id = $1 AND deleted_at IS NULL`,
      [thread.id]
    );
    const recipients = new Map<string, "mention" | "reply">();
    for (const { author_id: id } of participants) if (id !== principal.id) recipients.set(id, "reply");
    for (const { id } of mentions) if (id !== principal.id) recipients.set(id, "mention");
    await this.notify(tx, principal, thread, text, recipients, comment.id);
    return comment;
  }

  /** Each notice says which comment it is about, so that taking the comment back takes the notice back too. */
  private async notify(tx: Queryable, principal: Principal, thread: ThreadRecord, text: string, recipients: ReadonlyMap<string, "mention" | "reply">, commentId: string): Promise<void> {
    for (const [recipientId, kind] of recipients) {
      await tx.query(
        `INSERT INTO pandocs.notifications (recipient_id, kind, document_id, thread_id, comment_id, actor_name, summary) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [recipientId, kind, thread.documentId, thread.id, commentId, principal.displayName, text.slice(0, 140)]
      );
    }
  }

  private async pushMentions(principal: Principal, thread: ThreadRecord, comment: CommentRecord, mentions: readonly Mention[] = comment.mentions): Promise<void> {
    const { db, ports: { notifier } } = this.context;
    if (!notifier) return;
    const recipients = mentions.filter(mention => mention.id !== principal.id);
    if (recipients.length === 0) return;
    const { rows } = await db.query<{ title: string; path: string; slug: string }>(
      `SELECT d.title, d.path, s.slug FROM pandocs.documents d JOIN pandocs.spaces s ON s.id = d.space_id WHERE d.id = $1`,
      [thread.documentId]
    );
    const place = rows[0];
    if (!place) return;
    for (const mention of recipients) {
      // A failed push must not fail the comment that already committed.
      await notifier.notify({
        kind: "mention",
        recipientId: mention.id,
        documentId: thread.documentId,
        documentTitle: place.title,
        location: `${place.slug}/${place.path}?thread=${thread.id}`,
        actorName: principal.displayName,
        summary: comment.body.slice(0, 140)
      }).catch(() => undefined);
    }
  }

  /** Only the author changes their own words; anyone with rights over the document can still delete them. */
  async updateComment(principal: Principal, commentId: string, input: { body: string; mentions?: readonly Mention[] | undefined }): Promise<CommentRecord> {
    const text = input.body.trim();
    if (!text) throw invalid("COMMENT_EMPTY", t("A comment cannot be empty"));
    const result = await this.context.db.transaction(async tx => {
      const { rows } = await tx.query(`SELECT * FROM pandocs.comments WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [commentId]);
      if (!rows[0]) throw notFound(t("Comment"));
      const previous = mapComment(rows[0]);
      const thread = await this.loadThread(tx, previous.threadId);
      await requireDocument(tx, principal, thread.documentId, "commenter");
      if (previous.authorId !== principal.id) throw forbidden(t("You can only edit your own comments"));
      const mentions = input.mentions ? await this.knownMentions(input.mentions) : previous.mentions;
      const { rows: updated } = await tx.query(
        `UPDATE pandocs.comments SET body = $2, mentions = $3, edited_at = now() WHERE id = $1 RETURNING *`,
        [commentId, text, JSON.stringify(mentions)]
      );
      const known = new Set(previous.mentions.map(mention => mention.id));
      const added = mentions.filter(mention => !known.has(mention.id));
      await this.notify(tx, principal, thread, text, new Map(added.filter(mention => mention.id !== principal.id).map(mention => [mention.id, "mention" as const])), commentId);
      await audit(tx, principal, "comment.update", "comment", commentId);
      return { comment: mapComment(updated[0]!), thread, added };
    });
    await this.pushMentions(principal, result.thread, result.comment, result.added);
    const [comment] = await this.withReactions(this.context.db, principal, [result.comment]);
    return comment!;
  }

  async react(principal: Principal, commentId: string, input: { emoji: string; active: boolean }): Promise<readonly CommentReaction[]> {
    const { db } = this.context;
    const { rows } = await db.query(
      `SELECT t.document_id FROM pandocs.comments c JOIN pandocs.threads t ON t.id = c.thread_id WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [commentId]
    );
    if (!rows[0]) throw notFound(t("Comment"));
    await requireDocument(db, principal, String(rows[0].document_id), "commenter");
    if (input.active) {
      await db.query(`INSERT INTO pandocs.comment_reactions (comment_id, emoji, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [commentId, input.emoji, principal.id]);
    } else {
      await db.query(`DELETE FROM pandocs.comment_reactions WHERE comment_id = $1 AND emoji = $2 AND user_id = $3`, [commentId, input.emoji, principal.id]);
    }
    const [comment] = await this.withReactions(db, principal, [{ id: commentId } as CommentRecord]);
    return comment!.reactions ?? [];
  }

  async setStatus(principal: Principal, threadId: string, status: "open" | "resolved"): Promise<ThreadRecord> {
    return this.context.db.transaction(async tx => {
      const thread = await this.loadThread(tx, threadId, true);
      const { document } = await requireDocument(tx, principal, thread.documentId, "commenter");
      // A resolved discussion is not moved along with new versions. Reopened, it finds its words in the page as it is
      // now, as an open one would have all along, or says they are gone, rather than pointing at what is there instead.
      if (status === "open" && thread.anchor.kind !== "document" && thread.anchoredRevisionNo !== document.currentRevisionNo) {
        const current = parseDocument((await loadRevision(tx, thread.documentId, document.currentRevisionNo)).markdown, this.context.registry);
        const moved = relocate(thread.anchor, squashWhitespace(visibleText(current, this.context.registry)), anchorableBlocks(current.markdown, topLevelBlocks(current)));
        await tx.query(
          `UPDATE pandocs.threads SET anchor = $2, anchor_state = $3, anchored_revision_no = $4 WHERE id = $1`,
          [threadId, JSON.stringify(moved.anchor), moved.state, document.currentRevisionNo]
        );
      }
      const { rows } = await tx.query(
        status === "resolved"
          ? `UPDATE pandocs.threads SET status = 'resolved', resolved_by = $2, resolved_name = $3, resolved_at = now(), updated_at = now() WHERE id = $1 RETURNING *`
          : `UPDATE pandocs.threads SET status = 'open', resolved_by = NULL, resolved_name = NULL, resolved_at = NULL, updated_at = now() WHERE id = $1 AND ($2::text IS NULL OR true) AND ($3::text IS NULL OR true) RETURNING *`,
        [threadId, principal.id, principal.displayName]
      );
      await audit(tx, principal, `thread.${status === "resolved" ? "resolve" : "reopen"}`, "thread", threadId);
      return mapThread(rows[0]!);
    });
  }

  async deleteComment(principal: Principal, commentId: string): Promise<void> {
    await this.context.db.transaction(async tx => {
      const { rows } = await tx.query(
        `SELECT c.author_id, t.document_id FROM pandocs.comments c JOIN pandocs.threads t ON t.id = c.thread_id WHERE c.id = $1 AND c.deleted_at IS NULL FOR UPDATE OF c`,
        [commentId]
      );
      if (!rows[0]) throw notFound(t("Comment"));
      const { role } = await requireDocument(tx, principal, String(rows[0].document_id), "commenter");
      if (rows[0].author_id !== principal.id && !atLeast(role, "admin")) throw forbidden(t("You can only delete your own comments"));
      await tx.query(`UPDATE pandocs.comments SET deleted_at = now() WHERE id = $1`, [commentId]);
      await tx.query(`DELETE FROM pandocs.notifications WHERE comment_id = $1`, [commentId]);
      await audit(tx, principal, "comment.delete", "comment", commentId);
    });
  }

  async summarizeThread(principal: Principal, threadId: string): Promise<{ summary: string }> {
    const { db, ports } = this.context;
    if (!ports.llm) throw new PandocsError(503, "LLM_UNAVAILABLE", t("Discussion summaries are not set up here"));
    const thread = await this.get(principal, threadId);
    await requireDocument(db, principal, thread.documentId, "commenter");
    const summary = await ports.llm.complete({ purpose: "thread_summary", prompt: threadPrompt(thread).slice(0, THREAD_SUMMARY_LIMIT), actor: principal });
    await db.query(`UPDATE pandocs.threads SET summary = $2, summary_at = now() WHERE id = $1`, [threadId, summary]);
    await audit(db, principal, "thread.summarize", "thread", threadId);
    return { summary };
  }

  async summarizeDocument(principal: Principal, documentId: string): Promise<{ summary: string; threadCount: number }> {
    const { db, ports } = this.context;
    if (!ports.llm) throw new PandocsError(503, "LLM_UNAVAILABLE", t("Discussion summaries are not set up here"));
    const { document } = await requireDocument(db, principal, documentId, "commenter");
    const threads = await this.list(principal, documentId, "open");
    if (threads.length === 0) return { summary: t("This document has no open discussions."), threadCount: 0 };
    const prompt = `Document: ${document.title}\n\n${threads.map((thread, index) => `[Discussion ${index + 1}]\n${threadPrompt(thread)}`).join("\n\n")}`;
    const summary = await ports.llm.complete({ purpose: "document_summary", prompt: prompt.slice(0, THREAD_SUMMARY_LIMIT * 2), actor: principal });
    await audit(db, principal, "document.summarize_threads", "document", documentId);
    return { summary, threadCount: threads.length };
  }

  /** "Related to me": what mentioned me, replies to threads I joined, and proposals waiting for my decision. */
  async inbox(principal: Principal, limit = 50) {
    const { db } = this.context;
    const wanted = Math.min(limit, 100);
    // Being told about a page stops when reading it does, and what it is called is part of that. Notices about pages
    // someone cannot read are left out without taking the place of those they can, so this reads on until it has enough.
    const readable = new Map<string, boolean>();
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; rows.length < wanted && offset < INBOX_SCAN; offset += INBOX_PAGE) {
      const { rows: page } = await db.query(
        `SELECT n.*, d.title AS document_title, d.path AS document_path, s.slug AS space_slug
         FROM pandocs.notifications n
         JOIN pandocs.documents d ON d.id = n.document_id AND d.deleted_at IS NULL
         JOIN pandocs.spaces s ON s.id = d.space_id AND s.deleted_at IS NULL
         WHERE n.recipient_id = $1 ORDER BY n.created_at DESC, n.id LIMIT $2 OFFSET $3`,
        [principal.id, INBOX_PAGE, offset]
      );
      for (const id of new Set(page.map(row => String(row.document_id)))) {
        if (readable.has(id)) continue;
        readable.set(id, await requireDocument(db, principal, id).then(() => true, error => {
          if (error instanceof PandocsError) return false;
          throw error;
        }));
      }
      rows.push(...page.filter(row => readable.get(String(row.document_id))));
      if (page.length < INBOX_PAGE) break;
    }
    const notifications = rows.slice(0, wanted).map(row => ({
      id: String(row.id),
      kind: String(row.kind),
      documentId: String(row.document_id),
      documentTitle: String(row.document_title),
      documentPath: String(row.document_path),
      spaceSlug: String(row.space_slug),
      threadId: row.thread_id ? String(row.thread_id) : null,
      proposalId: row.proposal_id ? String(row.proposal_id) : null,
      changeSetId: null,
      actorName: String(row.actor_name),
      summary: String(row.summary),
      createdAt: new Date(row.created_at as string),
      readAt: row.read_at ? new Date(row.read_at as string) : null
    }));
    // A change set's notices are about no page in particular.
    const { rows: aboutChangeSets } = await db.query(
      `SELECT n.*, c.title, s.slug FROM pandocs.notifications n
       JOIN pandocs.change_sets c ON c.id = n.change_set_id
       JOIN pandocs.spaces s ON s.id = c.space_id AND s.deleted_at IS NULL
       WHERE n.recipient_id = $1 ORDER BY n.created_at DESC LIMIT $2`,
      [principal.id, Math.min(limit, 100)]
    );
    const changeSetNotices = aboutChangeSets.map(row => ({
      id: String(row.id),
      kind: String(row.kind),
      documentId: "",
      documentTitle: String(row.title),
      documentPath: "",
      spaceSlug: String(row.slug),
      threadId: null,
      proposalId: null,
      changeSetId: String(row.change_set_id),
      actorName: String(row.actor_name),
      summary: String(row.summary),
      createdAt: new Date(row.created_at as string),
      readAt: row.read_at ? new Date(row.read_at as string) : null
    }));
    const { rows: pending } = await db.query(
      `SELECT p.id, p.document_id, p.rationale, p.author_name, p.created_at, d.title AS document_title, d.path AS document_path, s.slug AS space_slug
       FROM pandocs.proposals p
       JOIN pandocs.documents d ON d.id = p.document_id AND d.deleted_at IS NULL
       JOIN pandocs.spaces s ON s.id = d.space_id AND s.deleted_at IS NULL
       WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 100`
    );
    const proposals = [];
    for (const row of pending) {
      try {
        await requireDocument(db, principal, String(row.document_id), "editor");
      } catch (error) {
        if (error instanceof PandocsError) continue;
        throw error;
      }
      proposals.push({
        id: String(row.id),
        documentId: String(row.document_id),
        documentTitle: String(row.document_title),
        documentPath: String(row.document_path),
        spaceSlug: String(row.space_slug),
        rationale: String(row.rationale),
        authorName: String(row.author_name),
        createdAt: new Date(row.created_at as string)
      });
    }
    const merged = [...notifications, ...changeSetNotices].sort((one, other) => other.createdAt.getTime() - one.createdAt.getTime()).slice(0, Math.min(limit, 100));
    return { notifications: merged, proposals };
  }

  async markRead(principal: Principal, ids: readonly string[] | "all"): Promise<void> {
    if (ids === "all") {
      await this.context.db.query(`UPDATE pandocs.notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL`, [principal.id]);
    } else {
      await this.context.db.query(`UPDATE pandocs.notifications SET read_at = now() WHERE recipient_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`, [principal.id, ids]);
    }
  }
}

function sectionRef(document: ParsedDocument, section: string): string {
  const entry = outlineOf(document).find(item => item.slug === section || item.ref === section || item.text === section);
  if (!entry) throw new AnchorError("ANCHOR_NOT_FOUND", t("Section {0} not found", section));
  return entry.ref;
}

function threadPrompt(thread: ThreadView): string {
  const quote = thread.anchor.kind === "text" ? thread.anchor.exact : thread.anchor.kind === "block" ? thread.anchor.preview : "(about the whole document)";
  return [`Quote: ${quote}`, ...thread.comments.map(comment => `${comment.authorName}: ${comment.body}`)].join("\n");
}
