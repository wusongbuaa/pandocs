import * as React from "react";
import copy from "copy-to-clipboard";
import { Button } from "@/components/ui/button";
import { SwitchField, TextField } from "../ui/form";
import { api, failureMessage } from "../api/client";
import { app } from "../data/runtime-data";
import { Dialog, FormDialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

interface Person {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly groups: readonly string[];
  readonly status: "active" | "disabled";
  readonly hasPassword: boolean;
  readonly lastLoginAt: string | null;
}

interface PasswordLink {
  readonly url: string;
  readonly expiresAt: string;
  readonly emailed: boolean;
}

interface LinkFor {
  readonly person: Pick<Person, "displayName" | "email">;
  readonly link: PasswordLink;
}

/** Works with no mail set up: the administrator passes it on however they talk to each other. */
function PasswordLinkDialog({ person, link, onDone }: LinkFor & { onDone: () => void }) {
  return (
    <Dialog title={t("Send this link to {0}", person.displayName)} description={link.emailed ? t("It has also been emailed to {0}. With it, they choose a password and are signed in. It works once, within 7 days.", person.email) : t("With it, they choose a password and are signed in. It works once, within 7 days. Until then it is a way into this account, so send it somewhere private.")} onClose={onDone} footer={<>
      <Button variant="outline" onClick={() => { copy(link.url); toast(t("Copied"), "success"); }}>{t("Copy")}</Button>
      <Button onClick={onDone}>{t("Done")}</Button>
    </>}>
      <code className="pd-token">{link.url}</code>
    </Dialog>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (made: LinkFor | null) => void }) {
  const [email, setEmail] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [isAdmin, setIsAdmin] = React.useState(false);
  const submit = async () => {
    const { passwordLink, ...person } = await api.send<Person & { passwordLink?: PasswordLink }>("POST", "admin/users", { body: { email, displayName, isAdmin } });
    onCreated(passwordLink ? { person, link: passwordLink } : null);
  };
  return (
    <FormDialog title={t("Add a user")} onClose={onClose} action={t("Add")} onSubmit={submit} fieldFor={error => (error.code === "EMAIL_TAKEN" ? "email" : undefined)}>
      <TextField name="displayName" label={t("Display name")} required autoFocus value={displayName} onChange={event => setDisplayName(event.target.value)} />
      <TextField name="email" label={t("Email")} type="email" required value={email} onChange={event => setEmail(event.target.value)} />
      <SwitchField label={t("Site administrator")} checked={isAdmin} onChange={setIsAdmin} />
    </FormDialog>
  );
}

export function UsersView() {
  const [query, setQuery] = React.useState("");
  const people = useLoaded(() => api.get<Person[]>(`admin/users${query ? `?q=${encodeURIComponent(query)}` : ""}`), [query]);
  const [adding, setAdding] = React.useState(false);
  const [linked, setLinked] = React.useState<LinkFor | null>(null);
  const passwords = app.bootstrap.passwordLogin !== false;
  const newLink = async (person: Person) => {
    try {
      setLinked({ person, link: await api.send<PasswordLink>("POST", `admin/users/${person.id}/password-link`) });
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const change = async (person: Person, patch: object) => {
    try {
      await api.send("PATCH", `admin/users/${person.id}`, { body: patch });
      people.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const me = app.bootstrap.me.id;
  return (
    <>
      <ManageHead title={t("Users")} description={passwords ? t("Add someone here, and they get a link to choose a password. Anyone signing in with a company account appears by themselves. Access to spaces and pages is set under their members.") : t("People signing in with a company account appear here by themselves. Access to spaces and pages is set under their members.")}>
        <Button onClick={() => setAdding(true)}>{t("Add a user")}</Button>
      </ManageHead>
      <TextField label={t("Search")} value={query} placeholder={t("Name or email")} onChange={event => setQuery(event.target.value)} />
      <LoadedContent loaded={people}>
        {list => list.length === 0 ? <EmptyState>{t("No users found.")}</EmptyState> : (
          <table>
            <thead><tr><th>{t("Users")}</th><th>{t("Groups")}</th><th>{t("Last signed in")}</th><th /></tr></thead>
            <tbody>
              {list.map(person => (
                <tr key={person.id}>
                  <td>{person.displayName}{person.isAdmin ? <span className="pd-muted">{t(" (administrator)")}</span> : null}{person.status === "disabled" ? <span className="pd-muted">{t(" (disabled)")}</span> : null}<div className="pd-table__note">{person.email}</div></td>
                  <td>{person.groups.join(t(", ")) || t("None")}</td>
                  <td>{person.lastLoginAt ? relativeTime(person.lastLoginAt) : t("Not yet")}{passwords && !person.lastLoginAt && !person.hasPassword ? <div className="pd-table__note">{t("Has not chosen a password")}</div> : null}</td>
                  <td className="pd-table__actions">
                    {person.id === me ? null : <>
                      {passwords && person.status === "active" ? <Button variant="outline" size="sm" onClick={() => void newLink(person)}>{person.hasPassword ? t("Reset password") : t("Link for a password")}</Button> : null}
                      <Button variant="outline" size="sm" onClick={() => void change(person, { isAdmin: !person.isAdmin })}>{person.isAdmin ? t("Remove administrator") : t("Make administrator")}</Button>
                      <Button variant="outline" size="sm" onClick={() => void change(person, { status: person.status === "active" ? "disabled" : "active" })}>{person.status === "active" ? t("Disable") : t("Restore")}</Button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadedContent>
      {adding ? <CreateUserDialog onClose={() => setAdding(false)} onCreated={made => { setAdding(false); setLinked(made); people.reload(); }} /> : null}
      {linked ? <PasswordLinkDialog {...linked} onDone={() => setLinked(null)} /> : null}
    </>
  );
}
