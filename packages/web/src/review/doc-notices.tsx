import * as React from "react";
import { Menu } from "../ui/menu";
import { CircleAlert, FilePen, Lock, RefreshCw } from "lucide-react";
import { useRevalidator, useSearchParams } from "@rspress/core/runtime";
import { Link } from "@rspress/core/theme";
import type { Diagnostic } from "@pandocs/markdown";
import { api } from "../api/client";
import { embedded } from "../embed/session";
import { refreshProposals, refreshThreads } from "../annotations/store";
import { followDocument } from "../data/live";
import { editorModeOf, invalidatePages, type PandocsPage } from "../data/pages";
import { app } from "../data/runtime-data";
import { latestDraft, loadServerDraft, readLocalDraft, type StoredDraft } from "../editor/drafts";
import { useAppPage } from "../markdown/document-body";
import { atLeast, type RevisionMeta } from "../types";
import { relativeTime } from "../ui/time";
import { askToSignIn, isVisitor } from "../theme/sign-in";
import { TranslationNotice } from "./translation-notice";
import { t } from "../i18n";

/** Long enough that flicking between windows does not ask the server every time. */
const RECHECK_MS = 15_000;

function problemText(problem: Diagnostic): string {
  return problem.line ? t("Line {0}: {1}", problem.line, problem.message) : problem.message;
}

/** Many changes in a row, such as an agent working through a page, are one look at the server. */
const LIVE_SETTLE_MS = 300;

/** No two people type into one page at once, so a page just keeps up: discussions quietly, the text on request. */
function useNewerRevision(page: PandocsPage): RevisionMeta | null {
  const [newer, setNewer] = React.useState<RevisionMeta | null>(null);
  const documentId = page.entry.id;
  const current = page.view.revision.no;
  React.useEffect(() => {
    setNewer(null);
    let active = true;
    const refreshDiscussions = () => {
      void refreshThreads().catch(() => undefined);
      void refreshProposals().catch(() => undefined);
    };
    const refreshRevision = (accept: (latest: RevisionMeta) => boolean) => {
      api.get<readonly RevisionMeta[]>(`documents/${documentId}/revisions?limit=1`).then(([latest]) => {
        // An answer to a question from before the page moved on says nothing about the page now.
        if (active && latest && latest.no > current && accept(latest)) setNewer(latest);
      }, () => undefined);
    };
    let checked = Date.now();
    // For when the live connection is not there, such as behind a proxy that holds responses back.
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - checked < RECHECK_MS) return;
      checked = Date.now();
      refreshDiscussions();
      refreshRevision(() => true);
    };
    let settling: ReturnType<typeof setTimeout> | null = null;
    let textChanged = false;
    const stop = followDocument(documentId, change => {
      textChanged ||= change?.kind !== "discussion";
      if (settling) clearTimeout(settling);
      settling = setTimeout(() => {
        settling = null;
        refreshDiscussions();
        // Someone saving on this page is already on their way to the new version, and does not need to hear about it.
        if (textChanged) refreshRevision(latest => latest.actorId !== app.bootstrap.me.id || latest.channel !== "web");
        textChanged = false;
      }, LIVE_SETTLE_MS);
    });
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      active = false;
      if (settling) clearTimeout(settling);
      stop();
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [documentId, current]);
  return newer;
}

/** Someone reading a page should find out that they left work on it, not only by opening the editor. */
function DraftNotice({ page }: { page: PandocsPage }) {
  const [params] = useSearchParams();
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null);
  const mode = editorModeOf(page);
  const lang = mode === "translate" ? page.translation!.lang : "";
  const canHaveDraft = mode !== "propose" || atLeast(page.view.role, "commenter");
  const documentId = page.entry.id;
  const published = page.view.markdown;
  React.useEffect(() => {
    if (!canHaveDraft) return undefined;
    let current = true;
    const settle = (server: StoredDraft | null) => {
      const latest = latestDraft(server, readLocalDraft(documentId, lang));
      if (current) setUpdatedAt(latest && latest.draft.markdown !== published ? latest.draft.updatedAt : null);
    };
    loadServerDraft(documentId, lang).then(settle, () => settle(null));
    return () => { current = false; };
  }, [canHaveDraft, documentId, lang, published]);
  if (!updatedAt || params.get("mode") === "edit") return null;
  return (
    <aside className="pd-doc-notice rp-not-doc" role="status">
      <FilePen size={16} aria-hidden="true" />{t("You have an unsaved draft, last edited {0}.", relativeTime(updatedAt))}<span className="pd-doc-notice__actions"><Link href="?mode=edit" className="pd-btn">{t("Continue editing")}</Link></span>
    </aside>
  );
}

