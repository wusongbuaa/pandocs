import * as React from "react";
import clsx from "clsx";
import { Link } from "@rspress/core/theme";
import { Button } from "@/components/ui/button";
import { Filter } from "../ui/filter";
import { api, failureMessage } from "../api/client";
import { spaceManageRoute } from "../data/manage";
import { documentRoute } from "../data/paths";
import type { InboxView as Inbox, Subscription } from "../types";
import { noticeText } from "../ui/notice-text";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

const FILTERS = [{ value: "unread", label: t("Unread") }, { value: "all", label: t("All") }] as const;

function Following() {
  const following = useLoaded(() => api.get<Subscription[]>("me/subscriptions"), []);
  const stop = async ({ documentId, spaceSlug }: Subscription) => {
    try {
      await api.send("DELETE", documentId ? `documents/${documentId}/subscription` : `spaces/${encodeURIComponent(spaceSlug)}/subscription`);
      following.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  if (following.status !== "ready" || following.data.length === 0) return null;
  return (
    <>
      <h2>{t("Following")}</h2>
      <ul className="pd-notices">
        {following.data.map(item => (
          <li key={item.documentId ?? item.spaceSlug} className="pd-notice-row">
            {item.documentId
              ? <Link href={documentRoute(item.spaceSlug, item.path ?? "")}>{item.title}</Link>
              : <Link href={`/${item.spaceSlug}/`}>{t("Every page in {0}", item.spaceName)}</Link>}
            <button type="button" className="pd-link-button" onClick={() => void stop(item)}>{t("Stop following")}</button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function InboxView() {
  const inbox = useLoaded(() => api.get<Inbox>("me/inbox"), []);
  const [filter, setFilter] = React.useState<"unread" | "all">("unread");
  const markRead = async (ids: readonly string[] | "all") => {
    try {
      await api.send("POST", "me/inbox/read", { body: { ids } });
      inbox.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const unread = inbox.status === "ready" ? inbox.data.notifications.filter(item => !item.readAt).length : 0;
  return (
    <>
      <ManageHead title={t("Notifications")} description={t("Mentions of you, replies to discussions you joined, suggestions waiting for you, and changes to what you follow.")}>
        {unread > 0 ? <Button variant="outline" onClick={() => void markRead("all")}>{t("Mark all as read")}</Button> : null}
      </ManageHead>
      <LoadedContent loaded={inbox}>
        {data => {
          const notifications = filter === "all" ? data.notifications : data.notifications.filter(item => !item.readAt);
          return (
            <>
              {data.proposals.length > 0 ? (
                <>
                  <h2>{t("Suggestions waiting for me")}</h2>
                  <ul className="pd-notices">
                    {data.proposals.map(item => (
                      <li key={item.id}>
                        <Link href={`${documentRoute(item.spaceSlug, item.documentPath)}?proposal=${item.id}`} className="pd-notice-row">
                          <span>{t("{0} suggested a change to \"{1}\"{2}", item.authorName, item.documentTitle, item.rationale ? t(": {0}", item.rationale) : "")}</span>
                          <time>{relativeTime(item.createdAt)}</time>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {data.changeSets.length > 0 ? (
                <>
                  <h2>{t("Change sets waiting for me")}</h2>
                  <ul className="pd-notices">
                    {data.changeSets.map(item => (
                      <li key={item.id}>
                        <Link href={`${spaceManageRoute(item.spaceSlug, "change-sets")}?id=${item.id}`} className="pd-notice-row">
                          <span>{t("{0} wants a review of \"{1}\": {2} {2|page|pages}", item.authorName, item.title, item.pages ?? 0)}</span>
                          <time>{relativeTime(item.updatedAt)}</time>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <h2>{t("For me")}</h2>
              <Filter label={t("Filter notifications")} value={filter} items={FILTERS} onChange={setFilter} />
              {notifications.length === 0 ? <EmptyState>{filter === "unread" ? t("No unread notifications.") : t("No notifications yet.")}</EmptyState> : (
                <ul className="pd-notices">
                  {notifications.map(item => (
                    <li key={item.id}>
                      <Link href={item.changeSetId ? `${spaceManageRoute(item.spaceSlug, "change-sets")}?id=${item.changeSetId}` : `${documentRoute(item.spaceSlug, item.documentPath)}${item.threadId ? `?thread=${item.threadId}` : ""}`} className={clsx("pd-notice-row", !item.readAt && "pd-notice-row--unread")}
                        onClick={() => { if (!item.readAt) void markRead([item.id]); }}>
                        <span>{noticeText(item)}</span>
                        <time>{relativeTime(item.createdAt)}</time>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
        }}
      </LoadedContent>
      <Following />
    </>
  );
}
