import * as React from "react";
import { Button } from "@/components/ui/button";
import { Filter } from "../ui/filter";
import { api, failureMessage } from "../api/client";
import { documentRoute, pageUrl } from "../data/paths";
import { channelLabel, type AuditCategory, type AuditEntry, type Space } from "../types";
import { formatTime } from "../ui/time";
import { EmptyState, ManageHead } from "./parts";
import { ROLE_LABELS } from "./roles";
import { t } from "../i18n";

const ACTIONS: Readonly<Record<string, string>> = {
  "document.create": t("Created a page"),
  "space.public": t("Made a space public"),
  "space.private": t("Made a space private"),
  "document.commit": t("Saved a new version"),
  "document.update": t("Changed page details"),
  "document.move": t("Moved a page"),
  "document.delete": t("Deleted a page"),
  "document.restore": t("Restored a page"),
  "document.purge": t("Permanently deleted a page"),
  "document.labels": t("Changed page labels"),
  "document.share": t("Shared a page by link"),
  "document.unshare": t("Revoked a share link"),
  "space.template.create": t("Created a template"),
  "space.template.update": t("Changed a template"),
  "space.template.delete": t("Deleted a template"),
  "space.merge_rules": t("Changed how changes are reviewed"),
  "space.change_set.create": t("Started a change set"),
  "space.change_set.review": t("Reviewed a change set"),
  "space.change_set.merge": t("Merged a change set"),
  "space.change_set.close": t("Closed a change set"),
  "space.change_set.reopen": t("Reopened a change set"),
  "space.change_set.delete": t("Deleted a change set"),
  "space.git_sync.set": t("Changed the Git sync settings"),
  "space.git_sync.remove": t("Disconnected a repository"),
  "space.webhook.create": t("Added a webhook"),
  "space.webhook.update": t("Changed a webhook"),
  "space.webhook.delete": t("Deleted a webhook"),
  "site.webhook.create": t("Added a webhook"),
  "site.webhook.update": t("Changed a webhook"),
  "site.webhook.delete": t("Deleted a webhook"),
  "document.member.set": t("Changed page permissions"),
  "document.translate": t("Saved a translation"),
  "document.translation.delete": t("Deleted a translation"),
  "document.assist": t("Used AI"),
  "document.summarize_threads": t("Summarized discussions"),
  "thread.create": t("Started a discussion"),
  "thread.reply": t("Replied to a discussion"),
  "thread.resolve": t("Resolved a discussion"),
  "thread.reopen": t("Reopened a discussion"),
  "thread.summarize": t("Summarized discussions"),
  "comment.update": t("Edited a comment"),
  "comment.delete": t("Deleted a comment"),
  "proposal.create": t("Sent a suggestion"),
  "proposal.accept": t("Accepted a suggestion"),
  "proposal.reject": t("Rejected a suggestion"),
  "space.create": t("Created a space"),
  "space.delete": t("Deleted a space"),
  "space.purge": t("Permanently deleted a space"),
  "space.restore": t("Restored a space"),
  "space.member.set": t("Changed space members"),
  "site.update": t("Changed site settings"),
  "site.user.create": t("Added a user"),
  "site.user.update": t("Changed a user"),
  "site.user.password_link": t("Made a password link"),
  "site.embed_app.create": t("Added an embed app"),
  "site.embed_app.update": t("Changed an embed app"),
  "site.embed_app.secret": t("Replaced an embed app's secret"),
  "site.embed_app.delete": t("Removed an embed app"),
  "asset.put": t("Uploaded a file")
};

const CATEGORIES: readonly { readonly value: AuditCategory | ""; readonly label: string }[] = [
  { value: "", label: t("All") },
  { value: "document", label: t("Page") },
  { value: "discussion", label: t("Discussion") },
  { value: "proposal", label: t("Suggestions") },
  { value: "member", label: t("Permissions") },
  { value: "space", label: t("Spaces and site") }
];

const PAGE_SIZE = 50;