/** A shared draft waits for anyone who can edit the page, and someone should find out before starting something else. */
function SharedDraftNotice({ page }: { page: PandocsPage }) {
  const [params] = useSearchParams();
  const [unsaved, setUnsaved] = React.useState<{ readonly contributors: readonly string[]; readonly updatedAt: string } | null>(null);
  const canJoin = editorModeOf(page) === "edit" && !embedded;
  const documentId = page.entry.id;
  const version = page.view.revision.no;
  // Coming back from editing is when there is most likely to be something to say.
  const reading = params.get("mode") !== "edit";
  React.useEffect(() => {
    if (!canJoin || !reading) return undefined;
    let current = true;
    api.get<{ unsaved: { contributors: readonly string[]; updatedAt: string } | null }>(`documents/${documentId}/live`).then(status => {
      if (current) setUnsaved(status.unsaved);
    }, () => undefined);
    return () => { current = false; };
  }, [canJoin, documentId, reading, version]);
  if (!unsaved || !reading) return null;
  return (
    <aside className="pd-doc-notice rp-not-doc" role="status">
      <FilePen size={16} aria-hidden="true" />{unsaved.contributors.length > 0 ? t("This page has unsaved changes from {0}, last edited {1}.", unsaved.contributors.join(", "), relativeTime(unsaved.updatedAt)) : t("This page has unsaved changes, last edited {0}.", relativeTime(unsaved.updatedAt))}<span className="pd-doc-notice__actions"><Link href="?mode=edit" className="pd-btn">{t("Continue editing")}</Link></span>
    </aside>
  );
}

function FreshnessNotice({ page }: { page: PandocsPage }) {
  const newer = useNewerRevision(page);
  const revalidator = useRevalidator();
  const [params] = useSearchParams();
  if (!newer) return null;
  const who = t("{0} saved a new version {1}", newer.actorName, relativeTime(newer.createdAt));
  if (params.get("mode") === "edit") return <aside className="pd-doc-notice pd-doc-notice--editing rp-not-doc" role="status"><RefreshCw size={16} aria-hidden="true" />{t("{0}. Saving merges it with your changes, and tells you if both touched the same text.", who)}</aside>;
  return (
    <aside className="pd-doc-notice rp-not-doc" role="status">
      <RefreshCw size={16} aria-hidden="true" />{t("This page has changed: {0}.", who)}<span className="pd-doc-notice__actions">
        <button type="button" className="pd-btn" onClick={() => { invalidatePages(); void revalidator.revalidate(); }}>{t("Refresh")}</button>
      </span>
    </aside>
  );
}

/** Only for people who can do something about them; a reader sees the affected block marked in place. */
function DiagnosticsNotice({ page }: { page: PandocsPage }) {
  const [params] = useSearchParams();
  const problems = page.view.diagnostics ?? [];
  if (problems.length === 0 || page.translation?.exists || !atLeast(page.view.role, "commenter") || params.get("mode") === "edit") return null;
  return (
    <aside className="pd-doc-notice pd-doc-notice--warning rp-not-doc" aria-label={t("Markup problems")}>
      <CircleAlert size={16} aria-hidden="true" />
      <details>
        <summary>{t("This page has {0} markup {0|problem|problems}", problems.length)}</summary>
        <ul>{problems.map((problem, index) => <li key={index}>{problemText(problem)}</li>)}</ul>
      </details>
      <span className="pd-doc-notice__actions"><Link href="?mode=edit" className="pd-btn">{t("Fix them")}</Link></span>
    </aside>
  );
}

/** The same list in the editor, kept up to date as the text changes. */
export function ProblemsMenu({ problems }: { problems: readonly Diagnostic[] }) {
  if (problems.length === 0) return null;
  return (
    <Menu.Root>
      <Menu.Trigger className="pd-editor__problems"><CircleAlert size={14} aria-hidden="true" />{t("{0} markup {0|problem|problems}", problems.length)}</Menu.Trigger>
      <Menu.Content className="pd-menu--problems" align="end" sideOffset={4}>
        {problems.map((problem, index) => <p key={index}>{problemText(problem)}</p>)}
      </Menu.Content>
    </Menu.Root>
  );
}

/** Sent to the editor by a link, or by signing in to an account that only reads: the page is read instead, and says why. */
function CannotEditNotice({ page }: { page: PandocsPage }) {
  const [params] = useSearchParams();
  if (params.get("mode") !== "edit" || atLeast(page.view.role, "commenter") || page.translation?.canEdit) return null;
  if (!app.bootstrap.me.anonymous) {
    return <aside className="pd-doc-notice rp-not-doc" role="status"><Lock size={16} aria-hidden="true" />{t("You can read this page but not change it. To edit it, ask an administrator of this space.")}</aside>;
  }
  if (!isVisitor()) return null;
  const reason = t("Sign in to edit this page or suggest changes.");
  return (
    <aside className="pd-doc-notice rp-not-doc" role="status">
      <Lock size={16} aria-hidden="true" />{reason}<span className="pd-doc-notice__actions"><button type="button" className="pd-btn" onClick={() => askToSignIn({ reason })}>{t("Sign in")}</button></span>
    </aside>
  );
}

export function DocNotices() {
  const page = useAppPage();
  if (app.bootstrap.me.anonymous) return page?.kind === "document" ? <CannotEditNotice page={page} /> : null;
  return (
    <>
      {page?.kind === "document" ? <><CannotEditNotice page={page} /><FreshnessNotice key={page.entry.id} page={page} /><DraftNotice key={`draft:${page.entry.id}`} page={page} /><SharedDraftNotice key={`shared:${page.entry.id}`} page={page} /><DiagnosticsNotice page={page} /></> : null}
      <TranslationNotice />
    </>
  );
}
