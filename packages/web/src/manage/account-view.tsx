import * as React from "react";
import copy from "copy-to-clipboard";
import { Button } from "@/components/ui/button";
import { Form, PasswordField, SelectField, TextField } from "../ui/form";
import { app } from "../data/runtime-data";
import { api, failureMessage } from "../api/client";
import { confirm } from "../ui/confirm";
import { Dialog, FormDialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { chooseLanguage, chosenLanguage, t } from "../i18n";
import { isLanguage } from "@pandocs/i18n";
import { SITE_BASE, sitePath } from "../data/site-base";

interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly kind: "user" | "agent";
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
}

const KINDS = {
  "user-write": { label: t("Read and write as me"), body: { kind: "user", scopes: ["read", "write"] } },
  "user-read": { label: t("Read only, as me"), body: { kind: "user", scopes: ["read"] } },
  agent: { label: t("Agent (can only read, comment and suggest)"), body: { kind: "agent", scopes: ["read", "write"] } }
} as const;

const describeToken = (token: ApiToken) => (token.kind === "agent" ? t("Agent") : token.scopes.includes("write") ? t("Read and write") : t("Read only"));

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string) => void }) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<keyof typeof KINDS>("user-read");
  const submit = async () => {
    const { token } = await api.send<{ token: string }>("POST", "account/tokens", { body: { name, ...KINDS[kind].body } });
    onCreated(token);
  };
  return (
    <FormDialog title={t("New API token")} onClose={onClose} action={t("Create")} onSubmit={submit}>
      <TextField name="name" label={t("Name")} required autoFocus value={name} placeholder={t("For example: my laptop")} onChange={event => setName(event.target.value)} />
      <SelectField label={t("Permissions")} value={kind} onChange={value => setKind(value as keyof typeof KINDS)} choices={Object.entries(KINDS).map(([value, { label }]) => ({ value, label }))} />
    </FormDialog>
  );
}

const copied = (text: string) => {
  copy(text);
  toast(t("Copied"), "success");
};

/** What a client's settings need, for this site, ready to paste. */
const mcpSettings = (token?: string) => JSON.stringify({
  mcpServers: { pandocs: { type: "http", url: `${location.origin}${sitePath("/mcp")}`, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) } }
}, null, 2);

function CopyableBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="pd-copy-block">
      <pre aria-label={label}><code>{text}</code></pre>
      <Button variant="outline" onClick={() => copied(text)}>{t("Copy")}</Button>
    </div>
  );
}

function ConnectAgent() {
  return (
    <>
      <h2>{t("Connect an agent")}</h2>
      <p className="pd-muted">{t("Paste this into an MCP client's settings. It opens a page here for you to approve, then it can read, comment and suggest with your access. Saving stays with people.")}</p>
      <CopyableBlock text={mcpSettings()} label={t("MCP client settings")} />
      <p className="pd-muted">{t("For a client that cannot open that page, or something running unattended, create a token with agent permissions and it will show the settings to use. From a terminal: ")}<code>{`pandocs login --server ${location.origin}${SITE_BASE}`}</code></p>
    </>
  );
}

function NewToken({ token, onDone }: { token: string; onDone: () => void }) {
  const copyToken = () => copied(token);
  return (
    <Dialog title={t("Copy your token")} description={t("You will not see it again after leaving this page.")} onClose={onDone} footer={<>
      <Button variant="outline" onClick={copyToken}>{t("Copy")}</Button>
      <Button onClick={onDone}>{t("Done")}</Button>
    </>}>
      <code className="pd-token">{token}</code>
      <p className="pd-muted">{t("To use it from an MCP client:")}</p>
      <CopyableBlock text={mcpSettings(token)} label={t("MCP client settings")} />
    </Dialog>
  );
}

function PasswordForm() {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    await api.send("POST", "account/password", { body: { ...(current ? { current } : {}), next } });
    setCurrent("");
    setNext("");
    toast(t("Password updated"), "success");
  };
  return (
    <Form className="pd-form" onSubmit={submit} onBusyChange={setBusy} fieldFor={error => (error.code === "PASSWORD_WRONG" ? "current" : undefined)}>
      <PasswordField name="current" label={t("Current password (leave empty if you sign in with a company account and never set one)")} autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} />
      <PasswordField name="next" label={t("New password (at least 8 characters)")} required autoComplete="new-password" minLength={8} value={next} onChange={event => setNext(event.target.value)} />
      <div><Button type="submit" variant="outline" disabled={busy}>{t("Update password")}</Button></div>
    </Form>
  );
}

