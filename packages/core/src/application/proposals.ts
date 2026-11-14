import { t } from "@pandocs/i18n";
import { mergeThreeWay, opsBetweenMarkdown, type EditOp } from "@pandocs/markdown";
import { PandocsError, invalid, notFound } from "../domain/errors.js";
import type { Principal, ProposalRecord } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import { audit, requireDocument, type AppContext } from "./context.js";
import { applyOpsOrThrow, type CommitResult, type DocumentService } from "./documents.js";
import { loadRevision } from "./revisions.js";

export interface ProposalView extends ProposalRecord {
  readonly currentRevisionNo: number;
  readonly stale: boolean;
  readonly baseMarkdown: string;
  readonly proposedMarkdown: string;
}

function mapProposal(row: Record<string, unknown>): ProposalRecord {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    baseRevisionNo: Number(row.base_revision_no),
    ops: row.ops as EditOp[],
    rationale: String(row.rationale),
    threadIds: row.thread_ids as string[],
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    authorKind: row.author_kind as ProposalRecord["authorKind"],
    onBehalfOf: row.on_behalf_of ? String(row.on_behalf_of) : null,
    channel: String(row.channel),
    status: row.status as ProposalRecord["status"],
    decidedName: row.decided_name ? String(row.decided_name) : null,
    decidedAt: row.decided_at ? new Date(row.decided_at as string) : null,
    decisionNote: row.decision_note ? String(row.decision_note) : null,
    acceptedOps: (row.accepted_ops as number[] | null) ?? null,
    appliedRevisionNo:
      row.applied_revision_no === null || row.applied_revision_no === undefined
        ? null
        : Number(row.applied_revision_no),
    createdAt: new Date(row.created_at as string)
  };
}

