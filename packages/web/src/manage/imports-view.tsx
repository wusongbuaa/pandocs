import * as React from "react";
import { useMDXComponents } from "@mdx-js/react";
import clsx from "clsx";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchSelectField, TextField } from "../ui/form";
import { api, API_BASE, failureMessage } from "../api/client";
import { documentRoute, pageUrl, slugForNewPage } from "../data/paths";
import { dialectComponents } from "../markdown/blocks";
import { renderMarkdown } from "../markdown/pipeline";
import { ReaderContextProvider } from "../markdown/reader-context";
import type { ImportJob, Space, TreeEntry } from "../types";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { BulkImports } from "./bulk-imports";
import { EmptyState, LoadedContent, ManageHead, pageChoices } from "./parts";
import { t } from "../i18n";

const STATUS: Readonly<Record<ImportJob["status"], string>> = {
  queued: t("Queued"),
  running: t("Processing"),
  retry_wait: t("Waiting to retry"),
  succeeded: t("Finished"),
  failed: t("Failed"),
  discarded: t("Discarded")
};
const ACCEPT = ".md,.markdown,.txt,.html,.htm,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.pdf,.csv,.zip";
const MAX_BYTES = 100 * 1024 * 1024;
const POLL_MS = 2000;

const withSlug = (slug: string | undefined) => (slug ? { slug } : {});

const isWaiting = (job: ImportJob) =>
  job.status === "succeeded" && job.draftMarkdown !== null && !job.documentId && !job.proposalId;

function JobStatus({ job }: { job: ImportJob }) {
  return (
    <span
      className={clsx(
        "pd-status",
        job.status === "failed" && "pd-status--failed",
        job.status === "succeeded" && "pd-status--done"
      )}
    >
      {isWaiting(job) ? t("Ready to publish") : STATUS[job.status]}
    </span>
  );
}

function DraftPreview({ markdown, title, space }: { markdown: string; title: string; space: Space }) {
  const provided = useMDXComponents();
  const [content, setContent] = React.useState<React.ReactNode>(null);
  React.useEffect(() => {
    let current = true;
    // The title is its own field above, and on the page it does not repeat either.
    void renderMarkdown(markdown, { title }).then(({ hast }) => {
      if (current)
        setContent(
          toJsxRuntime(hast, {
            Fragment,
            jsx,
            jsxs,
            components: { ...provided, ...dialectComponents } as never,
            ignoreInvalidStyle: true,
            passKeys: true
          })
        );
    });
    return () => {
      current = false;
    };
  }, [markdown, provided, title]);
  return (
    <ReaderContextProvider value={{ space, currentPath: "", routePrefix: "", children: [] }}>
      <div className="pd-import__preview rp-doc">{content}</div>
    </ReaderContextProvider>
  );
}