function detailOf({ action, detail }: AuditEntry): string {
  const text = (key: string) => (typeof detail[key] === "string" ? (detail[key] as string) : "");
  if (action === "document.move") return `${text("from")} → ${text("to")}`;
  if (action === "document.commit") return t("Version {0}", String(detail.revision ?? ""));
  if (action === "document.purge") return text("title");
  if (action.startsWith("document.translat")) return text("lang");
  if (action.endsWith(".member.set")) {
    const role = text("role");
    return t(
      "{0}: {1}",
      text("subjectName") || text("subject"),
      role ? (ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role) : t("removed")
    );
  }
  if (action.startsWith("site.user.")) return text("email");
  if (action.startsWith("site.embed_app.")) return text("slug");
  if (action === "site.update") return Array.isArray(detail.fields) ? detail.fields.join(t(", ")) : "";
  if (action === "space.create" || action === "space.delete" || action === "space.purge" || action === "space.restore")
    return text("slug");
  return "";
}

function AuditTable({ path, title, description }: { path: string; title: string; description: string }) {
  const [category, setCategory] = React.useState<AuditCategory | "">("");
  const [entries, setEntries] = React.useState<readonly AuditEntry[]>([]);
  const [state, setState] = React.useState<{ loading: boolean; more: boolean; error: string | null }>({
    loading: true,
    more: false,
    error: null
  });
  const load = React.useCallback(
    async (before: string | undefined, previous: readonly AuditEntry[]) => {
      setState(current => ({ ...current, loading: true, error: null }));
      const query = new URLSearchParams({
        limit: String(PAGE_SIZE),
        ...(category ? { category } : {}),
        ...(before ? { before } : {})
      });
      try {
        const page = await api.get<AuditEntry[]>(`${path}?${query}`);
        setEntries([...previous, ...page]);
        setState({ loading: false, more: page.length === PAGE_SIZE, error: null });
      } catch (error) {
        setState({
          loading: false,
          more: false,
          error: failureMessage(error, t("Could not load this. Try again later."))
        });
      }
    },
    [category, path]
  );
  React.useEffect(() => {
    void load(undefined, []);
  }, [load]);
  return (
    <>
      <ManageHead title={title} description={description} />
      <Filter label={t("Filter by type")} value={category} items={CATEGORIES} onChange={setCategory} />
      {state.error ? <p className="pd-manage__error">{state.error}</p> : null}
      {!state.loading && !state.error && entries.length === 0 ? (
        <EmptyState>{t("Nothing recorded yet.")}</EmptyState>
      ) : null}
      {entries.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("Time")}</th>
              <th>{t("Who")}</th>
              <th>{t("What")}</th>
              <th>{t("Page")}</th>
              <th>{t("Channel")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.id}>
                <td className="pd-table__nowrap">{formatTime(entry.createdAt)}</td>
                <td className="pd-table__nowrap">
                  {entry.actorName}
                  {entry.actorKind === "agent" ? t(" (agent)") : ""}
                </td>
                <td>
                  {ACTIONS[entry.action] ?? entry.action}
                  {detailOf(entry) ? <div className="pd-table__note">{detailOf(entry)}</div> : null}
                </td>
                <td>
                  {entry.documentTitle ? (
                    entry.spaceSlug && entry.documentPath ? (
                      <a href={pageUrl(documentRoute(entry.spaceSlug, entry.documentPath))}>{entry.documentTitle}</a>
                    ) : (
                      entry.documentTitle
                    )
                  ) : (
                    <span className="pd-muted">—</span>
                  )}
                </td>
                <td className="pd-table__nowrap">{channelLabel(entry.channel)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {state.more ? (
        <p>
          <Button variant="outline" disabled={state.loading} onClick={() => void load(entries.at(-1)?.id, entries)}>
            {t("Load more")}
          </Button>
        </p>
      ) : null}
    </>
  );
}

export function AuditView({ space }: { space: Space }) {
  return (
    <AuditTable
      path={`spaces/${space.slug}/audit`}
      title={t("{0}: audit log", space.name)}
      description={t("Who did what in this space, and when.")}
    />
  );
}

export function SiteAuditView() {
  return (
    <AuditTable
      path="audit"
      title={t("Site audit log")}
      description={t("Changes to every space and to the site settings.")}
    />
  );
}
