import * as React from "react";
import { FilePenLine, MessageSquare } from "lucide-react";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import { atLeast } from "../types";
import { Composer } from "./composer";
import { openPanel, submitDocumentComment, useAnnotations } from "./store";
import { ThreadCard } from "./thread-card";
import { Avatar } from "../ui/avatar";
import { askToSignIn, isVisitor } from "../theme/sign-in";
import { Tip } from "../ui/tooltip";
import { t } from "../i18n";

/** Where the box to write in would be, for a visitor: the discussion itself is for people who are signed in. */
function VisitorComments() {
  return (
    <section className="pd-doc-comments rp-not-doc" aria-label={t("Comment on the page")}>
      <h2>{t("Comment on the page")}</h2>
      <button
        type="button"
        className="pd-doc-comments__sign-in"
        onClick={() => askToSignIn({ reason: t("Sign in to comment on this page.") })}
      >
        {t("Sign in to comment")}
      </button>
    </section>
  );
}

/** Comments on the page as a whole, under its content. */
export function DocComments() {
  const page = useAppPage();
  const { threads } = useAnnotations();
  const [replying, setReplying] = React.useState<string | null>(null);
  if (page?.kind !== "document" || page.translation?.exists) return null;
  if (app.bootstrap.me.anonymous) return isVisitor() ? <VisitorComments /> : null;
  const role = page.view.role;
  const canComment = atLeast(role, "commenter");
  const own = threads.filter(thread => thread.anchor.kind === "document" && thread.status === "open");
  if (!canComment && own.length === 0) return null;
  const { me } = app.bootstrap;
  return (
    <section className="pd-doc-comments rp-not-doc" aria-label={t("Comment on the page")}>
      <h2>
        {t("Comment on the page")}
        {own.length > 0 ? <span>{own.length}</span> : null}
      </h2>
      <div className="pd-doc-comments__list">
        {/* Replying happens right here, so a comment on the whole page does not need the side panel. */}
        {own.map(thread => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            active={thread.id === replying}
            role={role}
            onSelect={() => setReplying(thread.id)}
          />
        ))}
      </div>
      {canComment ? (
        <div className="pd-doc-comments__row">
          <Avatar id={me.id} name={me.displayName} />
          <Composer placeholder={t("Say something about the whole page")} onSubmit={submitDocumentComment} />
        </div>
      ) : null}
    </section>
  );
}

/** Only when there is something to decide, since what is waiting for a person should not take finding. */
export function SuggestionsButton() {
  const { proposals } = useAnnotations();
  const count = proposals.filter(proposal => proposal.status === "pending").length;
  if (count === 0) return null;
  return (
    <Tip label={t("Suggestions")}>
      <button
        type="button"
        className="rp-llms-button pd-action pd-action--suggestions"
        aria-label={t("Suggestions {0}", count)}
        onClick={() => openPanel("proposals")}
      >
        <FilePenLine size={16} aria-hidden="true" />
        <span className="pd-action__label">{t("Suggestions")}</span>
        {count}
      </button>
    </Tip>
  );
}

export function CommentsButton() {
  const { threads } = useAnnotations();
  const count = threads.filter(thread => thread.status === "open").length;
  return (
    <Tip label={t("Comments")}>
      <button
        type="button"
        className="rp-llms-button pd-action"
        aria-label={t("Comments{0}", count > 0 ? ` ${count}` : "")}
        onClick={() => openPanel()}
      >
        <MessageSquare size={16} aria-hidden="true" />
        <span className="pd-action__label">{t("Comments")}</span>
        {count > 0 ? count : null}
      </button>
    </Tip>
  );
}
