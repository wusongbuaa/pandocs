import * as React from "react";
import { Link } from "@rspress/core/theme";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "../ui/form";
import { api, ApiError, failureMessage } from "../api/client";
import { SAMPLE_SPACE, spaceManageRoute } from "../data/manage";
import { pageUrl } from "../data/paths";
import { app } from "../data/runtime-data";
import { atLeast, type DeletedSpace, type Role } from "../types";
import { confirm } from "../ui/confirm";
import { FormDialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, ManageHead, useOpenFromLink } from "./parts";
import { DEFAULT_ROLES, ROLE_LABELS } from "./roles";
import { t } from "../i18n";

/** Latin names say what the address should be. A Chinese name does not, and the person chooses one. */
const slugFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);

function CreateSpaceDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [defaultRole, setDefaultRole] = React.useState<Role>("viewer");
  const submit = async () => {
    await api.send("POST", "spaces", { body: { name, slug, description, defaultRole } });
    // The routes and sidebars are built when the app loads.
    location.assign(`${pageUrl(spaceManageRoute(slug, "pages"))}?new=1`);
  };
  return (
    <FormDialog
      title={t("New space")}
      onClose={onClose}
      action={t("Create")}
      onSubmit={submit}
      fieldFor={error => (error.code.startsWith("SPACE_SLUG") ? "slug" : undefined)}
    >
      <TextField
        name="name"
        label={t("Name")}
        required
        autoFocus
        value={name}
        onChange={event => {
          setName(event.target.value);
          if (!slugTouched) setSlug(slugFromName(event.target.value));
        }}
      />
      <TextField
        name="slug"
        label={t("Address")}
        required
        pattern="[a-z0-9][a-z0-9\-]{0,63}"
        data-problem={t("Lowercase letters, digits and hyphens")}
        description={t(
          "Lowercase letters, digits and hyphens. It cannot change once created. Pages live at /{0}/…",
          slug || "handbook"
        )}
        value={slug}
        placeholder="handbook"
        onChange={event => {
          setSlugTouched(true);
          setSlug(event.target.value.toLowerCase());
        }}
      />
      <TextField
        label={t("Description (optional)")}
        value={description}
        onChange={event => setDescription(event.target.value)}
      />
      <SelectField
        label={t("People signed in can by default")}
        value={defaultRole}
        onChange={value => setDefaultRole(value as Role)}
        choices={DEFAULT_ROLES.map(role => ({ value: role, label: ROLE_LABELS[role] }))}
      />
    </FormDialog>
  );
}

/** Loaded when asked for, since it brings every page of the sample documents with it. */
function SampleDocsDialog({ onClose }: { onClose: () => void }) {
  const [progress, setProgress] = React.useState<readonly [number, number] | null>(null);
  const submit = async () => {
    const { importSampleDocs } = await import("./sample-docs");
    await importSampleDocs((done, total) => setProgress([done, total]));
    // The routes and sidebars are built when the app loads.
    location.assign(pageUrl(`/${SAMPLE_SPACE}/`));
  };
  return (
    <FormDialog
      title={t("Import the sample documents")}
      description={t(
        "This makes a space with Pandocs' own documentation, using each kind of block, with a comment and a suggestion to try. Delete the space when you no longer want it."
      )}
      onClose={onClose}
      action={t("Import")}
      onSubmit={submit}
    >
      {progress ? (
        <p className="pd-sample-progress" role="status">
          {t("Importing {0}/{1}…", progress[0], progress[1])}
        </p>
      ) : null}
    </FormDialog>
  );
}