interface ConnectedApp {
  readonly id: string;
  readonly clientName: string;
  readonly kind: "user" | "agent";
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

function ConnectedApps() {
  const apps = useLoaded(() => api.get<ConnectedApp[]>("account/connected-apps"), []);
  const disconnect = async (connected: ConnectedApp) => {
    if (!await confirm({ title: t("Disconnect \"{0}\"?", connected.clientName), description: t("It loses access right away, and would need authorizing again."), action: t("Disconnect"), danger: true })) return;
    try {
      await api.send("DELETE", `account/connected-apps/${connected.id}`);
      apps.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  return (
    <LoadedContent loaded={apps}>
      {list => list.length === 0 ? null : (
        <>
          <h2>{t("Connected apps")}</h2>
          <p className="pd-muted">{t("Apps you approved on an authorization page. They work as agents: they can only read, comment and suggest, and someone with edit access reviews what they suggest.")}</p>
          <table>
            <thead><tr><th>{t("App")}</th><th>{t("Permissions")}</th><th>{t("Last used")}</th><th /></tr></thead>
            <tbody>
              {list.map(connected => (
                <tr key={connected.id}>
                  <td>{connected.clientName}<div className="pd-table__note">{t("Authorized {0}", relativeTime(connected.createdAt))}</div></td>
                  <td>{!connected.scopes.includes("write") ? t("Read only") : connected.kind === "user" ? t("Read and write") : t("Read, comment and suggest")}</td>
                  <td>{relativeTime(connected.lastUsedAt)}</td>
                  <td className="pd-table__actions"><Button variant="outline" size="sm" onClick={() => void disconnect(connected)}>{t("Disconnect")}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </LoadedContent>
  );
}

export function AccountView() {
  const tokens = useLoaded(() => api.get<ApiToken[]>("account/tokens"), []);
  const [creating, setCreating] = React.useState(false);
  const [created, setCreated] = React.useState<string | null>(null);
  const revoke = async (token: ApiToken) => {
    if (!await confirm({ title: t("Disable \"{0}\"?", token.name), description: t("Tools using this token lose access right away."), action: t("Disable"), danger: true })) return;
    try {
      await api.send("DELETE", `account/tokens/${token.id}`);
      tokens.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  return (
    <>
      <ManageHead title={t("Account and tokens")} description={t("API tokens are for the CLI, SDKs and MCP. They can never do more than you can.")}>
        <Button onClick={() => setCreating(true)}>{t("New token")}</Button>
      </ManageHead>
      <div className="pd-account__tokens"><LoadedContent loaded={tokens}>
        {list => list.length === 0 ? <EmptyState>{t("No tokens yet.")}</EmptyState> : (
          <table>
            <thead><tr><th>{t("Name")}</th><th>{t("Permissions")}</th><th>{t("Last used")}</th><th /></tr></thead>
            <tbody>
              {list.map(token => (
                <tr key={token.id}>
                  <td>{token.name}<div className="pd-table__note">{t("Created {0}", relativeTime(token.createdAt))}</div></td>
                  <td>{describeToken(token)}</td>
                  <td>{token.lastUsedAt ? relativeTime(token.lastUsedAt) : t("Not yet")}</td>
                  <td className="pd-table__actions"><Button variant="outline" size="sm" onClick={() => void revoke(token)}>{t("Disable")}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadedContent></div>
      <ConnectAgent />
      <ConnectedApps />
      {app.bootstrap.passwordLogin === false ? null : <>
        <h2>{t("Password")}</h2>
        <PasswordForm />
      </>}
      <h2>{t("Language")}</h2>
      <div className="pd-form"><SelectField label={t("The interface's language on this computer")} value={chosenLanguage() ?? ""} onChange={value => chooseLanguage(isLanguage(value) ? value : null)} choices={[{ value: "", label: t("Same as the browser") }, { value: "en", label: "English" }, { value: "zh", label: "简体中文" }]} /></div>
      {creating ? <CreateTokenDialog onClose={() => setCreating(false)} onCreated={token => { setCreating(false); setCreated(token); tokens.reload(); }} /> : null}
      {created ? <NewToken token={created} onDone={() => setCreated(null)} /> : null}
    </>
  );
}