function JobDetail({
  job,
  space,
  tree,
  onChanged
}: {
  job: ImportJob;
  space: Space;
  tree: readonly TreeEntry[];
  onChanged: () => void;
}) {
  const [title, setTitle] = React.useState(job.draftTitle ?? "");
  // Where whoever started the import asked for it to go, as the CLI does; publishing sends what is shown here.
  const [parent, setParent] = React.useState(job.target?.parentPath ?? "");
  const [slug, setSlug] = React.useState(job.target?.slug ?? "");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setTitle(job.draftTitle ?? ""), [job.draftTitle]);
  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast(done, "success");
      onChanged();
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const report = job.report;
  const published = job.documentId ? tree.find(entry => entry.id === job.documentId) : undefined;
  const hasDraft = isWaiting(job);
  return (
    <section className="pd-import" aria-label={t("Import details")}>
      <header className="pd-import__head">
        <strong>{job.filename || job.draftTitle || t("Import job")}</strong>
        <JobStatus job={job} />
      </header>
      {job.errorMessage ? <p className="pd-manage__error">{job.errorMessage}</p> : null}
      {report.warnings?.length ? (
        <ul className="pd-import__notes">
          {report.warnings.map(warning => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {report.diagnostics?.length ? (
        <ul className="pd-import__notes">
          {report.diagnostics.map(item => (
            <li key={item.message}>{item.message}</li>
          ))}
        </ul>
      ) : null}
      {published ? (
        <p>
          <a className="pd-btn" href={pageUrl(documentRoute(space.slug, published.path))}>
            {t("Open the page")}
          </a>
        </p>
      ) : null}
      {job.proposalId ? (
        <p className="pd-muted">{t("Suggestion created, waiting for someone with edit access to review it.")}</p>
      ) : null}
      {hasDraft ? (
        <>
          <div className="pd-import__publish">
            <TextField label={t("Title")} value={title} onChange={event => setTitle(event.target.value)} />
            <SearchSelectField
              label={t("Place under")}
              value={parent}
              onChange={setParent}
              choices={pageChoices(tree, { value: "", label: t("Top level") }, entry => entry.path)}
            />
            <TextField
              name="slug"
              label={t("Address (optional)")}
              description={t("Left empty, one is generated. Titles that would make long links get a short one.")}
              value={slug}
              onChange={event => setSlug(event.target.value)}
            />
            <Button
              disabled={busy || !title.trim()}
              onClick={() =>
                void act(
                  () =>
                    api.send("POST", `imports/${job.id}/publish`, {
                      body: { title, parentPath: parent, ...withSlug(slug.trim() || slugForNewPage(title)) }
                    }),
                  t("Published")
                )
              }
            >
              {t("Publish")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void act(() => api.send("POST", `imports/${job.id}/discard`), t("Discarded"))}
            >
              {t("Discard")}
            </Button>
          </div>
          <DraftPreview markdown={job.draftMarkdown ?? ""} title={job.draftTitle ?? ""} space={space} />
        </>
      ) : null}
      {job.status === "failed" || job.status === "discarded" ? (
        <p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.send("POST", `imports/${job.id}/retry`), t("Started again"))}
          >
            {t("Process again")}
          </Button>
        </p>
      ) : null}
    </section>
  );
}

interface ArchiveReport {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly assets: number;
  readonly skipped: readonly { readonly file: string; readonly reason: string }[];
}

function ArchiveResult({ report }: { report: ArchiveReport }) {
  return (
    <section className="pd-import pd-archive-report" aria-label={t("Archive import result")}>
      <strong>
        {t(
          "Archive imported: {0} created, {1} updated, {2} unchanged, {3} {3|image|images}.",
          report.created,
          report.updated,
          report.unchanged,
          report.assets
        )}
      </strong>
      {report.skipped.length > 0 ? (
        <ul>
          {report.skipped.map(item => (
            <li key={item.file}>{t("{0}: {1}", item.file, item.reason)}</li>
          ))}
        </ul>
      ) : null}
      {/* The sidebar comes from when the app loaded. */}
      <p>
        <Button variant="outline" onClick={() => location.reload()}>
          {t("Refresh the page list")}
        </Button>
      </p>
    </section>
  );
}

export function ImportsView({ space }: { space: Space }) {
  const jobs = useLoaded(() => api.get<ImportJob[]>(`spaces/${space.slug}/imports`), [space.slug]);
  const tree = useLoaded(() => api.get<TreeEntry[]>(`spaces/${space.slug}/tree`), [space.slug]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [over, setOver] = React.useState(false);
  const [archive, setArchive] = React.useState<ArchiveReport | null>(null);
  const { reload } = jobs;
  const list = jobs.status === "ready" ? jobs.data : [];
  const inProgress = list.some(
    job => job.status === "queued" || job.status === "running" || job.status === "retry_wait"
  );
  React.useEffect(() => {
    if (!inProgress) return undefined;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [inProgress, reload]);
  const upload = async (files: readonly File[]) => {
    const tooBig = files.filter(file => file.size > MAX_BYTES);
    if (tooBig.length > 0)
      toast(t("A file can be at most 100 MB: {0}", tooBig.map(file => file.name).join(t(", "))), "error");
    const accepted = files.filter(file => file.size <= MAX_BYTES);
    if (accepted.length === 0) return;
    setUploading(true);
    let opened = false;
    // One at a time: one that fails is reported, and the rest still go through.
    for (const file of accepted) {
      try {
        if (/\.zip$/iu.test(file.name)) {
          const report = await api.uploadRaw<ArchiveReport>(`spaces/${space.slug}/archive`, file);
          setArchive(report);
          tree.reload();
        } else {
          const job = await api.upload<ImportJob>(`spaces/${space.slug}/imports`, file);
          // The first one opens, and the rest wait in the list right below it.
          if (!opened) setSelected(job.id);
          opened = true;
          reload();
        }
      } catch (error) {
        toast(t("{0}: {1}", file.name, failureMessage(error)), "error");
      }
    }
    setUploading(false);
  };
  const current = list.find(job => job.id === selected);
  return (
    <>
      <ManageHead
        title={t("{0}: import and export", space.name)}
        description={t(
          "Imported files become drafts to publish once you have checked them. An archive is written straight in: where a page at the same address differs, it gets a new version."
        )}
      >
        <a
          className="pd-btn pd-btn--icon"
          href={`${API_BASE}/spaces/${encodeURIComponent(space.slug)}/export`}
          download
        >
          <Download size={14} aria-hidden="true" />
          {t("Export all pages")}
        </a>
      </ManageHead>
      <label
        className={clsx("pd-drop", over && "pd-drop--over", uploading && "pd-drop--busy")}
        onDragOver={event => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={event => {
          event.preventDefault();
          setOver(false);
          void upload([...event.dataTransfer.files]);
        }}
      >
        <Upload size={20} aria-hidden="true" />
        <strong>{uploading ? t("Uploading files…") : t("Click to choose files, or drop them here")}</strong>
        <small>
          {t(
            "Markdown, Word, Excel, PowerPoint, PDF and web pages, several at a time, up to 100 MB each. An archive exported from here can be imported straight back."
          )}
        </small>
        <input
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          disabled={uploading}
          aria-label={t("Upload files to import")}
          onChange={event => {
            void upload([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </label>
      {archive ? <ArchiveResult report={archive} /> : null}
      {current ? (
        <JobDetail
          job={current}
          space={space}
          tree={tree.status === "ready" ? tree.data : []}
          onChanged={() => {
            setSelected(list.find(job => job.id !== current.id && isWaiting(job))?.id ?? current.id);
            reload();
            tree.reload();
          }}
        />
      ) : null}
      <h2>{t("Import history")}</h2>
      <LoadedContent loaded={jobs}>
        {data =>
          data.length === 0 ? (
            <EmptyState>{t("No imports yet.")}</EmptyState>
          ) : (
            <ul className="pd-notices">
              {data.map(job => (
                <li key={job.id}>
                  <button
                    type="button"
                    className={clsx("pd-notice-row", job.id === selected && "pd-notice-row--active")}
                    aria-current={job.id === selected ? "true" : undefined}
                    onClick={() => setSelected(job.id)}
                  >
                    <span>
                      {job.filename || job.draftTitle || t("Import job")}
                      <JobStatus job={job} />
                    </span>
                    <time>
                      {job.createdName} · {relativeTime(job.createdAt)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </LoadedContent>
      <BulkImports space={space} tree={tree.status === "ready" ? tree.data : []} onChanged={tree.reload} />
      <h2>{t("Export")}</h2>
      <p className="pd-muted">
        {t(
          'Exports every page you can read: the Markdown, the images it uses, and manifest.json with titles and order. For a single page, use "Copy Markdown" or "Export PDF" at the top of the page.'
        )}
      </p>
      <h2>{t("For agents")}</h2>
      <p className="pd-muted">
        {t("Agents can read these addresses with CLI credentials, limited to what that person can read: ")}
        <a href={pageUrl(`/${space.slug}/llms.txt`)} target="_blank" rel="noreferrer">
          llms.txt
        </a>
        {t(" (the page index), ")}
        <a href={pageUrl(`/${space.slug}/llms-full.txt`)} target="_blank" rel="noreferrer">
          llms-full.txt
        </a>
        {t(" (all the text). Add .md to a page's address to read its Markdown.")}
      </p>
    </>
  );
}
