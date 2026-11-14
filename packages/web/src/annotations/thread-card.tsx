import * as React from "react";
import clsx from "clsx";
import { Bot, Check, Link2, MoreHorizontal, Pencil, RotateCcw, SmilePlus, Trash2 } from "lucide-react";
import { Tip } from "../ui/tooltip";
import { Menu } from "../ui/menu";
import copy from "copy-to-clipboard";
import type { Anchor } from "@pandocs/markdown";
import { failureMessage } from "../api/client";
import { app } from "../data/runtime-data";
import { atLeast, channelLabel, type CommentView, type Role, type ThreadView } from "../types";
import { confirm } from "../ui/confirm";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { Composer, EmojiPicker } from "./composer";
import { activateThread, deleteComment, editComment, reactToComment, replyToThread, setThreadStatus } from "./store";
import { SuggestFromThread } from "./thread-suggestion";
import { Avatar } from "../ui/avatar";
import { t } from "../i18n";

/** Stops before Chinese and at punctuation that usually closes a sentence, not the address. */
const ADDRESS =
  /(https?:\/\/[^\s\u3000-\u303f\u4e00-\u9fff\uff00-\uffef<>"']+[^\s\u3000-\u303f\u4e00-\u9fff\uff00-\uffef<>"'.,;:!?)\]])/gu;

function withLinks(text: string): React.ReactNode[] {
  return text.split(ADDRESS).map((part, index) =>
    index % 2 === 1 ? (
      <a key={index} className="rp-link" href={part} target="_blank" rel="noopener noreferrer nofollow">
        {part}
      </a>
    ) : (
      part
    )
  );
}

/** Mentions read as names and addresses as links; everything else stays plain text, so a comment can never inject markup. */
function CommentBody({ comment }: { comment: CommentView }) {
  const names = (comment.mentions ?? []).map(person => `@${person.name}`).sort((a, b) => b.length - a.length);
  if (names.length === 0) return <p>{withLinks(comment.body)}</p>;
  const pattern = new RegExp(`(${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})`, "u");
  return (
    <p>
      {comment.body.split(pattern).map((part, index) =>
        names.includes(part) ? (
          <span key={index} className="pd-mention">
            {part}
          </span>
        ) : (
          <React.Fragment key={index}>{withLinks(part)}</React.Fragment>
        )
      )}
    </p>
  );
}

function act(work: () => Promise<unknown>): void {
  work().catch(error => toast(failureMessage(error), "error"));
}

function CommentItem({ comment, role }: { comment: CommentView; role: Role }) {
  const { me } = app.bootstrap;
  const [editing, setEditing] = React.useState(false);
  const canReact = atLeast(role, "commenter");
  const own = comment.authorId === me.id;
  const canDelete = canReact && (own || atLeast(role, "admin"));
  if (editing) {
    return (
      <div className="pd-comment">
        <Avatar id={comment.authorId} name={comment.authorName} />
        <div className="pd-comment__main">
          <Composer
            autoFocus
            placeholder={t("Edit comment")}
            submitLabel={t("Save")}
            initial={comment.body}
            initialMentions={comment.mentions ?? []}
            onCancel={() => setEditing(false)}
            onSubmit={async (body, mentions) => {
              await editComment(comment.id, body, mentions);
              setEditing(false);
            }}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="pd-comment">
      <Avatar id={comment.authorId} name={comment.authorName} />
      <div className="pd-comment__main">
        <div className="pd-comment__head">
          <strong>{comment.authorName}</strong>
          {comment.authorKind === "agent" ? <Bot size={13} aria-label={t("Agent")} /> : null}
          <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>
            {relativeTime(comment.createdAt)}
          </time>
          {comment.editedAt ? <span className="pd-comment__note">{t("Edited")}</span> : null}
          {comment.channel !== "web" ? (
            <span className="pd-comment__note">{t("via {0}", channelLabel(comment.channel))}</span>
          ) : null}
          <span className="pd-comment__tools">
            {canReact ? (
              <EmojiPicker
                label={t("Add reaction")}
                onPick={emoji => act(() => reactToComment(comment.id, emoji, true))}
              >
                <SmilePlus size={14} aria-hidden="true" />
              </EmojiPicker>
            ) : null}
            {own ? (
              <Tip label={t("Edit")}>
                <button
                  type="button"
                  className="pd-icon-button pd-icon-button--small"
                  aria-label={t("Edit this comment")}
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              </Tip>
            ) : null}
            {canDelete ? (
              <Tip label={t("Delete")}>
                <button
                  type="button"
                  className="pd-icon-button pd-icon-button--small"
                  aria-label={t("Delete this comment")}
                  onClick={() =>
                    void confirm({
                      title: t("Delete this comment?"),
                      description: t("This cannot be undone."),
                      action: t("Delete"),
                      danger: true
                    }).then(yes => {
                      if (yes) act(() => deleteComment(comment.id));
                    })
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </Tip>
            ) : null}
          </span>
        </div>
        <CommentBody comment={comment} />
        {comment.reactions?.length ? (
          <div className="pd-reactions">
            {comment.reactions.map(reaction => (
              <button
                type="button"
                key={reaction.emoji}
                disabled={!canReact}
                aria-pressed={reaction.mine}
                className={clsx("pd-reaction", reaction.mine && "pd-reaction--mine")}
                onClick={() => act(() => reactToComment(comment.id, reaction.emoji, !reaction.mine))}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const STATE_NOTES: Readonly<Record<string, string>> = {
  fuzzy: t("The text has changed, so this may have moved"),
  orphaned: t("The text is gone")
};

export function quoteOf(anchor: Anchor): string | null {
  if (anchor.kind === "text") return anchor.exact;
  if (anchor.kind === "block") return anchor.preview || t("This block");
  return null;
}

export function threadUrl(threadId: string): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("thread", threadId);
  return url.toString();
}

export function ThreadCard({
  thread,
  active,
  role,
  onSelect
}: {
  thread: ThreadView;
  active: boolean;
  role: Role;
  onSelect?: () => void;
}) {
  const canComment = atLeast(role, "commenter");
  const quote = quoteOf(thread.anchor);
  const note = thread.status === "open" ? STATE_NOTES[thread.anchorState] : undefined;
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <article
      ref={ref}
      className={clsx("pd-card", active && "pd-card--active", thread.status === "resolved" && "pd-card--resolved")}
      aria-current={active ? "true" : undefined}
      onClick={() => {
        if (!active) (onSelect ?? (() => activateThread(thread.id)))();
      }}
    >
      <div className="pd-card__head">
        {quote ? <blockquote>{quote}</blockquote> : <span className="pd-card__scope">{t("Comment on the page")}</span>}
        <div className="pd-card__tools">
          {canComment ? (
            thread.status === "open" ? (
              <Tip label={t("Resolve")}>
                <button
                  type="button"
                  className="pd-icon-button pd-icon-button--small"
                  aria-label={t("Resolve this discussion")}
                  onClick={event => {
                    event.stopPropagation();
                    act(() => setThreadStatus(thread.id, "resolved"));
                  }}
                >
                  <Check size={15} aria-hidden="true" />
                </button>
              </Tip>
            ) : (
              <Tip label={t("Reopen")}>
                <button
                  type="button"
                  className="pd-icon-button pd-icon-button--small"
                  aria-label={t("Reopen this discussion")}
                  onClick={event => {
                    event.stopPropagation();
                    act(() => setThreadStatus(thread.id, "open"));
                  }}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                </button>
              </Tip>
            )
          ) : null}
          <Menu.Root>
            <Menu.Trigger
              className="pd-icon-button pd-icon-button--small"
              aria-label={t("More")}
              onClick={event => event.stopPropagation()}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Content align="end" sideOffset={4}>
              <Menu.Item
                onClick={() => {
                  copy(threadUrl(thread.id));
                  toast(t("Discussion link copied"));
                }}
              >
                <Link2 size={15} aria-hidden="true" />
                {t("Copy discussion link")}
              </Menu.Item>
            </Menu.Content>
          </Menu.Root>
        </div>
      </div>
      {note ? <p className="pd-card__note">{note}</p> : null}
      {thread.comments.map(comment => (
        <CommentItem key={comment.id} comment={comment} role={role} />
      ))}
      {thread.status === "resolved" && thread.resolvedName ? (
        <p className="pd-card__note">{t("Resolved by {0}", thread.resolvedName)}</p>
      ) : null}
      {active &&
      canComment &&
      app.bootstrap.ai?.configured &&
      thread.status === "open" &&
      thread.anchorState !== "orphaned" ? (
        <SuggestFromThread thread={thread} />
      ) : null}
      {active && canComment && thread.status === "open" ? (
        <Composer placeholder={t("Reply…")} onSubmit={(body, mentions) => replyToThread(thread.id, body, mentions)} />
      ) : null}
    </article>
  );
}
