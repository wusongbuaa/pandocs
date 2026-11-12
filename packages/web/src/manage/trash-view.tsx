import * as React from "react";
import { Button } from "@/components/ui/button";
import { api, failureMessage } from "../api/client";
import { spaceManageRoute } from "../data/manage";
import { pageUrl } from "../data/paths";
import { app } from "../data/runtime-data";
import { atLeast, type ChangeSetSummary, type Space, type TrashEntry } from "../types";
import { confirm } from "../ui/confirm";
import { FormDialog } from "../ui/dialog";
import { SelectField, TextField } from "../ui/form";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

const NEW_CHANGE_SET = "new";

/** Where every change goes through review, a page comes back from the trash the same way: as part of a change set. */
function RestoreThroughChangeSet({ space, entry, onClose }: { space: Space; entry: TrashEntry; onClose: () => void }) {
  const open = useLoaded(() => api.get<ChangeSetSummary[]>(`spaces/${space.slug}/change-sets?status=open`), [space.slug]);
  const [target, setTarget] = React.useState(NEW_CHANGE_SET);
  const [title, setTitle] = React.useState(() => t("Bring back \"{0}\"", entry.title));
  const submit = async () => {
    const id = target === NEW_CHANGE_SET ? (await api.send<{ id: string }>("POST", `spaces/${space.slug}/change-sets`, { body: { title: title.trim() } })).id : target;
    await api.send("POST", `change-sets/${id}/pages`, { body: { document: entry.id, restore: true } });
    toast(t("Added to the change set."), "success");
    location.assign(pageUrl(`${spaceManageRoute(space.slug, "change-sets")}?id=${id}`));
  };
  const choices = [{ value: NEW_CHANGE_SET, label: t("A new change set") }, ...(open.status === "ready" ? open.data : []).map(item => ({ value: item.id, label: t("Add to \"{0}\"", item.title) }))];
  return (
    <FormDialog title={t("Restore \"{0}\"", entry.title)} description={t("Changes in this space go through change sets. The page comes back once the change set is merged.")} action={t("Add to a change set")} disabled={target === NEW_CHANGE_SET && !title.trim()} onClose={onClose} onSubmit={submit}>
      <SelectField label={t("Change set")} value={target} onChange={setTarget} choices={choices} />
      {target === NEW_CHANGE_SET ? <TextField label={t("Title")} required value={title} onChange={event => setTitle(event.target.value)} /> : null}
    </FormDialog>
  );
}

export function TrashView({ space }: { space: Space }) {
  const trash = useLoaded(() => api.get<TrashEntry[]>(`spaces/${space.slug}/trash`), [space.slug]);
  const [restoring, setRestoring] = React.useState<TrashEntry | null>(null);
  const reviewed = space.mergeRules?.requireChangeSets === true;
  const restore = async (entry: TrashEntry) => {
    try {
      const restored = await api.send<{ path: string }>("POST", `documents/${entry.id}/restore`);
      toast(restored.path === entry.path ? t("Restored") : t("Restored to {0}", restored.path), "success");
      trash.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const purge = async (entry: TrashEntry) => {
    const ok = await confirm({ title: t("Permanently delete \"{0}\"?", entry.title), description: t("Its version history and discussions go with it, for good."), action: t("Delete permanently"), danger: true });
    if (!ok) return;
    try {
      await api.send("DELETE", `documents/${entry.id}/purge`);
      trash.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const emptyAll = async () => {
    const ok = await confirm({ title: t("Empty the trash?"), description: t("All those pages' version history and discussions go with them, for good."), action: t("Empty"), danger: true });
    if (!ok) return;
    try {
      const { removed } = await api.send<{ removed: number }>("DELETE", `spaces/${space.slug}/trash`);
      toast(t("Permanently deleted {0} {0|page|pages}", removed), "success");
      trash.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const hasEntries = trash.status === "ready" && trash.data.length > 0;
  const { trashRetentionDays: retention } = app.bootstrap.site;
  return (
    <>
      <ManageHead title={t("{0}: trash", space.name)} description={t("Deleted pages stay here. A restored page returns to where it was, or to the top level if its parent is gone too. {0}", retention ? t("Pages here longer than {0} {0|day|days} are deleted for good.", retention) : "")}>
        {atLeast(space.role, "admin") && hasEntries ? <Button variant="outline" onClick={() => void emptyAll()}>{t("Empty trash")}</Button> : null}
      </ManageHead>
      <LoadedContent loaded={trash}>
        {entries => entries.length === 0 ? <EmptyState>{t("The trash is empty.")}</EmptyState> : (
          <table>
            <thead><tr><th>{t("Page")}</th><th>{t("Delete")}</th><th /></tr></thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id}>
                  <td>{entry.title}{entry.descendants > 0 ? <span className="pd-muted">{t(" (with {0} {0|subpage|subpages})", entry.descendants)}</span> : null}<div className="pd-table__note">{entry.path}</div></td>
                  <td>{entry.deletedName ?? t("Unknown")} · {relativeTime(entry.deletedAt)}</td>
                  <td className="pd-table__actions">
                    <Button variant="outline" size="sm" onClick={() => (reviewed ? setRestoring(entry) : void restore(entry))}>{t("Restore")}</Button>
                    {atLeast(space.role, "admin") ? <Button variant="outline" size="sm" onClick={() => void purge(entry)}>{t("Delete permanently")}</Button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadedContent>
      {restoring ? <RestoreThroughChangeSet space={space} entry={restoring} onClose={() => setRestoring(null)} /> : null}
    </>
  );
}
