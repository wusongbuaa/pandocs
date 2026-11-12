import { Link } from "@rspress/core/theme";
import { Button } from "@/components/ui/button";
import { api, failureMessage } from "../api/client";
import { documentRoute, localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";
import { deleteServerDraft, forgetLocalDraft, listDrafts, type ListedDraft } from "../editor/drafts";
import { confirm } from "../ui/confirm";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

const editRoute = (draft: ListedDraft) => `${documentRoute(draft.spaceSlug, draft.path, draft.lang ? localePrefix(draft.lang, app.bootstrap.site.defaultLang) : "")}?mode=edit`;

export function DraftsView() {
  const drafts = useLoaded(listDrafts, []);
  const discard = async (draft: ListedDraft) => {
    if (!await confirm({ title: t("Discard the draft of \"{0}\"?", draft.title), description: draft.shared ? t("This is the draft everyone who can edit the page shares. What others wrote in it goes too.") : t("Unsaved changes are lost for good."), action: t("Discard"), danger: true })) return;
    try {
      if (draft.shared) {
        await api.send("DELETE", `documents/${draft.documentId}/live`);
        drafts.reload();
        return;
      }
      forgetLocalDraft(draft.documentId, draft.lang);
      if (!draft.localOnly) await deleteServerDraft(draft.documentId, draft.lang);
      drafts.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  return (
    <>
      <ManageHead title={t("My drafts")} description={t("Pages you left part way through editing. A draft goes away once it is saved or sent as a suggestion. Only you can see yours, unless it says it is shared.")} />
      <LoadedContent loaded={drafts}>
        {entries => entries.length === 0 ? <EmptyState>{t("No unsaved drafts.")}</EmptyState> : (
          <table>
            <thead><tr><th>{t("Page")}</th><th>{t("Last edited")}</th><th /></tr></thead>
            <tbody>
              {entries.map(draft => (
                <tr key={`${draft.documentId}:${draft.lang}:${draft.shared ? "shared" : ""}`}>
                  <td>
                    <Link href={editRoute(draft)}>{draft.title}</Link>
                    {draft.lang ? <span className="pd-muted">{t(" ({0} translation)", draft.lang)}</span> : null}
                    <div className="pd-table__note">{draft.spaceName}{draft.localOnly ? t(" · only on this computer, syncs when opened") : ""}{draft.shared ? t(" · shared with everyone who can edit the page") : ""}</div>
                  </td>
                  <td>{relativeTime(draft.updatedAt)}</td>
                  <td className="pd-table__actions"><Button variant="outline" size="sm" onClick={() => void discard(draft)}>{t("Discard")}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadedContent>
    </>
  );
}
