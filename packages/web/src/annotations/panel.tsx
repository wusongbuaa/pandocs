import * as React from "react";
import clsx from "clsx";
import { ChevronDown, Sparkles, X } from "lucide-react";
import { Tabs } from "@base-ui/react/tabs";
import { Tip } from "../ui/tooltip";
import { Menu } from "../ui/menu";
import { api, failureMessage } from "../api/client";
import type { PandocsPage } from "../data/pages";
import { app } from "../data/runtime-data";
import { atLeast, type ThreadView } from "../types";
import { toast } from "../ui/toast";
import { ProposalsTab } from "../review/proposals";
import { Composer } from "./composer";
import { cancelComment, closePanel, setPanelTab, setShowResolved, submitComment, useAnnotations } from "./store";
import { ThreadCard } from "./thread-card";
import { t } from "../i18n";

/** Reading order: text by position, then blocks, then comments on the whole page. */
function inReadingOrder(threads: readonly ThreadView[]): readonly ThreadView[] {
  const rank = (thread: ThreadView) =>
    thread.anchor.kind === "text"
      ? thread.anchor.start
      : thread.anchor.kind === "block"
        ? Number.MAX_SAFE_INTEGER - 1
        : Number.MAX_SAFE_INTEGER;
  return [...threads].sort((a, b) => rank(a) - rank(b));
}

export function ThreadsTab({ page }: { page: PandocsPage }) {
  const { threads, activeId, pending, showResolved } = useAnnotations();
  const role = page.view.role;
  const visible = inReadingOrder(threads.filter(thread => thread.status === (showResolved ? "resolved" : "open")));
  return (
    <>
      {pending ? (
        <article className="pd-card pd-card--active">
          <div className="pd-card__head">
            <blockquote>
              {pending.kind === "text"
                ? pending.exact
                : pending.kind === "quote"
                  ? pending.quote
                  : pending.preview || t("This block")}
            </blockquote>
          </div>
          <Composer
            autoFocus
            placeholder={t("Write a comment, @ to mention someone")}
            onCancel={cancelComment}
            onSubmit={submitComment}
          />
        </article>
      ) : null}
      {visible.map(thread => (
        <ThreadCard key={thread.id} thread={thread} active={thread.id === activeId} role={role} />
      ))}
      {visible.length === 0 && !pending ? (
        <p className="pd-panel__empty">
          {showResolved
            ? t("No resolved discussions")
            : atLeast(role, "commenter")
              ? t("Select some text to start a comment")
              : t("No comments yet")}
        </p>
      ) : null}
    </>
  );
}

function SummaryButton({ page }: { page: PandocsPage }) {
  const [busy, setBusy] = React.useState(false);
  const [summary, setSummary] = React.useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setSummary((await api.send<{ summary: string }>("POST", `documents/${page.entry.id}/threads/summary`)).summary);
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Tip label={busy ? t("Summarizing…") : t("Summarize open discussions")}>
        <button
          type="button"
          className="pd-panel__head-button pd-panel__head-button--icon"
          disabled={busy}
          aria-label={busy ? t("Summarizing") : t("Summarize open discussions")}
          onClick={() => void run()}
        >
          <Sparkles size={14} aria-hidden="true" />
        </button>
      </Tip>
      {summary ? (
        <div className="pd-panel__summary" role="note">
          <strong>{t("Summarized by AI, for reference only")}</strong>
          <p>{summary}</p>
          <button type="button" className="pd-btn" onClick={() => setSummary(null)}>
            {t("Collapse")}
          </button>
        </div>
      ) : null}
    </>
  );
}

export function AnnotationPanel({ page, onOpenProposal }: { page: PandocsPage; onOpenProposal: (id: string) => void }) {
  const { threads, proposals, showResolved, panelTab } = useAnnotations();
  const openCount = threads.filter(thread => thread.status === "open").length;
  const pendingCount = proposals.filter(proposal => proposal.status === "pending").length;
  const canSummarize = Boolean(app.bootstrap.ai?.configured) && atLeast(page.view.role, "commenter") && openCount > 0;
  return (
    <Tabs.Root
      render={<aside className="pd-panel" aria-label={t("Comments")} />}
      value={panelTab}
      onValueChange={value => setPanelTab(value as typeof panelTab)}
    >
      <header className="pd-panel__head">
        <Tabs.List className="pd-panel__tabs" aria-label={t("Comment panel")}>
          <Tabs.Tab value="threads" className="pd-panel__tab">
            {t("Comments")} <span>{openCount}</span>
          </Tabs.Tab>
          <Tabs.Tab value="proposals" className="pd-panel__tab">
            {t("Suggestions")} <span>{pendingCount}</span>
          </Tabs.Tab>
        </Tabs.List>
        <div className="pd-panel__head-tools">
          {panelTab === "threads" && canSummarize ? <SummaryButton page={page} /> : null}
          {panelTab === "threads" ? (
            <Menu.Root>
              <Menu.Trigger className="pd-panel__head-button">
                {showResolved ? t("Resolved") : t("Unresolved")}
                <ChevronDown size={13} aria-hidden="true" />
              </Menu.Trigger>
              <Menu.Content align="end" sideOffset={4}>
                <Menu.Item onClick={() => setShowResolved(false)}>{t("Unresolved")}</Menu.Item>
                <Menu.Item onClick={() => setShowResolved(true)}>{t("Resolved")}</Menu.Item>
              </Menu.Content>
            </Menu.Root>
          ) : null}
          <Tip label={t("Close (Esc)")}>
            <button type="button" className="pd-icon-button" aria-label={t("Close comments")} onClick={closePanel}>
              <X size={16} aria-hidden="true" />
            </button>
          </Tip>
        </div>
      </header>
      <Tabs.Panel value={panelTab} className="pd-panel__body rp-scrollbar">
        {panelTab === "threads" ? <ThreadsTab page={page} /> : <ProposalsTab onOpen={onOpenProposal} />}
      </Tabs.Panel>
    </Tabs.Root>
  );
}
