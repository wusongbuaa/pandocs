import * as React from "react";
import { Button } from "@/components/ui/button";
import { Form, TextField, TextareaField } from "../ui/form";
import { api, failureMessage } from "../api/client";
import { manageRoute } from "../data/manage";
import { pageUrl } from "../data/paths";
import { app } from "../data/runtime-data";
import type { Space } from "../types";
import { confirm } from "../ui/confirm";
import { FormDialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { MergeRulesSection } from "./change-sets-view";
import { ManageHead } from "./parts";
import { t } from "../i18n";

function DeleteSpaceDialog({ space, onClose }: { space: Space; onClose: () => void }) {
  const [typed, setTyped] = React.useState("");
  const remove = async () => {
    await api.send("DELETE", `spaces/${space.slug}`);
    location.assign(pageUrl(manageRoute("spaces")));
  };
  return (
    <FormDialog title={t("Delete \"{0}\"", space.name)} description={t("The space and its pages disappear from the site, and links to them stop working. An administrator can restore them under \"All spaces\".")} onClose={onClose} action={t("Delete")} danger disabled={typed !== space.name} onSubmit={remove}>
      <TextField label={t("Type the space's name to confirm")} autoFocus value={typed} onChange={event => setTyped(event.target.value)} />
    </FormDialog>
  );
}

/** Opening a space to the internet is not something to do by accident, and it is worth saying what stays closed. */
function PublicAccess({ space }: { space: Space }) {
  const [isPublic, setIsPublic] = React.useState(space.publicRead === true);
  const [busy, setBusy] = React.useState(false);
  const change = async (next: boolean) => {
    const yes = await confirm(next
      ? { title: t("Make \"{0}\" public?", space.name), description: t("Anyone on the internet can read and search this space's pages without signing in. Restricted pages, comments, suggestions and version history stay private."), action: t("Make public"), danger: true }
      : { title: t("Make \"{0}\" private?", space.name), description: t("People who are not signed in lose sight of this space right away."), action: t("Make private") });
    if (!yes) return;
    setBusy(true);
    try {
      await api.send("PATCH", `spaces/${space.slug}`, { body: { publicRead: next } });
      setIsPublic(next);
      toast(next ? t("The space is public") : t("The space is private"), "success");
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pd-danger">
      <div>
        <strong>{isPublic ? t("This space is public") : t("Make this space public")}</strong>
        <p>{isPublic ? t("Anyone can read the pages here without signing in. Restricted pages, comments, suggestions and version history stay private.") : t("Only people signed in with access can see it. Made public, anyone can read it without signing in, which suits a public documentation site.")}</p>
      </div>
      <Button variant={isPublic ? "outline" : "destructive"} disabled={busy} onClick={() => void change(!isPublic)}>{isPublic ? t("Make private") : t("Make public")}</Button>
    </section>
  );
}

export function SpaceSettingsView({ space }: { space: Space }) {
  const [name, setName] = React.useState(space.name);
  const [description, setDescription] = React.useState(space.description);
  const [busy, setBusy] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const save = async () => {
    await api.send("PATCH", `spaces/${space.slug}`, { body: { name, description } });
    // The name also appears in the navigation, which is built when the app loads.
    location.reload();
  };
  return (
    <>
      <ManageHead title={t("{0}: general", space.name)} />
      <Form className="pd-form" onSubmit={save} onBusyChange={setBusy}>
        <TextField name="name" label={t("Name")} required value={name} onChange={event => setName(event.target.value)} />
        <TextareaField label={t("Description")} description={t("Shown on the space's front page. For a front page of your own, create a page with the path index.")} rows={3} value={description} onChange={event => setDescription(event.target.value)} />
        <TextField label={t("Address")} description={t("The address cannot change once created.")} value={space.slug} disabled />
        <div><Button type="submit" disabled={busy || (name === space.name && description === space.description)}>{t("Save")}</Button></div>
      </Form>
      <MergeRulesSection space={space} />
      <PublicAccess space={space} />
      {app.bootstrap.me.isAdmin ? (
        <section className="pd-danger">
          <div><strong>{t("Delete this space")}</strong><p>{t("Nothing is really lost: an administrator can restore it.")}</p></div>
          <Button variant="destructive" onClick={() => setDeleting(true)}>{t("Delete space")}</Button>
        </section>
      ) : null}
      {deleting ? <DeleteSpaceDialog space={space} onClose={() => setDeleting(false)} /> : null}
    </>
  );
}
