import * as React from "react";
import clsx from "clsx";
import { Bot } from "lucide-react";
import { Link } from "@rspress/core/theme";
import { useNavigate, useSearchParams } from "@rspress/core/runtime";
import { Button } from "@/components/ui/button";
import { Filter } from "../ui/filter";
import { NumberInput, SearchSelectField, SwitchField, TextField, TextareaField } from "../ui/form";
import { api, failureMessage } from "../api/client";
import { spaceManageRoute } from "../data/manage";
import { pageUrl } from "../data/paths";
import { RenderedDiff } from "../review/rendered-diff";
import type { ChangeSetDetail, ChangeSetPage, ChangeSetSummary, DocumentView, Space, TreeEntry } from "../types";
import { confirm } from "../ui/confirm";
import { FormDialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

const FILTERS = (): readonly { readonly value: ChangeSetSummary["status"]; readonly label: string }[] => [
  { value: "open", label: t("Open") },
  { value: "merged", label: t("Merged") },
  { value: "closed", label: t("Closed") }
];

const statusClass = (status: ChangeSetSummary["status"]) =>
  clsx("pd-status", status === "merged" && "pd-status--done", status === "closed" && "pd-status--failed");
const statusText = (status: ChangeSetSummary["status"]) => FILTERS().find(item => item.value === status)!.label;

function NewChangeSetDialog({
  space,
  onClose,
  onMade
}: {
  space: Space;
  onClose: () => void;
  onMade: (id: string) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const create = async () => {
    onMade(
      (
        await api.send<{ id: string }>("POST", `spaces/${space.slug}/change-sets`, {
          body: { title: title.trim(), description }
        })
      ).id
    );
  };
  return (
    <FormDialog title={t("New change set")} onClose={onClose} action={t("Create")} onSubmit={create}>
      <TextField
        name="title"
        label={t("Title")}
        required
        autoFocus
        maxLength={200}
        value={title}
        onChange={event => setTitle(event.target.value)}
      />
      <TextareaField
        label={t("What this changes and why (optional)")}
        rows={3}
        maxLength={4000}
        value={description}
        onChange={event => setDescription(event.target.value)}
      />
    </FormDialog>
  );
}

function ChangeSetList({ space }: { space: Space }) {
  const [, setParams] = useSearchParams();
  const [status, setStatus] = React.useState<ChangeSetSummary["status"]>("open");
  const [creating, setCreating] = React.useState(false);
  const sets = useLoaded(
    () => api.get<ChangeSetSummary[]>(`spaces/${space.slug}/change-sets?status=${status}`),
    [space.slug, status]
  );
  const route = spaceManageRoute(space.slug, "change-sets");
  return (
    <>
      <ManageHead
        title={t("Change sets")}
        description={t("Changes to several pages, reviewed together, that land together or not at all.")}
      >
        <Button onClick={() => setCreating(true)}>{t("New change set")}</Button>
      </ManageHead>
      <Filter label={t("Filter change sets")} value={status} items={FILTERS()} onChange={setStatus} />
      <LoadedContent loaded={sets}>
        {data =>
          data.length === 0 ? (
            <EmptyState>{t("No change sets here.")}</EmptyState>
          ) : (
            <ul className="pd-notices">
              {data.map(item => (
                <li key={item.id}>
                  <Link href={`${route}?id=${item.id}`} className="pd-notice-row">
                    <span>
                      {item.title} {item.authorKind === "agent" ? <Bot size={13} aria-label={t("Agent")} /> : null}
                      <span className="pd-muted">
                        {" "}
                        · {t("{0} {0|page|pages}", item.pages ?? 0)}
                        {status === "open" ? ` · ${t("{0} {0|approval|approvals}", item.approvals ?? 0)}` : ""}
                      </span>
                    </span>
                    <time>
                      {item.authorName} · {relativeTime(item.updatedAt)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </LoadedContent>
      {creating ? (
        <NewChangeSetDialog space={space} onClose={() => setCreating(false)} onMade={id => setParams({ id })} />
      ) : null}
    </>
  );
}

type PageDialogMode =
  | { readonly kind: "new" }
  | { readonly kind: "change" }
  | { readonly kind: "delete" }
  | { readonly kind: "text"; readonly page: ChangeSetPage };

/** For what is easier to say here than from the page's own editor: a page that does not exist yet, one to delete, or a change to the text. */
function PageDialog({
  detail,
  space,
  mode,
  onClose,
  onDone
}: {
  detail: ChangeSetDetail;
  space: Space;
  mode: PageDialogMode;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = React.useState(mode.kind === "text" ? mode.page.title : "");
  const [path, setPath] = React.useState("");
  const [markdown, setMarkdown] = React.useState(mode.kind === "text" ? mode.page.proposedMarkdown : "");
  const [document, setDocument] = React.useState("");
  const [view, setView] = React.useState<DocumentView | null>(null);
  const tree = useLoaded(
    () =>
      mode.kind === "change" || mode.kind === "delete"
        ? api.get<TreeEntry[]>(`spaces/${space.slug}/tree`)
        : Promise.resolve([]),
    [space.slug, mode.kind]
  );
  const pick = async (id: string) => {
    setDocument(id);
    setView(null);
    if (!id) return;
    try {
      const found = await api.get<DocumentView>(`documents/${id}`);
      setView(found);
      setMarkdown(found.markdown ?? "");
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const body = (): object => {
    if (mode.kind === "new") return { path: path.trim(), title: title.trim(), markdown };
    if (mode.kind === "delete") return { document, baseRevision: view!.revision.no, delete: true };
    if (mode.kind === "change") return { document, baseRevision: view!.revision.no, markdown };
    return mode.page.kind === "create"
      ? { path: mode.page.path, title: title.trim(), markdown }
      : { document: mode.page.documentId, baseRevision: mode.page.baseRevisionNo, markdown };
  };
  const save = async () => {
    await api.send("POST", `change-sets/${detail.id}/pages`, { body: body() });
    onDone();
  };
  const heading = {
    new: t("Add a new page"),
    change: t("Change a page"),
    delete: t("Delete a page"),
    text: t("Edit the text")
  }[mode.kind];
  const ready =
    mode.kind === "new" ? Boolean(path.trim() && title.trim()) : mode.kind === "text" ? true : view !== null;
  const entries = tree.status === "ready" ? tree.data : [];
  return (
    <FormDialog
      wide
      title={heading}
      onClose={onClose}
      action={t("Add to the change set")}
      disabled={!ready}
      onSubmit={save}
    >
      {mode.kind === "new" ? (
        <>
          <TextField label={t("Title")} autoFocus value={title} onChange={event => setTitle(event.target.value)} />
          <TextField
            label={t("Address")}
            description={t("With any pages above it. They have to exist, or be in this change set too.")}
            value={path}
            placeholder="guides/returns"
            onChange={event => setPath(event.target.value)}
          />
        </>
      ) : null}
      {mode.kind === "change" || mode.kind === "delete" ? (
        <SearchSelectField
          label={t("Page")}
          value={document}
          onChange={value => void pick(value)}
          choices={[
            { value: "", label: t("Choose a page") },
            ...entries.map(entry => ({ value: entry.id, label: entry.path }))
          ]}
        />
      ) : null}
      {mode.kind === "delete" ? null : (
        <TextareaField
          label={t("Text")}
          mono
          rows={14}
          spellCheck={false}
          value={markdown}
          onChange={event => setMarkdown(event.target.value)}
        />
      )}
    </FormDialog>
  );
}

function PageChange({
  detail,
  page,
  space,
  onEdit,
  onRemoved
}: {
  detail: ChangeSetDetail;
  page: ChangeSetPage;
  space: Space;
  onEdit: () => void;
  onRemoved: () => void;
}) {
  const reader = React.useMemo(
    () => ({ space, currentPath: page.path, routePrefix: "", children: [] }),
    [space, page.path]
  );
  const remove = async () => {
    try {
      await api.send("DELETE", `change-sets/${detail.id}/pages/${page.id}`);
      onRemoved();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const kind = { edit: t("Changed"), create: t("New"), delete: t("Deleted"), restore: t("Back from the trash") }[
    page.kind
  ];
  const moved = page.kind === "edit" && page.currentRevisionNo !== page.baseRevisionNo;
  return (
    <details className="pd-change-set__page" open>
      <summary>
        <span
          className={clsx(
            "pd-status",
            (page.kind === "create" || page.kind === "restore") && "pd-status--done",
            page.kind === "delete" && "pd-status--failed"
          )}
        >
          {kind}
        </span>
        <strong>{page.title}</strong> <span className="pd-muted">{page.path}</span>
        {moved ? (
          <span className="pd-muted"> · {t("The page has changed since. Merging combines the two.")}</span>
        ) : null}
        {detail.canChange ? (
          <span className="pd-change-set__page-actions">
            {page.kind === "delete" || page.kind === "restore" ? null : (
              <Button
                variant="outline"
                onClick={event => {
                  event.preventDefault();
                  onEdit();
                }}
              >
                {t("Edit the text")}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={event => {
                event.preventDefault();
                void remove();
              }}
            >
              {t("Remove")}
            </Button>
          </span>
        ) : null}
      </summary>
      <div className="rp-doc rspress-doc">
        <RenderedDiff
          before={page.baseMarkdown}
          after={page.kind === "delete" ? "" : page.proposedMarkdown}
          reader={reader}
        />
      </div>
    </details>
  );
}

/** Taking back one that never landed, for whoever made it and those who run the space. */
function DeleteChangeSet({ space, detail }: { space: Space; detail: ChangeSetDetail }) {
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);
  const remove = async () => {
    if (
      !(await confirm({
        title: t('Delete "{0}"?', detail.title),
        description: t("What it would change and its reviews go with it, and it cannot be brought back."),
        action: t("Delete"),
        danger: true
      }))
    )
      return;
    setBusy(true);
    try {
      await api.send("DELETE", `change-sets/${detail.id}`);
      toast(t("Change set deleted"), "success");
      navigate(spaceManageRoute(space.slug, "change-sets"));
    } catch (error) {
      toast(failureMessage(error), "error");
      setBusy(false);
    }
  };
  return (
    <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
      {t("Delete change set")}
    </Button>
  );
}

function ChangeSetView({ space, id }: { space: Space; id: string }) {
  const detail = useLoaded(() => api.get<ChangeSetDetail>(`change-sets/${id}`), [id]);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [dialog, setDialog] = React.useState<PageDialogMode | null>(null);
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done) toast(done, "success");
      setNote("");
      detail.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const merge = async () => {
    setBusy(true);
    try {
      await api.send("POST", `change-sets/${id}/merge`);
      // New pages are only known to the navigation once the app has loaded again.
      location.assign(pageUrl(`${spaceManageRoute(space.slug, "change-sets")}?id=${id}`));
    } catch (error) {
      toast(failureMessage(error), "error");
      setBusy(false);
      detail.reload();
    }
  };
  return (
    <LoadedContent loaded={detail}>
      {data => (
        <div className="pd-change-set">
          <ManageHead title={data.title} description={data.description || undefined}>
            <Link href={spaceManageRoute(space.slug, "change-sets")} className="pd-btn">
              {t("All change sets")}
            </Link>
          </ManageHead>
          <p className="pd-muted pd-change-set__byline">
            <span className={statusClass(data.status)}>{statusText(data.status)}</span>{" "}
            {data.authorKind === "agent" ? <Bot size={13} aria-label={t("Agent")} /> : null} {data.authorName} ·{" "}
            {relativeTime(data.createdAt)}
            {data.decidedName
              ? ` · ${data.status === "merged" ? t("Merged by {0}", data.decidedName) : t("Closed by {0}", data.decidedName)}`
              : ""}
          </p>
          {data.blockers.length > 0 ? (
            <ul className="pd-change-set__blockers">
              {data.blockers.map((blocker, at) => (
                <li key={at}>{blocker.path ? t("{0}: {1}", blocker.path, blocker.message) : blocker.message}</li>
              ))}
            </ul>
          ) : null}
          {data.hiddenPages > 0 ? (
            <p className="pd-proposal__stale">
              {t("It also changes {0} {0|page|pages} you cannot read, so you cannot merge it.", data.hiddenPages)}
            </p>
          ) : null}
          {data.reviews.length > 0 ? (
            <ul className="pd-change-set__reviews">
              {data.reviews.map((review, at) => (
                <li key={at} className={clsx(review.stale && "pd-muted")}>
                  <strong>{review.reviewerName}</strong>{" "}
                  {review.verdict === "approved" ? t("approved") : t("asked for changes")}
                  {review.stale ? ` ${t("(before later changes)")}` : ""}
                  {review.note ? <p>{review.note}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {data.canReview ? (
            <div className="pd-change-set__review">
              <TextareaField
                label={t("Your review (optional)")}
                rows={2}
                maxLength={2000}
                value={note}
                onChange={event => setNote(event.target.value)}
              />
              <div className="pd-change-set__buttons">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api.send("POST", `change-sets/${id}/reviews`, { body: { verdict: "changes_requested", note } })
                    )
                  }
                >
                  {t("Ask for changes")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api.send("POST", `change-sets/${id}/reviews`, { body: { verdict: "approved", note } })
                    )
                  }
                >
                  {t("Approve")}
                </Button>
              </div>
            </div>
          ) : null}
          {data.status === "open" ? (
            <div className="pd-change-set__buttons">
              {data.canChange ? (
                <>
                  <Button variant="outline" onClick={() => setDialog({ kind: "change" })}>
                    {t("Change a page")}
                  </Button>
                  <Button variant="outline" onClick={() => setDialog({ kind: "new" })}>
                    {t("Add a new page")}
                  </Button>
                  <Button variant="outline" onClick={() => setDialog({ kind: "delete" })}>
                    {t("Delete a page")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void act(() => api.send("POST", `change-sets/${id}/close`))}
                  >
                    {t("Close")}
                  </Button>
                </>
              ) : null}
              <Button disabled={busy || !data.canMerge} onClick={() => void merge()}>
                {t("Merge")}
              </Button>
              {data.canDelete ? <DeleteChangeSet space={space} detail={data} /> : null}
            </div>
          ) : data.status === "closed" && data.canChange !== undefined ? (
            <div className="pd-change-set__buttons">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => api.send("POST", `change-sets/${id}/reopen`))}
              >
                {t("Reopen")}
              </Button>
              {data.canDelete ? <DeleteChangeSet space={space} detail={data} /> : null}
            </div>
          ) : null}
          {data.pages.length === 0 ? (
            <EmptyState>
              {t("No pages in it yet. Add one here, or choose this change set when you finish editing a page.")}
            </EmptyState>
          ) : (
            data.pages.map(page => (
              <PageChange
                key={page.id}
                detail={data}
                page={page}
                space={space}
                onEdit={() => setDialog({ kind: "text", page })}
                onRemoved={detail.reload}
              />
            ))
          )}
          {dialog ? (
            <PageDialog
              detail={data}
              space={space}
              mode={dialog}
              onClose={() => setDialog(null)}
              onDone={() => {
                setDialog(null);
                detail.reload();
              }}
            />
          ) : null}
        </div>
      )}
    </LoadedContent>
  );
}

export function ChangeSetsView({ space }: { space: Space }) {
  const [params] = useSearchParams();
  const id = params.get("id");
  return id ? <ChangeSetView key={id} space={space} id={id} /> : <ChangeSetList space={space} />;
}

/** What it takes for changes to land here. Only those who run the space decide that. */
export function MergeRulesSection({ space }: { space: Space }) {
  const [approvals, setApprovals] = React.useState(space.mergeRules?.requiredApprovals ?? 0);
  const [required, setRequired] = React.useState(space.mergeRules?.requireChangeSets ?? false);
  const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.send("PATCH", `spaces/${space.slug}`, {
        body: { mergeRules: { requiredApprovals: approvals, requireChangeSets: required } }
      });
      location.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
      setBusy(false);
    }
  };
  const unchanged =
    approvals === (space.mergeRules?.requiredApprovals ?? 0) &&
    required === (space.mergeRules?.requireChangeSets ?? false);
  return (
    <section className="pd-form pd-merge-rules">
      <h2>{t("Reviewing changes")}</h2>
      <NumberInput
        label={t("Approvals a change set needs")}
        description={t(
          "From people who can edit this space, other than whoever wrote it. Changing a change set means reviewing it again."
        )}
        min={0}
        max={10}
        value={approvals}
        onChange={value => setApprovals(value ?? 0)}
      />
      <SwitchField
        label={t("Changes only go through review: nobody saves, moves or deletes a page directly")}
        description={t(
          "Nor renames, reorders or restores one from the trash. Labels, translations, the glossary and comments do not change what a page says, so they are not held back."
        )}
        checked={required}
        onChange={setRequired}
      />
      <div>
        <Button disabled={busy || unchanged} onClick={() => void save()}>
          {t("Save")}
        </Button>
      </div>
    </section>
  );
}
