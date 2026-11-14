import * as React from "react";
import copy from "copy-to-clipboard";
import { Button } from "@/components/ui/button";
import { TextField, TextareaField } from "../ui/form";
import { api, failureMessage } from "../api/client";
import { confirm } from "../ui/confirm";
import { Dialog, FormDialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

interface EmbedApp {
  readonly slug: string;
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly status: "active" | "disabled";
  readonly lastUsedAt: string | null;
  readonly group: string;
}

const originsFrom = (text: string) => text.split(/\s+/u).filter(Boolean);

function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Dialog
      title={t("App secret")}
      description={t("Shown this once. Keep it on the other system's server, never in a web page or front-end code.")}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t("I have saved it")}</Button>}
    >
      <code className="pd-token">{secret}</code>
      <Button
        variant="outline"
        onClick={() => {
          copy(secret);
          toast(t("Copied"), "success");
        }}
      >
        {t("Copy")}
      </Button>
    </Dialog>
  );
}

function CreateAppDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [origins, setOrigins] = React.useState("");
  const submit = async () => {
    const { secret } = await api.send<{ secret: string }>("POST", "admin/embed-apps", {
      body: { name: name.trim(), slug: slug.trim(), allowedOrigins: originsFrom(origins) }
    });
    onCreated(secret);
  };
  return (
    <FormDialog title={t("Add an embed app")} onClose={onClose} action={t("Add")} onSubmit={submit}>
      <TextField
        name="name"
        label={t("Display name")}
        required
        autoFocus
        value={name}
        onChange={event => setName(event.target.value)}
      />
      <TextField
        name="slug"
        label={t("Identifier (lowercase letters, digits and hyphens; it appears in addresses)")}
        required
        pattern="[a-z0-9][a-z0-9\-]*"
        data-problem={t("Lowercase letters, digits and hyphens")}
        value={slug}
        onChange={event => setSlug(event.target.value)}
        placeholder="helpdesk"
      />
      <TextareaField
        label={t("Sites allowed to embed it, one per line")}
        rows={3}
        value={origins}
        onChange={event => setOrigins(event.target.value)}
        placeholder="https://helpdesk.example.com"
      />
    </FormDialog>
  );
}

function EditOriginsDialog({ app, onClose, onSaved }: { app: EmbedApp; onClose: () => void; onSaved: () => void }) {
  const [origins, setOrigins] = React.useState(app.allowedOrigins.join("\n"));
  const submit = async () => {
    await api.send("PATCH", `admin/embed-apps/${app.slug}`, { body: { allowedOrigins: originsFrom(origins) } });
    onSaved();
  };
  return (
    <FormDialog
      title={t("{0}: sites allowed to embed it", app.name)}
      onClose={onClose}
      action={t("Save")}
      onSubmit={submit}
    >
      <TextareaField
        label={t("One per line")}
        autoFocus
        rows={4}
        value={origins}
        onChange={event => setOrigins(event.target.value)}
      />
    </FormDialog>
  );
}

export function EmbedAppsView() {
  const apps = useLoaded(() => api.get<readonly EmbedApp[]>("admin/embed-apps"), []);
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<EmbedApp | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      apps.reload();
    } catch (failure) {
      toast(failureMessage(failure), "error");
    }
  };
  const rotate = async (item: EmbedApp) => {
    const yes = await confirm({
      title: t("Replace the secret for {0}?", item.name),
      description: t(
        "The old secret stops working right away. Tokens already issued work until they expire; disable the app to stop them now."
      ),
      action: t("Replace secret"),
      danger: true
    });
    if (yes)
      await act(async () =>
        setSecret((await api.send<{ secret: string }>("POST", `admin/embed-apps/${item.slug}/secret`)).secret)
      );
  };
  const remove = async (item: EmbedApp) => {
    const yes = await confirm({
      title: t("Delete {0}?", item.name),
      description: t("Pages embedded in that system stop opening right away. Comments its users left stay."),
      action: t("Delete"),
      danger: true
    });
    if (yes) await act(() => api.send("DELETE", `admin/embed-apps/${item.slug}`));
  };

  return (
    <>
      <ManageHead
        title={t("Embed apps")}
        description={t(
          "Let another system embed pages from here, with the same content. Its users see nothing until you add the app's group to a space's members."
        )}
      >
        <Button onClick={() => setCreating(true)}>{t("Add an app")}</Button>
      </ManageHead>
      <LoadedContent loaded={apps}>
        {list =>
          list.length === 0 ? (
            <EmptyState>
              {t(
                "No embed apps yet. Once you add one, that system trades its secret for tokens and can embed pages from here."
              )}
            </EmptyState>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("App")}</th>
                  <th>{t("Sites allowed to embed it")}</th>
                  <th>{t("Group to add to space members")}</th>
                  <th>{t("Recently used")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map(item => (
                  <tr key={item.slug}>
                    <td>
                      {item.name}
                      {item.status === "disabled" ? <span className="pd-muted">{t(" (disabled)")}</span> : null}
                      <div className="pd-muted">{item.slug}</div>
                    </td>
                    <td>
                      {item.allowedOrigins.length === 0 ? (
                        <span className="pd-muted">{t("None yet, so it cannot be embedded")}</span>
                      ) : (
                        item.allowedOrigins.map(origin => <div key={origin}>{origin}</div>)
                      )}
                    </td>
                    <td>
                      <code>{item.group}</code>
                    </td>
                    <td>{item.lastUsedAt ? relativeTime(item.lastUsedAt) : t("Not yet")}</td>
                    <td className="pd-table__actions">
                      <Button variant="outline" size="sm" onClick={() => setEditing(item)}>
                        {t("Change sites")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void rotate(item)}>
                        {t("Replace secret")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void act(() =>
                            api.send("PATCH", `admin/embed-apps/${item.slug}`, {
                              body: { status: item.status === "active" ? "disabled" : "active" }
                            })
                          )
                        }
                      >
                        {item.status === "active" ? t("Disable") : t("Enable")}
                      </Button>
                      <Button variant="destructive" onClick={() => void remove(item)}>
                        {t("Delete")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </LoadedContent>
      {creating ? (
        <CreateAppDialog
          onClose={() => setCreating(false)}
          onCreated={value => {
            setCreating(false);
            setSecret(value);
            apps.reload();
          }}
        />
      ) : null}
      {editing ? (
        <EditOriginsDialog
          app={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            apps.reload();
          }}
        />
      ) : null}
      {secret ? <SecretDialog secret={secret} onClose={() => setSecret(null)} /> : null}
    </>
  );
}
