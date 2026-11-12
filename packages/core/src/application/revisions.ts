import { notFound } from "../domain/errors.js";
import type { RevisionRecord } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import { t } from "@pandocs/i18n";

export interface RevisionMeta {
  readonly no: number;
  readonly sha256: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly actorKind: string;
  readonly channel: string;
  readonly onBehalfOf: string | null;
  readonly proposalId: string | null;
  readonly ingestJobId: string | null;
  readonly changeSetId: string | null;
  readonly message: string;
  readonly createdAt: Date;
}

export function mapRevision(row: Record<string, unknown>): RevisionRecord {
  return {
    documentId: String(row.document_id),
    no: Number(row.no),
    markdown: String(row.markdown ?? ""),
    sha256: String(row.sha256),
    visibleText: String(row.visible_text ?? ""),
    actorId: String(row.actor_id),
    actorName: String(row.actor_name),
    actorKind: row.actor_kind as RevisionRecord["actorKind"],
    channel: String(row.channel),
    onBehalfOf: row.on_behalf_of ? String(row.on_behalf_of) : null,
    proposalId: row.proposal_id ? String(row.proposal_id) : null,
    ingestJobId: row.ingest_job_id ? String(row.ingest_job_id) : null,
    changeSetId: row.change_set_id ? String(row.change_set_id) : null,
    message: String(row.message),
    createdAt: new Date(row.created_at as string)
  };
}

export function metaOf({ markdown: _markdown, visibleText: _visibleText, documentId: _documentId, ...meta }: RevisionRecord): RevisionMeta {
  return meta;
}

export async function loadRevision(db: Queryable, documentId: string, no: number): Promise<RevisionRecord> {
  const { rows } = await db.query(`SELECT * FROM pandocs.revisions WHERE document_id = $1 AND no = $2`, [documentId, no]);
  if (!rows[0]) throw notFound(t("Version {0} ", no));
  return mapRevision(rows[0]);
}
