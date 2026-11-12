import * as React from "react";
import clsx from "clsx";
import { Button } from "@/components/ui/button";
import { FileField, SearchSelectField, SelectField, SwitchField, TextField } from "../ui/form";
import { api, failureMessage } from "../api/client";
import type { Space, TreeEntry } from "../types";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { pageChoices } from "./parts";
import { t } from "../i18n";

interface BulkImport {
  readonly id: string;
  readonly source: string;
  readonly filename: string;
  readonly url: string | null;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly progress: { readonly done: number; readonly total: number | null };
  readonly report: {
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly assets: number;
    readonly notes: readonly { readonly file: string; readonly reason: string }[];
    readonly notesLeftOut: number;
  } | null;
  readonly error: string | null;
  readonly createdName: string;
  readonly createdAt: string;
}

interface Source {
  readonly source: string;
  readonly input: "file" | "url";
}

const MAX_BYTES = 100 * 1024 * 1024;
const POLL_MS = 2000;
const TOP_LEVEL = "";

const sourceNames = (): Readonly<Record<string, string>> => ({ notion: "Notion", confluence: "Confluence", feishu: t("Feishu or Lark") });
const sourceHelp = (): Readonly<Record<string, string>> => ({
  notion: t("In Notion, export with the format Markdown & CSV and with subpages included, and choose the zip it gives you. A large export comes in parts: import each of them."),
  confluence: t("In Confluence, export the space as HTML from its settings, and choose the zip it gives you. Up to 100 MB, so a space with many attachments may need them left out."),
  feishu: t("The address of a document, a page in a knowledge base, or a knowledge base's settings page. It is read through the app set up on this server, so that app needs access to it.")
});

const STATUS = (): Readonly<Record<BulkImport["status"], string>> => ({ queued: t("Queued"), running: t("Processing"), succeeded: t("Finished"), failed: t("Failed"), cancelled: t("Cancelled") });

function ImportRow({ item, onChanged }: { item: BulkImport; onChanged: () => void }) {
  const act = async (action: "cancel" | "retry") => {
    try {
      await api.send("POST", `bulk-imports/${item.id}/${action}`);
      onChanged();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const { report, progress } = item;
  return (
    <li className="pd-bulk-import">
      <div className="pd-bulk-import__head">
        <span className="pd-bulk-import__name">{sourceNames()[item.source] ?? item.source}: {item.filename || item.url}</span>
        <span className={clsx("pd-status", item.status === "failed" && "pd-status--failed", item.status === "succeeded" && "pd-status--done")}>
          {STATUS()[item.status]}{item.status === "running" && progress.total ? ` ${progress.done} / ${progress.total}` : ""}
        </span>
        {item.status === "queued" || item.status === "running" ? <Button variant="outline" onClick={() => void act("cancel")}>{t("Cancel")}</Button> : null}
        {item.status === "failed" ? <Button variant="outline" onClick={() => void act("retry")}>{t("Try again")}</Button> : null}
      </div>
      <small className="pd-muted">{item.createdName} · {relativeTime(item.createdAt)}</small>
      {item.error ? <p className="pd-bulk-import__error">{item.error}</p> : null}
      {report ? <p className="pd-muted">{t("{0} created, {1} updated, {2} unchanged, {3} files.", report.created, report.updated, report.unchanged, report.assets)}</p> : null}
      {report && report.notes.length > 0 ? (
        <details>
          <summary>{t("{0} things to check", report.notes.length + report.notesLeftOut)}</summary>
          <ul>{report.notes.map((note, at) => <li key={at}>{t("{0}: {1}", note.file, note.reason)}</li>)}</ul>
          {report.notesLeftOut > 0 ? <p className="pd-muted">{t("… and {0} more", report.notesLeftOut)}</p> : null}
        </details>
      ) : null}
    </li>
  );
}

/** A whole set of pages from another tool, going straight in as it arrives. Doing it again only changes what has changed since. */
export function BulkImports({ space, tree, onChanged }: { space: Space; tree: readonly TreeEntry[]; onChanged: () => void }) {
  const sources = useLoaded(() => api.get<Source[]>("bulk-imports/sources"), []);
  const imports = useLoaded(() => api.get<BulkImport[]>(`spaces/${space.slug}/bulk-imports`), [space.slug]);
  const [source, setSource] = React.useState("notion");
  const [file, setFile] = React.useState<File | null>(null);
  const [url, setUrl] = React.useState("");
  const [includeChildren, setIncludeChildren] = React.useState(true);
  const [parentPath, setParentPath] = React.useState(TOP_LEVEL);
  const [busy, setBusy] = React.useState(false);
  const available = sources.status === "ready" ? sources.data : [];
  const chosen = available.find(item => item.source === source);
  const { reload } = imports;
  const list = imports.status === "ready" ? imports.data : [];
  const inProgress = list.some(item => item.status === "queued" || item.status === "running");
  React.useEffect(() => {
    if (!inProgress) return undefined;
    const timer = setInterval(reload, POLL_MS);
    return () => {
      clearInterval(timer);
      // What was running has just finished, so there are pages the rest of the view has not heard of.
      onChanged();
    };
  }, [inProgress, reload, onChanged]);
  const start = async () => {
    if (file && file.size > MAX_BYTES) {
      toast(t("A file can be at most 100 MB: {0}", file.name), "error");
      return;
    }
    setBusy(true);
    try {
      if (chosen?.input === "file" && file) {
        await api.upload<BulkImport>(`spaces/${space.slug}/bulk-imports`, file, { source, ...(parentPath ? { parentPath } : {}) });
      } else {
        await api.send("POST", `spaces/${space.slug}/bulk-imports`, { body: { source, url: url.trim(), includeChildren, ...(parentPath ? { parentPath } : {}) } });
      }
      setFile(null);
      setUrl("");
      reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pd-bulk-imports">
      <h2>{t("From another tool")}</h2>
      <p className="pd-muted">{t("Brings in a whole set of pages, straight into this space, as you. Importing the same thing again only changes what has changed since.")}</p>
      <SelectField label={t("From")} description={sourceHelp()[source]} value={source} onChange={setSource} choices={available.map(item => ({ value: item.source, label: sourceNames()[item.source] ?? item.source }))} />
      {chosen?.input === "url" ? (
        <>
          <TextField label={t("Address")} value={url} placeholder="https://example.feishu.cn/wiki/…" onChange={event => setUrl(event.target.value)} />
          <SwitchField label={t("Include the pages under it")} checked={includeChildren} onChange={setIncludeChildren} />
        </>
      ) : (
        <FileField label={t("Exported file")} accept=".zip" file={file} onPick={setFile} />
      )}
      <SearchSelectField label={t("Place under")} value={parentPath} onChange={setParentPath} choices={pageChoices(tree, { value: TOP_LEVEL, label: t("Top level") }, entry => entry.path)} />
      <div className="pd-form__foot">
        <Button disabled={busy || !chosen || (chosen.input === "file" ? !file : !url.trim())} onClick={() => void start()}>{t("Start importing")}</Button>
      </div>
      {list.length > 0 ? <ul className="pd-bulk-import-list">{list.map(item => <ImportRow key={item.id} item={item} onChanged={reload} />)}</ul> : null}
    </section>
  );
}