export class ProposalService {
  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService
  ) {}

  async create(
    principal: Principal,
    documentId: string,
    input: {
      baseRevision: number;
      ops?: readonly EditOp[] | undefined;
      markdown?: string | undefined;
      rationale?: string | undefined;
      threadIds?: readonly string[] | undefined;
    }
  ): Promise<ProposalView> {
    const created = await this.context.db.transaction(async tx => {
      const { document } = await requireDocument(tx, principal, documentId, "commenter");
      if (input.baseRevision > document.currentRevisionNo)
        throw invalid("REVISION_INVALID", t("The base version does not exist"));
      const base = await loadRevision(tx, documentId, input.baseRevision);
      // Someone working on a file has the whole new text; the block-level script lets a reviewer accept it piece by piece.
      const ops: readonly EditOp[] =
        input.ops ??
        (input.markdown === undefined
          ? []
          : (opsBetweenMarkdown(base.markdown, input.markdown, this.context.registry) as EditOp[]));
      if (ops.length === 0) throw invalid("PROPOSAL_EMPTY", t("A proposal needs at least one change"));
      applyOpsOrThrow(base.markdown, ops, this.context);
      const { rows } = await tx.query(
        `INSERT INTO pandocs.proposals (document_id, base_revision_no, ops, rationale, thread_ids, author_id, author_name, author_kind, on_behalf_of, channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          documentId,
          input.baseRevision,
          JSON.stringify(ops),
          input.rationale ?? "",
          JSON.stringify(input.threadIds ?? []),
          principal.id,
          principal.displayName,
          principal.kind,
          principal.onBehalfOf?.id ?? null,
          principal.channel
        ]
      );
      const proposal = mapProposal(rows[0]!);
      await audit(tx, principal, "proposal.create", "proposal", proposal.id, { documentId, ops: ops.length });
      return proposal;
    });
    return this.view(this.context.db, created);
  }

  private async view(db: Queryable, proposal: ProposalRecord): Promise<ProposalView> {
    const { rows } = await db.query<{ current_revision_no: number }>(
      `SELECT current_revision_no FROM pandocs.documents WHERE id = $1`,
      [proposal.documentId]
    );
    const currentRevisionNo = Number(rows[0]?.current_revision_no ?? 0);
    const base = await loadRevision(db, proposal.documentId, proposal.baseRevisionNo);
    return {
      ...proposal,
      currentRevisionNo,
      stale: currentRevisionNo !== proposal.baseRevisionNo,
      baseMarkdown: base.markdown,
      proposedMarkdown: applyOpsOrThrow(base.markdown, proposal.ops, this.context)
    };
  }

  async list(
    principal: Principal,
    documentId: string,
    status?: ProposalRecord["status"] | undefined
  ): Promise<ProposalRecord[]> {
    const { db } = this.context;
    await requireDocument(db, principal, documentId);
    const { rows } = await db.query(
      `SELECT * FROM pandocs.proposals WHERE document_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 100`,
      [documentId, status ?? null]
    );
    return rows.map(mapProposal);
  }

  async get(principal: Principal, proposalId: string): Promise<ProposalView> {
    const { db } = this.context;
    const { rows } = await db.query(`SELECT * FROM pandocs.proposals WHERE id = $1`, [proposalId]);
    if (!rows[0]) throw notFound(t("Proposal"));
    const proposal = mapProposal(rows[0]);
    await requireDocument(db, principal, proposal.documentId);
    return this.view(db, proposal);
  }

  /** Accepting merges the proposal onto the latest version, so it stays useful after other edits land. */
  async decide(
    principal: Principal,
    proposalId: string,
    input: {
      decision: "accept" | "reject";
      opIndexes?: readonly number[] | undefined;
      note?: string | undefined;
      resolveThreads?: boolean | undefined;
    }
  ): Promise<{ proposal: ProposalRecord; commit?: CommitResult | undefined }> {
    const result = await this.context.db.transaction(async tx => {
      const { rows } = await tx.query(`SELECT * FROM pandocs.proposals WHERE id = $1 FOR UPDATE`, [proposalId]);
      if (!rows[0]) throw notFound(t("Proposal"));
      const proposal = mapProposal(rows[0]);
      const { document, space } = await requireDocument(tx, principal, proposal.documentId, "editor", true);
      // Someone accepting a suggestion is one person's review, which is all it is worth under the space's rules.
      if (
        input.decision === "accept" &&
        space.mergeRules.requireChangeSets &&
        (space.mergeRules.requiredApprovals > 1 || proposal.authorId === principal.id)
      ) {
        throw new PandocsError(
          403,
          "CHANGE_SET_REQUIRED",
          t("This space needs more review than one person's acceptance, so this has to go through a change set")
        );
      }
      if (proposal.status !== "pending")
        throw new PandocsError(409, "PROPOSAL_DECIDED", t("This proposal has already been decided"));
      if (input.decision === "reject") {
        const { rows: updated } = await tx.query(
          `UPDATE pandocs.proposals SET status = 'rejected', decided_by = $2, decided_name = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *`,
          [proposalId, principal.id, principal.displayName, input.note ?? null]
        );
        await audit(tx, principal, "proposal.reject", "proposal", proposalId);
        await this.notifyAuthor(tx, principal, proposal, t("rejected your proposal"));
        return { proposal: mapProposal(updated[0]!) };
      }
      const selected = input.opIndexes ?? proposal.ops.map((_, index) => index);
      if (selected.length === 0) throw invalid("PROPOSAL_EMPTY", t("Accept at least one change"));
      const ops = selected.map(index => {
        const op = proposal.ops[index];
        if (!op) throw invalid("OP_INDEX_INVALID", t("Change {0} does not exist", index));
        return op;
      });
      const base = await loadRevision(tx, proposal.documentId, proposal.baseRevisionNo);
      const proposed = applyOpsOrThrow(base.markdown, ops, this.context);
      let markdown = proposed;
      if (document.currentRevisionNo !== proposal.baseRevisionNo) {
        const current = await loadRevision(tx, proposal.documentId, document.currentRevisionNo);
        const merged = mergeThreeWay(base.markdown, proposed, current.markdown, this.context.registry);
        if (!merged.ok) {
          throw new PandocsError(
            409,
            "PROPOSAL_CONFLICT",
            t("The document has changed in the same place, so this proposal has to be made again"),
            { conflicts: merged.conflicts, currentRevision: document.currentRevisionNo }
          );
        }
        markdown = merged.markdown;
      }
      const commit = await this.documents.commit(tx, principal, document, {
        markdown,
        proposalId,
        message: t(
          "Accepted {0}'s proposal{1}",
          proposal.authorName,
          proposal.rationale ? t(": {0}", proposal.rationale.slice(0, 80)) : ""
        )
      });
      const { rows: updated } = await tx.query(
        `UPDATE pandocs.proposals SET status = 'accepted', decided_by = $2, decided_name = $3, decided_at = now(), decision_note = $4, accepted_ops = $5, applied_revision_no = $6 WHERE id = $1 RETURNING *`,
        [
          proposalId,
          principal.id,
          principal.displayName,
          input.note ?? null,
          JSON.stringify(selected),
          commit.revision.no
        ]
      );
      if (input.resolveThreads !== false && proposal.threadIds.length > 0) {
        await tx.query(
          `UPDATE pandocs.threads SET status = 'resolved', resolved_by = $2, resolved_name = $3, resolved_at = now(), updated_at = now()
           WHERE id = ANY($1::uuid[]) AND document_id = $4 AND status = 'open'`,
          [proposal.threadIds, principal.id, principal.displayName, proposal.documentId]
        );
      }
      await audit(tx, principal, "proposal.accept", "proposal", proposalId, {
        revision: commit.revision.no,
        ops: selected
      });
      await this.notifyAuthor(tx, principal, proposal, t("accepted your proposal"));
      return { proposal: mapProposal(updated[0]!), commit };
    });
    return result;
  }

  private async notifyAuthor(
    tx: Queryable,
    principal: Principal,
    proposal: ProposalRecord,
    summary: string
  ): Promise<void> {
    const recipient = proposal.onBehalfOf ?? proposal.authorId;
    if (recipient === principal.id) return;
    await tx.query(
      `INSERT INTO pandocs.notifications (recipient_id, kind, document_id, proposal_id, actor_name, summary) VALUES ($1, 'proposal_decided', $2, $3, $4, $5)`,
      [recipient, proposal.documentId, proposal.id, principal.displayName, summary]
    );
  }
}
