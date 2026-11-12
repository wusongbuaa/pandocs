import * as React from "react";
import { usePage } from "@rspress/core/runtime";
import { Button } from "@/components/ui/button";
import { failureMessage } from "../api/client";
import { editorModeOf, type PandocsPage } from "../data/pages";
import { documentRoute, localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";
import { Dialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { api } from "../api/client";
import { DocumentEditor } from "./document-editor";
import { openLiveSession, type LiveSession } from "./live-session";
import { deleteServerDraft, forgetLocalDraft, latestDraft, loadServerDraft, readLocalDraft, type StoredDraft } from "./drafts";
import { t } from "../i18n";

interface FoundDraft {
  readonly draft: StoredDraft;
  /** The newest copy only exists in this browser, so the server still has to get it. */
  readonly local: boolean;
}

/** Opens on the current version, or on the draft left behind, if the person wants it back. */
export default function EditorPage({ page }: { page: PandocsPage }) {
  const { page: themePage } = usePage();
  const [found, setFound] = React.useState<FoundDraft | null | undefined>(undefined);
  const [resume, setResume] = React.useState<boolean | null>(null);
  /** The shared draft and what it has caught up with. Null when this is done alone, and undefined until that is known. */
  const [live, setLive] = React.useState<{ readonly session: LiveSession; readonly markdown: string; readonly baseRevision: number } | null | undefined>(undefined);
  const documentId = page.entry.id;
  const mode = editorModeOf(page);
  const lang = mode === "translate" ? page.translation!.lang : "";
  const publishedTitle = lang ? page.entry.titles?.[lang] : page.entry.title;
  const route = documentRoute(page.space.slug, page.entry.path, localePrefix(themePage.lang, app.bootstrap.site.defaultLang));

  React.useEffect(() => {
    let current = true;
    const settle = (server: StoredDraft | null) => {
      if (!current) return;
      const latest = latestDraft(server, readLocalDraft(documentId, lang));
      const differs = latest && (latest.draft.markdown !== page.view.markdown || (latest.draft.title ?? publishedTitle) !== publishedTitle);
      // A copy left by a tab that closed mid-save and has since been published says nothing new.
      if (!differs) forgetLocalDraft(documentId, lang);
      setFound(differs ? latest : null);
      setResume(differs ? null : false);
    };
    loadServerDraft(documentId, lang).then(settle, error => {
      toast(failureMessage(error, t("Could not read the draft")), "error");
      settle(null);
    });
    return () => { current = false; };
  }, [documentId, lang, page.view.markdown, publishedTitle]);

  // Someone going back to a draft of their own carries on as they started, and merges it in when they save.
  const joinsDraft = mode === "edit" && resume === false;
  React.useEffect(() => {
    if (!joinsDraft) return undefined;
    let current = true;
    let session: LiveSession | null = null;
    void (async () => {
      const opened = await openLiveSession(documentId);
      session = opened.session;
      if (!session) {
        if (opened.unreachable) toast(t("Could not connect for editing together, so you are editing alone. Your changes merge with others' when you save."));
        if (current) setLive(null);
        return;
      }
      const no = Number(session.meta.get("baseRevision"));
      if (!Number.isInteger(no) || no < 1) throw new Error("The shared draft does not say which version it started from");
      const markdown = no === page.view.revision.no ? page.view.markdown ?? "" : (await api.get<{ markdown: string }>(`documents/${documentId}/revisions/${no}`)).markdown;
      if (current) setLive({ session, markdown, baseRevision: no });
      else session.destroy();
    })().catch(error => {
      toast(failureMessage(error), "error");
      if (current) setLive(null);
    });
    return () => {
      current = false;
      session?.destroy();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- this page's text is only what to compare with on the way in
  }, [documentId, joinsDraft]);

  const shared = Boolean(joinsDraft && live);
  React.useEffect(() => {
    document.documentElement.classList.toggle("pd-editing-together", shared);
    return () => document.documentElement.classList.remove("pd-editing-together");
  }, [shared]);

  // Until there is an editor to show, the page goes on showing what was being read.
  if (found === undefined) return null;
  if (resume === null && found) {
    const discard = () => {
      forgetLocalDraft(documentId, lang);
      void deleteServerDraft(documentId, lang).catch(() => undefined).finally(() => setResume(false));
    };
    return (
      <Dialog title={t("There is an unsaved draft")} description={t("Last edited {0}. Continue it, or discard it and start from the current version.", relativeTime(found.draft.updatedAt))} onClose={() => setResume(false)} footer={<>
        <Button variant="outline" onClick={discard}>{t("Discard draft")}</Button>
        <Button onClick={() => setResume(true)}>{t("Continue the draft")}</Button>
      </>} />
    );
  }
  if (joinsDraft && live === undefined) return null;
  if (joinsDraft && live) return <DocumentEditor page={page} mode={mode} lang={lang} markdown={live.markdown} baseRevision={live.baseRevision} route={route} live={live.session} />;
  return resume && found
    ? <DocumentEditor page={page} mode={mode} lang={lang} markdown={found.draft.markdown} baseRevision={found.draft.baseRevision} route={route} resumed={found} />
    : <DocumentEditor page={page} mode={mode} lang={lang} markdown={page.view.markdown ?? ""} baseRevision={page.view.revision.no} route={route} />;
}
