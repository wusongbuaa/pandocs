import * as React from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Bot, RotateCcw, X } from "lucide-react";
import { useNavigate, usePage } from "@rspress/core/runtime";
import { Tip } from "../ui/tooltip";
import { api, failureMessage } from "../api/client";
import { invalidatePages, type PandocsPage } from "../data/pages";
import { documentRoute, localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";
import { atLeast, channelLabel, type RevisionMeta } from "../types";
import { confirm } from "../ui/confirm";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { RenderedDiff } from "./rendered-diff";
import { useReaderContextValue } from "./use-reader-context";
import { t } from "../i18n";

/** The page shows what the chosen version changed; the versions list takes the same place as the annotation panel. */
export default function HistoryView({ page }: { page: PandocsPage }) {
  const { page: themePage } = usePage();
  const navigate = useNavigate();
  const reader = useReaderContextValue(page);
  const documentId = page.entry.id;
  const current = page.view.revision.no;
  const route = documentRoute(page.space.slug, page.entry.path, localePrefix(themePage.lang, app.bootstrap.site.defaultLang));
  const [revisions, setRevisions] = React.useState<readonly RevisionMeta[] | null>(null);
  const [selected, setSelected] = React.useState(current);
  const [diff, setDiff] = React.useState<{ before: string; after: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loadingOlder, setLoadingOlder] = React.useState(false);

  React.useEffect(() => {
    api.get<RevisionMeta[]>(`documents/${documentId}/revisions`).then(setRevisions, error => toast(failureMessage(error), "error"));
  }, [documentId, current]);

  // Versions are numbered from 1 without gaps, so there are older ones until version 1 is in the list.
  const oldest = revisions?.at(-1)?.no;
  const showOlder = async () => {
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const older = await api.get<RevisionMeta[]>(`documents/${documentId}/revisions?before=${oldest}`);
      setRevisions(shown => [...(shown ?? []), ...older.filter(revision => revision.no < oldest)]);
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setLoadingOlder(false);
    }
  };

  React.useEffect(() => {
    let live = true;
    setDiff(null);
    const load = selected <= 1
      ? api.get<{ markdown: string }>(`documents/${documentId}/revisions/1`).then(first => ({ before: "", after: first.markdown }))
      : api.get<{ before: string; after: string }>(`documents/${documentId}/diff?from=${selected - 1}&to=${selected}`);
    load.then(result => { if (live) setDiff(result); }, error => toast(failureMessage(error), "error"));
    return () => { live = false; };
  }, [documentId, selected]);

  React.useEffect(() => {
    document.documentElement.classList.add("pd-panel-open", "pd-reviewing");
    return () => document.documentElement.classList.remove("pd-panel-open", "pd-reviewing");
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[role=dialog]")) navigate(route);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, route]);

  const restore = async () => {
    const yes = await confirm({ title: t("Restore version {0}?", selected), description: t("This makes a new version, and no history is lost."), action: t("Restore") });
    if (!yes) return;
    setBusy(true);
    try {
      await api.send("POST", `documents/${documentId}/rollback`, { idempotent: true, body: { to: selected, expectedRevision: current } });
      invalidatePages();
      toast(t("Restored version {0}", selected), "success");
      navigate(route);
    } catch (error) {
      toast(failureMessage(error, t("Could not restore it. Try again later.")), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {diff ? <RenderedDiff before={diff.before} after={diff.after} reader={reader} /> : <p className="pd-muted">{t("Loading versions…")}</p>}
      {createPortal(<aside className="pd-panel" aria-label={t("Version history")}>
        <header className="pd-panel__head">
          <h2>{t("Version history")}</h2>
          <div className="pd-panel__head-tools">
            <Tip label={t("Close (Esc)")}><button type="button" className="pd-icon-button" aria-label={t("Close version history")} onClick={() => navigate(route)}><X size={16} aria-hidden="true" /></button></Tip>
          </div>
        </header>
        <div className="pd-panel__body rp-scrollbar">
          {revisions?.map(revision => (
            <button type="button" key={revision.no} aria-current={revision.no === selected ? "true" : undefined} className={clsx("pd-revision", revision.no === selected && "pd-revision--active")} onClick={() => setSelected(revision.no)}>
              <span className="pd-revision__head"><strong>{t("Version {0}", revision.no)}</strong>{revision.no === current ? <span className="pd-revision__tag">{t("Current")}</span> : null}{revision.actorKind === "agent" ? <Bot size={13} aria-label={t("Agent")} /> : null}</span>
              <span className="pd-revision__meta">{revision.actorName} · {channelLabel(revision.channel)} · {relativeTime(revision.createdAt)}</span>
              {revision.message ? <span className="pd-revision__message">{revision.message}</span> : null}
            </button>
          ))}
          {oldest !== undefined && oldest > 1 ? <button type="button" className="pd-btn pd-btn--ghost pd-revision-older" disabled={loadingOlder} onClick={() => void showOlder()}>{loadingOlder ? t("Loading versions…") : t("Show older versions")}</button> : null}
        </div>
        {atLeast(page.view.role, "editor") && selected !== current ? (
          <footer className="pd-panel__foot">
            <button type="button" className="pd-btn pd-btn--primary" disabled={busy} onClick={() => void restore()}><RotateCcw size={14} aria-hidden="true" />{t("Restore this version")}</button>
          </footer>
        ) : null}
      </aside>, document.body)}
    </>
  );
}