/** A space made since has its address, so it comes back at another one. */
function RestoreElsewhere({ space, onClose }: { space: DeletedSpace; onClose: () => void }) {
  const [slug, setSlug] = React.useState(`${space.slug}-restored`.slice(0, 64));
  const submit = async () => {
    await api.send("POST", `deleted-spaces/${space.id}/restore`, { body: { slug: slug.trim() } });
    location.reload();
  };
  return (
    <FormDialog
      title={t('Restore "{0}" at another address', space.name)}
      description={t("Another space has the address {0} now.", space.slug)}
      action={t("Restore")}
      onClose={onClose}
      onSubmit={submit}
    >
      <TextField
        name="slug"
        label={t("Address")}
        required
        pattern="[a-z0-9][a-z0-9\-]{0,63}"
        value={slug}
        onChange={event => setSlug(event.target.value)}
      />
    </FormDialog>
  );
}

function DeletedSpaces() {
  const deleted = useLoaded(() => api.get<DeletedSpace[]>("deleted-spaces"), []);
  const [elsewhere, setElsewhere] = React.useState<DeletedSpace | null>(null);
  if (deleted.status !== "ready" || deleted.data.length === 0) return null;
  const restore = async (space: DeletedSpace) => {
    if (
      !(await confirm({
        title: t('Restore "{0}"?', space.name),
        description: t("Its pages, versions and discussions come back."),
        action: t("Restore")
      }))
    )
      return;
    try {
      await api.send("POST", `deleted-spaces/${space.id}/restore`);
      location.reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === "SPACE_SLUG_TAKEN") setElsewhere(space);
      else toast(failureMessage(error), "error");
    }
  };
  return (
    <>
      <h2>{t("Deleted spaces")}</h2>
      <table>
        <thead>
          <tr>
            <th>{t("Name")}</th>
            <th>{t("Address")}</th>
            <th>{t("Delete")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {deleted.data.map(space => (
            <tr key={space.id}>
              <td>{space.name}</td>
              <td>
                <code>{space.slug}</code>
              </td>
              <td>
                {space.deletedName ?? t("Unknown")} · {relativeTime(space.deletedAt)}
              </td>
              <td className="pd-table__actions">
                <Button variant="outline" size="sm" onClick={() => void restore(space)}>
                  {t("Restore")}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {elsewhere ? <RestoreElsewhere space={elsewhere} onClose={() => setElsewhere(null)} /> : null}
    </>
  );
}

export function SpacesView() {
  const { spaces, me } = app.bootstrap;
  const [creating, setCreating] = React.useState(false);
  const [sampling, setSampling] = React.useState(false);
  useOpenFromLink(() => setCreating(me.isAdmin));
  useOpenFromLink(() => setSampling(me.isAdmin), "sample");
  return (
    <>
      <ManageHead
        title={t("All spaces")}
        description={t("A space is a set of pages with its own structure, members and trash.")}
      >
        {me.isAdmin && !spaces.some(space => space.slug === SAMPLE_SPACE) ? (
          <Button variant="outline" onClick={() => setSampling(true)}>
            {t("Import the sample documents")}
          </Button>
        ) : null}
        {me.isAdmin ? <Button onClick={() => setCreating(true)}>{t("New space")}</Button> : null}
      </ManageHead>
      {spaces.length === 0 ? (
        <EmptyState>
          {me.isAdmin
            ? t("There are no spaces yet. Create one, then start writing in it.")
            : t("No spaces you can see yet.")}
        </EmptyState>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("Name")}</th>
              <th>{t("Page")}</th>
              <th>{t("My role")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {spaces.map(space => (
              <tr key={space.id}>
                <td>
                  <Link href={`/${space.slug}/`}>{space.name}</Link>
                  {space.description ? <div className="pd-table__note">{space.description}</div> : null}
                </td>
                <td>{space.tree.length}</td>
                <td>{ROLE_LABELS[space.role]}</td>
                <td className="pd-table__actions">
                  {atLeast(space.role, "editor") ? (
                    <Link href={spaceManageRoute(space.slug, "pages")} className="pd-btn">
                      {t("Manage")}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {me.isAdmin ? <DeletedSpaces /> : null}
      {creating ? <CreateSpaceDialog onClose={() => setCreating(false)} /> : null}
      {sampling ? <SampleDocsDialog onClose={() => setSampling(false)} /> : null}
    </>
  );
}
