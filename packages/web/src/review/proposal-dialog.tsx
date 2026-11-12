import * as React from "react";
import { useRevalidator } from "@rspress/core/runtime";
import type { EditOp } from "@pandocs/markdown";
import { Button } from "@/components/ui/button";
import { api, failureMessage } from "../api/client";
import { refreshProposals, refreshThreads } from "../annotations/store";
import { invalidatePages, type PandocsPage } from "../data/pages";
import { atLeast, type ProposalDetail } from "../types";
import { Dialog } from "../ui/dialog";
import { CheckboxField } from "../ui/form";
import { toast } from "../ui/toast";
import { RenderedDiff } from "./rendered-diff";
import { useReaderContextValue } from "./use-reader-context";
import { t } from "../i18n";

export function describeOp(op: EditOp): string {
  switch (op.op) {
    case "str_replace": return t("Replace \"{0}\"", op.pattern.slice(0, 30));
    case "block_replace": return t("Rewrite block {0}{1}", op.ref, op.end ? t(" through {0}", op.end) : "");
    case "block_insert_after": return op.ref === "start" ? t("Insert at the start") : op.ref === "end" ? t("Insert at the end") : t("Insert after block {0}", op.ref);
    case "block_delete": return t("Delete block {0}{1}", op.ref, op.end ? t(" through {0}", op.end) : "");
    case "block_move_after": return t("Move block {0} after {1}", op.ref, op.after);
  }
}

export default function ProposalDialog({ proposalId, page, onClose }: { proposalId: string; page: PandocsPage; onClose: () => void }) {
  const reader = useReaderContextValue(page);
  const revalidator = useRevalidator();
  const [proposal, setProposal] = React.useState<ProposalDetail | null>(null);
  const [excluded, setExcluded] = React.useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const canDecide = atLeast(page.view.role, "editor");

  React.useEffect(() => {
    api.get<ProposalDetail>(`proposals/${proposalId}`).then(setProposal, error => {
      toast(failureMessage(error), "error");
      onClose();
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- closing is not a reason to read it again.
  }, [proposalId]);

  const decide = async (decision: "accept" | "reject") => {
    if (!proposal) return;
    setBusy(true);
    try {
      const opIndexes = proposal.ops.map((_, index) => index).filter(index => !excluded.has(index));
      await api.send("POST", `proposals/${proposalId}/decide`, { idempotent: true, body: decision === "accept" ? { decision, opIndexes } : { decision } });
      toast(decision === "accept" ? t("Accepted, and the page has a new version") : t("Suggestion rejected"), "success");
      if (decision === "accept") {
        invalidatePages();
        revalidator.revalidate();
        void refreshThreads();
      }
      void refreshProposals();
      onClose();
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const pending = proposal?.status === "pending";
  return (
    <Dialog wide title={t("Suggestion")} description={proposal ? t("By {0}, based on version {1}", proposal.authorName, proposal.baseRevisionNo) : undefined} onClose={onClose}
      footer={canDecide && pending ? <>
        <Button variant="outline" disabled={busy} onClick={() => void decide("reject")}>{t("Reject")}</Button>
        <Button disabled={busy || excluded.size === proposal.ops.length} onClick={() => void decide("accept")}>{excluded.size > 0 ? t("Accept selected changes") : t("Accept")}</Button>
      </> : undefined}>
      {proposal ? (
        <>
          {proposal.rationale ? <p className="pd-proposal__rationale">{proposal.rationale}</p> : null}
          {proposal.stale && pending ? <p className="pd-proposal__stale">{t("The page is now at version {0}. Accepting merges with the latest text, and reports a conflict if both touched the same place.", proposal.currentRevisionNo)}</p> : null}
          {proposal.ops.length > 1 ? (
            <ul className="pd-proposal__ops" aria-label={t("Changes")}>
              {proposal.ops.map((op, index) => (
                <li key={index}>
                  {canDecide && pending ? <CheckboxField label={describeOp(op)} checked={!excluded.has(index)} onChange={checked => setExcluded(current => {
                    const next = new Set(current);
                    if (checked) next.delete(index); else next.add(index);
                    return next;
                  })} /> : describeOp(op)}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="rp-doc rspress-doc"><RenderedDiff before={proposal.baseMarkdown} after={proposal.proposedMarkdown} reader={reader} /></div>
        </>
      ) : <p className="pd-muted">{t("Loading…")}</p>}
    </Dialog>
  );
}
