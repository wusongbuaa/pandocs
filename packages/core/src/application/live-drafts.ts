import { randomBytes } from "node:crypto";
import { t } from "@pandocs/i18n";
import { PandocsError, forbidden, notFound } from "../domain/errors.js";
import type { DocumentRecord, Principal, RevisionRecord } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import type { LiveCodecPort } from "../ports.js";
import { assertDirectWrites, audit, requireDocument, UUID, type AppContext } from "./context.js";
import { loadRevision } from "./revisions.js";

const IDLE_MINUTES = 5;
const SWEEP_BATCH = 20;

interface DraftRow {
  readonly document_id: string;
  readonly generation: string;
  readonly state: Buffer;
  readonly base_revision_no: number;
  readonly version: number;
  readonly has_changes: boolean;
  readonly contributors: Readonly<Record<string, string>>;
  readonly settled: boolean;
  readonly updated_at: string;
  readonly last_seen_at: string;
}

const sameText = (one: string, other: string) => one.trimEnd() === other.trimEnd();
const nameOf = (row: Pick<DraftRow, "document_id" | "generation">) => `${row.document_id}.${row.generation}`;

/** Other replicas with the draft open hear about changes here, and only they do. */
export const liveChannel = (documentId: string) => `pandocs_live_${documentId.replaceAll("-", "")}`;

/** Someone has written over the draft in the database, so whoever has a copy should read it again. */
export const LIVE_PULL = "pull";

/**
 * The one draft of a page that everyone editing it shares. Typing goes into it, and saving makes a version of it, so
 * readers never see half a sentence and nobody's unsaved work depends on their own browser. It lasts as long as someone
 * is in it or it says something the page does not.
 *
 * What is true is the row: replicas keep copies in memory to serve the people connected to them, and every write here
 * merges with what is there, so that copies can only ever add up.
 */
export class LiveDraftService {
  constructor(private readonly context: AppContext) {}

  private get codec(): LiveCodecPort | undefined {
    return this.context.ports.liveCodec;
  }

  private async row(db: Queryable, documentId: string, lock = false): Promise<DraftRow | null> {
    const { rows } = await db.query<DraftRow>(`SELECT * FROM pandocs.live_drafts WHERE document_id = $1${lock ? " FOR UPDATE" : ""}`, [documentId]);
    return rows[0] ?? null;
  }

  private async mayJoin(principal: Principal, documentId: string): Promise<DocumentRecord> {
    // A token that can only read cannot type either, and an agent proposes rather than edits.
    if (principal.kind !== "user" || !principal.scopes.includes("write")) throw forbidden();
    const { document, space } = await requireDocument(this.context.db, principal, documentId, "editor");
    assertDirectWrites(space);
    return document;
  }

  /** Where to connect to edit this page with whoever else is, starting a draft if there is none. On a server that cannot do this, the editor works alone. */
  async open(principal: Principal, documentId: string): Promise<{ available: false } | { available: true; name: string; baseRevision: number }> {
    const { db } = this.context;
    const { codec } = this;
    const document = await this.mayJoin(principal, documentId);
    if (!codec) return { available: false };
    if (!await this.row(db, document.id)) {
      const { markdown, no } = await loadRevision(db, document.id, document.currentRevisionNo);
      // Whoever gets here second, on any replica, uses the first one's: two starts would mean everything twice.
      await db.query(
        `INSERT INTO pandocs.live_drafts (document_id, generation, state, base_revision_no) VALUES ($1, $2, $3, $4) ON CONFLICT (document_id) DO NOTHING`,
        [document.id, randomBytes(9).toString("base64url"), await codec.seed(markdown, { baseRevision: no }), no]
      );
    }
    await this.catchUp(document.id);
    const row = await this.row(db, document.id);
    if (!row) return this.open(principal, documentId);
    return { available: true, name: nameOf(row), baseRevision: row.base_revision_no };
  }

  /** What the connection asks when it opens, and every so often after: this person may still be here, and the draft is still the one they think. */
  async admit(principal: Principal, name: string): Promise<string> {
    const documentId = name.split(".", 1)[0] ?? "";
    if (!UUID.test(documentId)) throw notFound(t("Document"));
    await this.mayJoin(principal, documentId);
    const row = await this.row(this.context.db, documentId);
    if (!row || nameOf(row) !== name) throw new PandocsError(409, "LIVE_DRAFT_STALE", t("This draft has been started again"));
    return documentId;
  }

