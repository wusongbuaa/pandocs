import * as React from "react";
import { SearchSelectField, SelectField, SwitchField, TextField } from "../ui/form";
import { api, failureMessage, type ApiError } from "../api/client";
import { slugForNewPage } from "../data/paths";
import type { PageTemplate, Space, TreeEntry } from "../types";
import { Dialog, FormDialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { MemberEditor } from "./member-editor";
import { pageChoices } from "./parts";
import { t } from "../i18n";

const TOP_LEVEL = "";

function ParentField({ label, tree, value, onChange, excluding }: { label: string; tree: readonly TreeEntry[]; value: string; onChange: (value: string) => void; excluding?: TreeEntry }) {
  const options = tree.filter(entry => !excluding || (entry.id !== excluding.id && !entry.path.startsWith(`${excluding.path}/`)));
  return <SearchSelectField label={label} value={value} onChange={onChange} choices={pageChoices(options, { value: TOP_LEVEL, label: t("Top level") })} />;
}

const withSlug = (slug: string | undefined) => (slug ? { slug } : {});

const slugProblem = (error: ApiError) => (error.code === "DOCUMENT_PATH_TAKEN" || error.code === "SLUG_INVALID" ? "slug" : undefined);

export function NewPageDialog({ space, tree, parent, onClose, onCreated }: { space: Pick<Space, "slug">; tree: readonly TreeEntry[]; parent: TreeEntry | null; onClose: () => void; onCreated: (path: string) => void }) {
  const [title, setTitle] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [parentId, setParentId] = React.useState(parent?.id ?? TOP_LEVEL);
  const [template, setTemplate] = React.useState("");
  const templates = useLoaded(() => api.get<PageTemplate[]>(`spaces/${space.slug}/templates`), [space.slug]);
  const submit = async () => {
    const parentPath = tree.find(entry => entry.id === parentId)?.path;
    const created = await api.send<{ document: { path: string } }>("POST", `spaces/${space.slug}/documents`, { body: { title: title.trim(), markdown: "", ...(template ? { template } : {}), ...(parentPath ? { parentPath } : {}), ...withSlug(slug.trim() || slugForNewPage(title)) } });
    onCreated(created.document.path);
  };
  return (
    <FormDialog title={t("New page")} action={t("Create")} onClose={onClose} onSubmit={submit} fieldFor={slugProblem}>
      <TextField name="title" label={t("Title")} required autoFocus value={title} onChange={event => setTitle(event.target.value)} />
      <ParentField label={t("Place under")} tree={tree} value={parentId} onChange={setParentId} />
      <SelectField label={t("Start from")} value={template} onChange={setTemplate} choices={[{ value: "", label: t("A blank page") }, ...(templates.status === "ready" ? templates.data : []).map(item => ({ value: item.id, label: item.name }))]} />
      <TextField name="slug" label={t("Address (optional)")} description={t("Left empty, one is generated. Titles that would make long links get a short one.")} value={slug} onChange={event => setSlug(event.target.value)} />
    </FormDialog>
  );
}

export function RenameDialog({ entry, onClose, onDone }: { entry: TreeEntry; onClose: () => void; onDone: (path: string) => void }) {
  const [title, setTitle] = React.useState(entry.title);
  const [slug, setSlug] = React.useState(entry.slug);
  const submit = async () => {
    // The address is what is likelier to be refused, as taken or held for review, so it goes first: a refusal then leaves both as they were.
    const moved = slug.trim() !== entry.slug ? await api.send<{ path: string }>("POST", `documents/${entry.id}/move`, { body: { slug: slug.trim() } }) : null;
    if (title.trim() !== entry.title) await api.send("PATCH", `documents/${entry.id}`, { body: { title: title.trim() } });
    onDone(moved?.path ?? entry.path);
  };
  return (
    <FormDialog title={t("Rename")} action={t("Save")} onClose={onClose} onSubmit={submit} fieldFor={slugProblem}>
      <TextField name="title" label={t("Title")} required autoFocus value={title} onChange={event => setTitle(event.target.value)} />
      <TextField name="slug" label={t("Address")} required pattern={"[^/\\s]+"} data-problem={t("An address has no slashes or spaces")} description={t("After changing the address, old links redirect to the new one.")} value={slug} onChange={event => setSlug(event.target.value)} />
    </FormDialog>
  );
}

export function MoveDialog({ tree, entry, onClose, onDone }: { tree: readonly TreeEntry[]; entry: TreeEntry; onClose: () => void; onDone: (path: string) => void }) {
  const [parentId, setParentId] = React.useState(entry.parentId ?? TOP_LEVEL);
  const [beforeId, setBeforeId] = React.useState(TOP_LEVEL);
  const siblings = tree.filter(item => (item.parentId ?? TOP_LEVEL) === parentId && item.id !== entry.id);
  const submit = async () => {
    const moved = await api.send<{ path: string }>("POST", `documents/${entry.id}/move`, { body: { parentId: parentId || null, beforeId: beforeId || null } });
    onDone(moved.path);
  };
  return (
    <FormDialog title={t("Move \"{0}\"", entry.title)} description={t("Subpages move with it, and old links redirect to the new address.")} action={t("Move")} onClose={onClose} onSubmit={submit}>
      <ParentField label={t("Move to")} tree={tree} value={parentId} excluding={entry} onChange={value => { setParentId(value); setBeforeId(TOP_LEVEL); }} />
      <SelectField label={t("Position")} value={beforeId} onChange={setBeforeId} choices={[{ value: TOP_LEVEL, label: t("Last") }, ...siblings.map(item => ({ value: item.id, label: t("Before \"{0}\"", item.title) }))]} />
    </FormDialog>
  );
}

export function PermissionDialog({ entry, onClose, onChanged }: { entry: TreeEntry; onClose: () => void; onChanged: () => void }) {
  const [restricted, setRestricted] = React.useState(entry.restricted);
  const toggle = async (next: boolean) => {
    setRestricted(next);
    try {
      await api.send("PATCH", `documents/${entry.id}`, { body: { restricted: next } });
      onChanged();
    } catch (error) {
      setRestricted(!next);
      toast(failureMessage(error), "error");
    }
  };
  return (
    <Dialog title={t("Permissions for \"{0}\"", entry.title)} wide onClose={onClose}>
      <SwitchField label={t("Restricted: only the members below and space administrators can see it")} checked={restricted} onChange={on => void toggle(on)} />
      {restricted ? <MemberEditor path={`documents/${entry.id}/members`} /> : null}
    </Dialog>
  );
}
