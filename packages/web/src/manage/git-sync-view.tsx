import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyField, PasswordField, SelectField, SwitchField, TextField } from "../ui/form";
import { Menu } from "../ui/menu";
import { api, failureMessage } from "../api/client";
import type { Space } from "../types";
import { confirm } from "../ui/confirm";
import { FormDialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

interface GitSync {
  readonly repository: string;
  readonly branch: string;
  readonly folder: string;
  readonly hasToken: boolean;
  readonly hookPath: string;
  readonly firstSource: "space" | "repository";
  readonly includeRestricted: boolean;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly lastCommit: string | null;
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
}

interface GitSyncRun {
  readonly startedAt: string;
  readonly head: string | null;
  readonly pulled: number;
  readonly pushed: number;
  readonly notes: readonly { readonly file: string; readonly reason: string }[];
  readonly error: string | null;
}

const POLL_MS = 1500;
const POLL_TIMES = 40;
const shortCommit = (commit: string) => commit.slice(0, 7);

function ConnectDialog({ base, sync, onClose, onSaved }: { base: string; sync: GitSync | null; onClose: () => void; onSaved: () => void }) {
  const [repository, setRepository] = React.useState(sync?.repository ?? "");
  const [branch, setBranch] = React.useState(sync?.branch ?? "main");
  const [folder, setFolder] = React.useState(sync?.folder ?? "");
  const [token, setToken] = React.useState("");
  const [firstSource, setFirstSource] = React.useState(sync?.firstSource ?? "space");
  const [includeRestricted, setIncludeRestricted] = React.useState(sync?.includeRestricted ?? false);
  // A token only goes where it was given for, so a new address means a new one.
  const sameRepository = sync?.repository === repository.trim();
  const save = async () => {
    await api.send("PUT", base, { body: { repository: repository.trim(), branch: branch.trim(), folder: folder.trim(), firstSource, includeRestricted, enabled: sync?.enabled ?? true, ...(token ? { token } : {}) } });
    onSaved();
  };
  return (
    <FormDialog title={sync ? t("Change the repository settings") : t("Connect a repository")} onClose={onClose} action={t("Save")} onSubmit={save}>
      <TextField name="repository" label={t("Repository")} description={t("The address you would clone it from over HTTPS.")} required autoFocus value={repository} placeholder="https://github.com/acme/docs.git" onChange={event => setRepository(event.target.value)} />
      <TextField name="branch" label={t("Branch")} required value={branch} onChange={event => setBranch(event.target.value)} />
      <TextField name="folder" label={t("Folder (optional)")} description={t("Empty for the whole repository. Nothing outside it is touched.")} value={folder} placeholder="docs" onChange={event => setFolder(event.target.value)} />
      <PasswordField name="token" label={t("Access token")} description={t("Needs permission to read and push. To give a user name as well, write it as name:token.")} autoComplete="off" value={token} placeholder={sync?.hasToken && sameRepository ? t("Set. Leave empty to keep it.") : ""} onChange={event => setToken(event.target.value)} />
      {sync ? null : (
        <SelectField label={t("If a page and a file have the same address")} description={t("Only for the first sync. After that, changes merge.")} value={firstSource} onChange={value => setFirstSource(value as "space" | "repository")} choices={[{ value: "space", label: t("Keep the page, and write it to the repository") }, { value: "repository", label: t("Keep the file, as a new version of the page") }]} />
      )}
      <SwitchField label={t("Include pages only some people can read. Anyone who can read the repository will be able to read them.")} checked={includeRestricted} onChange={setIncludeRestricted} />
    </FormDialog>
  );
}

function Status({ sync }: { sync: GitSync }) {
  if (!sync.enabled) return <span className="pd-status pd-status--failed">{t("Off")}</span>;
  if (sync.running) return <span className="pd-status">{t("Syncing…")}</span>;
  if (sync.lastError) return <span className="pd-status pd-status--failed">{t("Failing")}</span>;
  if (!sync.lastSuccessAt) return <span className="pd-status">{t("Waiting for the first sync")}</span>;
  return <span className="pd-status pd-status--done">{t("Last checked {0}", relativeTime(sync.lastSuccessAt))}</span>;
}

/** Where a space is also a folder of a repository: who is connected, whether it is working, and what it has done. */
export function GitSyncView({ space }: { space: Space }) {
  const base = `spaces/${space.slug}/git-sync`;
  const state = useLoaded(() => api.get<{ available: boolean; sync: GitSync | null }>(base), [base]);
  const runs = useLoaded(() => api.get<GitSyncRun[]>(`${base}/runs`), [base]);
  const [editing, setEditing] = React.useState(false);
  const [polls, setPolls] = React.useState(0);
  const ready = state.status === "ready" ? state.data : null;
  const sync = ready?.sync ?? null;
  const reload = () => {
    state.reload();
    runs.reload();
  };
  // After asking for a sync, or while one runs, keep looking for a while, as the result is what someone is waiting to see.
  const { running = false } = sync ?? {};
  React.useEffect(() => {
    if (polls === 0 && !running) return undefined;
    const timer = setTimeout(() => {
      reload();
      setPolls(value => Math.max(0, value - 1));
    }, POLL_MS);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [polls, running, state.status === "ready" ? state.data : null]);
  const act = async (work: () => Promise<unknown>, done: () => void = reload) => {
    try {
      await work();
      done();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const syncNow = () => void act(() => api.send("POST", `${base}/run`), () => {
    toast(t("It will sync in a moment"), "success");
    setPolls(POLL_TIMES);
  });
  const switchOn = (current: GitSync, enabled: boolean) => void act(() => api.send("PUT", base, { body: { repository: current.repository, branch: current.branch, folder: current.folder, firstSource: current.firstSource, includeRestricted: current.includeRestricted, enabled } }));
  const disconnect = async () => {
    if (!await confirm({ title: t("Disconnect this repository?"), description: t("The pages and the repository stay as they are, and stop being kept the same. Connecting again later starts by comparing them."), action: t("Disconnect"), danger: true })) return;
    await act(() => api.send("DELETE", base));
  };
  const hookUrl = sync ? new URL(sync.hookPath, location.origin).toString() : "";
  return (
    <>
      <ManageHead title={t("Git sync")} description={t("Keep this space and a folder of a Git repository the same, in both directions.")}>
        {sync ? (
          <>
            <Button disabled={!sync.enabled || sync.running} onClick={syncNow}>{t("Sync now")}</Button>
            <Menu.Root>
              <Menu.Trigger className="pd-icon-button pd-icon-button--small" aria-label={t("More actions")}><MoreHorizontal size={16} aria-hidden="true" /></Menu.Trigger>
              <Menu.Content align="end" sideOffset={4}>
                <Menu.Item onClick={() => setEditing(true)}>{t("Edit")}</Menu.Item>
                <Menu.Item onClick={() => switchOn(sync, !sync.enabled)}>{sync.enabled ? t("Turn off") : t("Turn on")}</Menu.Item>
                <Menu.Item onClick={() => void disconnect()}>{t("Disconnect")}</Menu.Item>
              </Menu.Content>
            </Menu.Root>
          </>
        ) : ready?.available ? <Button onClick={() => setEditing(true)}>{t("Connect a repository")}</Button> : null}
      </ManageHead>
      <LoadedContent loaded={state}>
        {({ available }) => {
          if (!sync) return <EmptyState>{available ? t("Not connected to a repository.") : t("This server cannot run Git. Install it where Pandocs runs to use this.")}</EmptyState>;
          return (
            <>
              <dl className="pd-git-sync__facts">
                <dt>{t("Status")}</dt>
                <dd><Status sync={sync} />{sync.lastError ? <div className="pd-table__note">{sync.lastError}</div> : null}</dd>
                <dt>{t("Repository")}</dt><dd>{sync.repository}</dd>
                <dt>{t("Branch")}</dt><dd>{sync.branch}</dd>
                <dt>{t("Folder")}</dt><dd>{sync.folder || t("The whole repository")}</dd>
                <dt>{t("Access token")}</dt><dd>{sync.hasToken ? t("Set") : t("None")}</dd>
                <dt>{t("Latest commit")}</dt><dd>{sync.lastCommit ? <code>{shortCommit(sync.lastCommit)}</code> : t("None yet")}</dd>
              </dl>
              <section className="pd-git-sync__hook">
                <h2>{t("Sync as soon as someone pushes")}</h2>
                <p className="pd-muted">{t("It looks about once a minute anyway. To be quicker, add this address as a push webhook in the repository's settings. Anyone with it can only make a sync come sooner.")}</p>
                <CopyField label={t("Webhook address")} mono value={hookUrl} />
              </section>
              <section className="pd-git-sync__runs">
                <h2>{t("What it has done")}</h2>
                <LoadedContent loaded={runs}>
                  {data => (data.length === 0 ? <EmptyState>{t("Nothing yet.")}</EmptyState> : (
                    <table className="pd-table">
                      <thead><tr><th>{t("When")}</th><th>{t("From the repository")}</th><th>{t("To the repository")}</th><th>{t("Result")}</th></tr></thead>
                      <tbody>
                        {data.map(run => (
                          <tr key={run.startedAt}>
                            <td className="pd-table__nowrap">{relativeTime(run.startedAt)}{run.head ? <div className="pd-table__note"><code>{shortCommit(run.head)}</code></div> : null}</td>
                            <td>{t("{0} {0|page|pages}", run.pulled)}</td>
                            <td>{t("{0} {0|page|pages}", run.pushed)}</td>
                            <td>
                              {run.error ? <span className="pd-status pd-status--failed">{t("Failed")}</span> : <span className="pd-status pd-status--done">{t("Done")}</span>}
                              {run.error ? <div className="pd-table__note">{run.error}</div> : null}
                              {run.notes.map((note, at) => <div className="pd-table__note" key={at}>{note.file ? `${note.file}: ` : ""}{note.reason}</div>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ))}
                </LoadedContent>
              </section>
            </>
          );
        }}
      </LoadedContent>
      {editing ? <ConnectDialog base={base} sync={sync} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setPolls(POLL_TIMES); reload(); }} /> : null}
    </>
  );
}
