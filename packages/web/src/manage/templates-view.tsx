import * as React from "react";
import { Button } from "@/components/ui/button";
import { SearchSelectField, TextField, TextareaField } from "../ui/form";
import { api, failureMessage } from "../api/client";
import type { DocumentView, PageTemplate, Space, TreeEntry } from "../types";
import { confirm } from "../ui/confirm";
import { FormDialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead, pageChoices } from "./parts";
import { t } from "../i18n";

function TemplateDialog({ space, template, onClose, onSaved }: { space: Space; template: PageTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = React.useState(template?.name ?? "");
  const [description, setDescription] = React.useState(template?.description ?? "");
  const [markdown, setMarkdown] = React.useState(template?.markdown ?? "");
  const [source, setSource] = React.useState("");
  const pages = useLoaded(() => (template ? Promise.resolve([]) : api.get<TreeEntry[]>(`spaces/${space.slug}/tree`)), [space.slug, template]);
  const copyFrom = async (id: string) => {
    if (!id) return;
    try {
      setMarkdown((await api.get<DocumentView>(`documents/${id}`)).markdown ?? "");
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const save = async () => {
    const body = { name: name.trim(), description: description.trim(), markdown };
    await (template ? api.send("PATCH", `templates/${template.id}`, { body }) : api.send("POST", `spaces/${space.slug}/templates`, { body }));
    onSaved();
  };
  return (
    <FormDialog wide title={template ? t("Edit the template") : t("New template")} onClose={onClose} action={t("Save")} onSubmit={save}>
      <TextField name="name" label={t("Name")} required autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} />
      <TextField label={t("Description (optional)")} maxLength={300} value={description} onChange={event => setDescription(event.target.value)} />
      {template ? null : (
        <SearchSelectField label={t("Start from a page (optional)")} value={source} onChange={value => { setSource(value); void copyFrom(value); }} choices={pageChoices((pages.status === "ready" ? pages.data : []).filter(entry => entry.hasContent), { value: "", label: t("Choose a page") })} />
      )}
      <TextareaField label={t("Text")} description={t("{0} and {1} become the page's title and the day it is made.", "{{title}}", "{{date}}")} mono rows={14} spellCheck={false} value={markdown} onChange={event => setMarkdown(event.target.value)} />
    </FormDialog>
  );
}

/** What this space's new pages can start from, next to the ones that come with the product. */
export function TemplatesView({ space }: { space: Space }) {
  const templates = useLoaded(() => api.get<PageTemplate[]>(`spaces/${space.slug}/templates`), [space.slug]);
  const [editing, setEditing] = React.useState<PageTemplate | "new" | null>(null);
  const remove = async (template: PageTemplate) => {
    if (!await confirm({ title: t("Delete the template \"{0}\"?", template.name), description: t("Pages already made from it stay as they are."), action: t("Delete"), danger: true })) return;
    try {
      await api.send("DELETE", `templates/${template.id}`);
      templates.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  return (
    <>
      <ManageHead title={t("Templates")} description={t("What new pages in this space can start from.")}>
        <Button onClick={() => setEditing("new")}>{t("New template")}</Button>
      </ManageHead>
      <LoadedContent loaded={templates}>
        {data => {
          const own = data.filter(template => !template.builtIn);
          return (
            <>
              {own.length === 0 ? <EmptyState>{t("This space has no templates of its own yet.")}</EmptyState> : (
                <ul className="pd-templates">
                  {own.map(template => (
                    <li key={template.id}>
                      <div><strong>{template.name}</strong>{template.description ? <p className="pd-muted">{template.description}</p> : null}</div>
                      <span className="pd-templates__actions">
                        <Button variant="outline" onClick={() => setEditing(template)}>{t("Edit")}</Button>
                        <Button variant="outline" onClick={() => void remove(template)}>{t("Delete")}</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <h2>{t("Built in")}</h2>
              <ul className="pd-templates">
                {data.filter(template => template.builtIn).map(template => <li key={template.id}><div><strong>{template.name}</strong><p className="pd-muted">{template.description}</p></div></li>)}
              </ul>
            </>
          );
        }}
      </LoadedContent>
      {editing ? <TemplateDialog space={space} template={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); templates.reload(); }} /> : null}
    </>
  );
}
