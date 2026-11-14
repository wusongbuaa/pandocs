import { t } from "../i18n";

const VERBS = (): Readonly<Record<string, string>> => ({
  mention: t("mentioned you"),
  reply: t("replied to a discussion"),
  feedback: t("gave feedback"),
  proposal_decided: t("decided on a suggestion"),
  page_updated: t("updated a page")
});

/** One line for a notification. A change saved with nothing to say about it has no summary. */
export function noticeText(item: {
  readonly kind: string;
  readonly actorName: string;
  readonly documentTitle: string;
  readonly summary: string;
}): string {
  const actor = item.actorName || t("A reader");
  // What happened to a change set is already worded, by whoever it happened through.
  if (item.kind === "change_set") return t('{0} {1} ("{2}")', actor, item.summary, item.documentTitle);
  const verb = VERBS()[item.kind] ?? t("has an update");
  return item.summary
    ? t('{0} {1} ("{2}"): {3}', actor, verb, item.documentTitle, item.summary)
    : t('{0} {1} ("{2}")', actor, verb, item.documentTitle);
}
