import * as React from "react";
import clsx from "clsx";
import { Bell } from "lucide-react";
import { Popover } from "../ui/popover";
import { Link } from "@rspress/core/theme";
import { api, failureMessage } from "../api/client";
import { manageRoute, spaceManageRoute } from "../data/manage";
import { documentRoute } from "../data/paths";
import type { InboxView } from "../types";
import { noticeText } from "../ui/notice-text";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { t } from "../i18n";

/** "Related to me" from any page. There is no push channel, so it refreshes when the tab comes back into focus. */
export function NavInbox() {
  const [inbox, setInbox] = React.useState<InboxView | null>(null);
  const [open, setOpen] = React.useState(false);
  const load = React.useCallback(() => {
    api.get<InboxView>("me/inbox").then(setInbox, () => undefined);
  }, []);
  React.useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  const unread = inbox?.notifications.filter(item => !item.readAt).length ?? 0;
  const waiting = unread + (inbox?.proposals.length ?? 0) + (inbox?.changeSets.length ?? 0);
  const markAllRead = () => api.send("POST", "me/inbox/read", { body: { ids: "all" } }).then(load, error => toast(failureMessage(error), "error"));
  const empty = inbox && inbox.notifications.length === 0 && inbox.proposals.length === 0 && inbox.changeSets.length === 0;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="pd-nav-icon" aria-label={waiting > 0 ? t("For me, {0} waiting", waiting) : t("For me")} title={t("For me")}>
        <Bell size={20} aria-hidden="true" />
        {waiting > 0 ? <span className="pd-nav-dot" /> : null}
      </Popover.Trigger>
      <Popover.Content className="pd-inbox" align="end" sideOffset={10}>
        <header className="pd-inbox__head">
          <strong>{t("For me")}</strong>
          <span className="pd-inbox__head-actions">
            {unread > 0 ? <button type="button" className="pd-link-button" onClick={() => void markAllRead()}>{t("All read")}</button> : null}
            <Link href={manageRoute("inbox")} className="pd-link-button" onClick={() => setOpen(false)}>{t("See all")}</Link>
          </span>
        </header>
        {empty ? <p className="pd-inbox__empty">{t("Nothing waiting for you")}</p> : null}
        <ul className="pd-inbox__list rp-scrollbar">
          {inbox?.proposals.map(item => (
            <li key={item.id}>
              <Link href={`${documentRoute(item.spaceSlug, item.documentPath)}?proposal=${item.id}`} className="pd-inbox__item" onClick={() => setOpen(false)}>
                <span className="pd-inbox__badge">{t("Pending")}</span>
                <span>{t("{0} suggested a change to \"{1}\"", item.authorName, item.documentTitle)}</span>
                <time>{relativeTime(item.createdAt)}</time>
              </Link>
            </li>
          ))}
          {inbox?.changeSets.map(item => (
            <li key={item.id}>
              <Link href={`${spaceManageRoute(item.spaceSlug, "change-sets")}?id=${item.id}`} className="pd-inbox__item" onClick={() => setOpen(false)}>
                <span className="pd-inbox__badge">{t("Pending")}</span>
                <span>{t("{0} wants a review of \"{1}\": {2} {2|page|pages}", item.authorName, item.title, item.pages ?? 0)}</span>
                <time>{relativeTime(item.updatedAt)}</time>
              </Link>
            </li>
          ))}
          {inbox?.notifications.map(item => (
            <li key={item.id}>
              <Link href={item.changeSetId ? `${spaceManageRoute(item.spaceSlug, "change-sets")}?id=${item.changeSetId}` : `${documentRoute(item.spaceSlug, item.documentPath)}${item.threadId ? `?thread=${item.threadId}` : ""}`} className={clsx("pd-inbox__item", item.readAt && "pd-inbox__item--read")}
                onClick={() => {
                  setOpen(false);
                  if (!item.readAt) void api.send("POST", "me/inbox/read", { body: { ids: [item.id] } }).then(load);
                }}>
                <span>{noticeText(item)}</span>
                <time>{relativeTime(item.createdAt)}</time>
              </Link>
            </li>
          ))}
        </ul>
      </Popover.Content>
    </Popover.Root>
  );
}