  async read(documentId: string): Promise<{ state: Uint8Array; version: number } | null> {
    const row = await this.row(this.context.db, documentId);
    return row ? { state: row.state, version: row.version } : null;
  }

  /**
   * Adds what a replica has to what is stored. `merge` gets what is there and gives what it should become, while nobody
   * else can write. Null means the draft it was working on is gone.
   */
  async write(documentId: string, name: string, merge: (stored: Uint8Array) => Uint8Array, changes: { readonly touched: boolean; readonly contributors: Readonly<Record<string, string>> }): Promise<number | null> {
    return this.context.db.transaction(async tx => {
      const row = await this.row(tx, documentId, true);
      if (!row || nameOf(row) !== name) return null;
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE pandocs.live_drafts SET state = $2, version = version + 1, has_changes = has_changes OR $3, settled = settled AND NOT $3, contributors = contributors || $4, last_seen_at = now(), updated_at = CASE WHEN $3 THEN now() ELSE updated_at END
         WHERE document_id = $1 RETURNING version`,
        [documentId, merge(row.state), changes.touched, JSON.stringify(changes.contributors)]
      );
      return rows[0]!.version;
    });
  }

  /** Which of these drafts are behind their page, because someone saved or something changed it from elsewhere. */
  async behind(documentIds: readonly string[]): Promise<string[]> {
    const { rows } = await this.context.db.query<{ document_id: string }>(
      `SELECT l.document_id FROM pandocs.live_drafts l JOIN pandocs.documents d ON d.id = l.document_id WHERE l.document_id = ANY($1::uuid[]) AND d.deleted_at IS NULL AND d.current_revision_no > l.base_revision_no`,
      [documentIds]
    );
    return rows.map(row => row.document_id);
  }

  /** These are still open somewhere. Says how far each has got, for a replica to tell whether it has missed anything. */
  async stillOpen(documentIds: readonly string[]): Promise<ReadonlyMap<string, { version: number; name: string }>> {
    const { rows } = await this.context.db.query<DraftRow>(`UPDATE pandocs.live_drafts SET last_seen_at = now() WHERE document_id = ANY($1::uuid[]) RETURNING document_id, version, generation`, [documentIds]);
    return new Map(rows.map(row => [row.document_id, { version: row.version, name: nameOf(row) }]));
  }

  private async toLatest(tx: Queryable, row: DraftRow, latest: RevisionRecord, target: string, meta: Readonly<Record<string, string | number | null>>): Promise<{ change: Uint8Array; version: number }> {
    const { state, change } = await this.codec!.align(row.state, target, { baseRevision: latest.no, ...meta });
    const same = sameText(target, latest.markdown);
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE pandocs.live_drafts SET state = $2, base_revision_no = $3, version = version + 1, has_changes = $4, settled = false, contributors = CASE WHEN $4 THEN contributors ELSE '{}'::jsonb END, updated_at = now() WHERE document_id = $1 RETURNING version`,
      [row.document_id, state, latest.no, !same]
    );
    await tx.query(`SELECT pg_notify($1, $2)`, [liveChannel(row.document_id), LIVE_PULL]);
    return { change, version: rows[0]!.version };
  }

  /**
   * Brings in a version made while people were editing, from any of the ways a page can change, so that they see it as it
   * happens and their next save does not undo it. Where it and the draft changed the same place, the draft keeps its text
   * and says so: the version stays in the history, and whoever saves has been told.
   */
  async catchUp(documentId: string): Promise<{ change: Uint8Array; version: number } | null> {
    const { db } = this.context;
    const { codec } = this;
    if (!codec) return null;
    return db.transaction(async tx => {
      const row = await this.row(tx, documentId, true);
      if (!row) return null;
      const { rows: documents } = await tx.query<{ current_revision_no: number }>(`SELECT current_revision_no FROM pandocs.documents WHERE id = $1 AND deleted_at IS NULL`, [documentId]);
      const current = documents[0]?.current_revision_no;
      if (current === undefined || current <= row.base_revision_no) return null;
      const base = await loadRevision(tx, documentId, row.base_revision_no);
      const latest = await loadRevision(tx, documentId, current);
      const ours = await codec.markdownOf(row.state, base.markdown);
      const merged = await codec.merge(base.markdown, ours, latest.markdown);
      return this.toLatest(tx, row, latest, merged.ok ? merged.markdown : merged.keepingOurs, { savedBy: latest.actorName, conflictAt: merged.ok ? null : latest.no, discardedBy: null });
    });
  }

  /** Throws away what is in the draft and nobody has saved, for everyone. */
  async discard(principal: Principal, documentId: string): Promise<void> {
    const { db } = this.context;
    await this.mayJoin(principal, documentId);
    if (!this.codec) return;
    await db.transaction(async tx => {
      const row = await this.row(tx, documentId, true);
      if (!row) return;
      const { rows } = await tx.query<{ current_revision_no: number }>(`SELECT current_revision_no FROM pandocs.documents WHERE id = $1`, [documentId]);
      const latest = await loadRevision(tx, documentId, rows[0]!.current_revision_no);
      await this.toLatest(tx, row, latest, latest.markdown, { discardedBy: principal.displayName, titleDraft: null, conflictAt: null });
      await audit(tx, principal, "document.live_draft.discard", "document", documentId);
    });
  }

  /** Whether there is work in the draft that is not in the page, which is worth telling someone about before they start something else. */
  async status(principal: Principal, documentId: string) {
    const { db } = this.context;
    await this.mayJoin(principal, documentId);
    const row = this.codec ? await this.row(db, documentId) : null;
    if (!row?.has_changes) return { available: this.codec !== undefined, unsaved: null };
    return { available: true, unsaved: { contributors: Object.values(row.contributors), updatedAt: new Date(row.updated_at) } };
  }

  /** Shared drafts with unsaved work this person had a part in. */
  async mine(principal: Principal) {
    const { db } = this.context;
    const { rows } = await db.query<{ document_id: string; title: string; path: string; space_slug: string; space_name: string; updated_at: string }>(
      `SELECT l.document_id, l.updated_at, d.title, d.path, s.slug AS space_slug, s.name AS space_name
       FROM pandocs.live_drafts l
       JOIN pandocs.documents d ON d.id = l.document_id AND d.deleted_at IS NULL
       JOIN pandocs.spaces s ON s.id = d.space_id AND s.deleted_at IS NULL
       WHERE l.has_changes AND l.contributors ? $1 ORDER BY l.updated_at DESC LIMIT 100`,
      [principal.id]
    );
    const drafts = [];
    for (const row of rows) {
      if (await this.mayJoin(principal, row.document_id).then(() => true, () => false)) {
        drafts.push({ documentId: row.document_id, lang: "", title: row.title, path: row.path, spaceSlug: row.space_slug, spaceName: row.space_name, updatedAt: new Date(row.updated_at), shared: true });
      }
    }
    return drafts;
  }

  /**
   * For drafts nobody has been in for a while: one that says what the page says goes, to be started afresh next time.
   * One that does not stays until someone saves or discards it, however long that takes.
   */
  async sweep(): Promise<number> {
    const { db } = this.context;
    const { codec } = this;
    if (!codec) return 0;
    return db.transaction(async tx => {
      const { rows } = await tx.query<DraftRow>(
        `SELECT * FROM pandocs.live_drafts WHERE NOT settled AND last_seen_at < now() - make_interval(mins => $1) ORDER BY last_seen_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [IDLE_MINUTES, SWEEP_BATCH]
      );
      for (const row of rows) {
        const base = await loadRevision(tx, row.document_id, row.base_revision_no);
        const { rows: documents } = await tx.query<{ current_revision_no: number }>(`SELECT current_revision_no FROM pandocs.documents WHERE id = $1`, [row.document_id]);
        const unchanged = documents[0]?.current_revision_no === row.base_revision_no && sameText(await codec.markdownOf(row.state, base.markdown), base.markdown);
        if (unchanged) await tx.query(`DELETE FROM pandocs.live_drafts WHERE document_id = $1`, [row.document_id]);
        else await tx.query(`UPDATE pandocs.live_drafts SET settled = true, has_changes = true WHERE document_id = $1`, [row.document_id]);
      }
      return rows.length;
    });
  }
}
