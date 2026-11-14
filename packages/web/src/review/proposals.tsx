import clsx from "clsx";
import { Bot } from "lucide-react";
import { useAnnotations } from "../annotations/store";
import type { ProposalSummary } from "../types";
import { relativeTime } from "../ui/time";
import { t } from "../i18n";

const STATUS: Readonly<Record<ProposalSummary["status"], string>> = {
  pending: t("Pending"),
  accepted: t("Accepted"),
  rejected: t("Rejected")
};

export function ProposalsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { proposals } = useAnnotations();
  if (proposals.length === 0) return <p className="pd-panel__empty">{t("No suggestions yet")}</p>;
  return (
    <>
      {proposals.map(proposal => (
        <button type="button" key={proposal.id} className="pd-proposal-card" onClick={() => onOpen(proposal.id)}>
          <span className="pd-proposal-card__head">
            <span className={clsx("pd-status", `pd-status--${proposal.status}`)}>{STATUS[proposal.status]}</span>
            <strong title={proposal.authorName}>{proposal.authorName}</strong>
            {proposal.authorKind === "agent" ? <Bot size={13} aria-label={t("Agent")} /> : null}
            <time>{relativeTime(proposal.createdAt)}</time>
          </span>
          <span className="pd-proposal-card__body">
            {proposal.rationale || t("{0} {0|change|changes}", proposal.ops.length)}
          </span>
        </button>
      ))}
    </>
  );
}
