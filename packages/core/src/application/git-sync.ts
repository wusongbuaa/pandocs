import { createHash, randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { inLanguage, t, type Language } from "@pandocs/i18n";
import { mergeThreeWay } from "@pandocs/markdown";
import { z } from "zod";
import type { Queryable } from "../infrastructure/db.js";
import { PandocsError, invalid, notFound } from "../domain/errors.js";
import type { DocumentRecord, Principal, SpaceRecord } from "../domain/types.js";
import type { GitRemote, GitWorkspace } from "../ports.js";
import type { AssetService } from "./assets.js";
import type { ChangeSetService } from "./change-sets.js";
import { audit, mapDocument, mapSpace, requireSpace, type AppContext } from "./context.js";
import { MAX_MARKDOWN_BYTES, validSlug, type DocumentService } from "./documents.js";
import type { ProposalService } from "./proposals.js";
import { loadRevision } from "./revisions.js";
import type { SiteService } from "./site.js";
import type { TreeService } from "./tree.js";

const POLL_SECONDS = 60;
const LEASE_SECONDS = 300;
const RENEW_MS = 60_000;
const BACKOFF_SECONDS = [60, 300, 1800];
const KEPT_RUNS = 50;
const MAX_NOTES = 200;
const LINES_IN_A_COMMIT = 50;
/** How much of a file has to be the same for it to have moved. Git's own default. */
const SIMILAR_ENOUGH = 0.5;
/** Comparing every file that left with every file that arrived is fine, until it is a whole repository reorganised. */
const MOST_COMPARISONS = 2500;
const META_FILE = ".pandocs/pages.json";
const ASSETS_DIR = "assets/";

const repositoryUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(
    value => {
      if (!/^https?:\/\//iu.test(value) || !URL.canParse(value)) return false;
      const url = new URL(value);
      return !url.username && !url.password;
    },
    { error: () => t("A repository's address starts with https://, and the token goes in its own field") }
  );

export const gitSyncInput = z
  .object({
    repository: repositoryUrl,
    branch: z
      .string()
      .trim()
      .regex(/^(?!-)(?!.*\.\.)[\w./-]{1,200}$/u, { error: () => t("That cannot be a branch's name") })
      .optional(),
    folder: z
      .string()
      .trim()
      .regex(/^(?!.*\.\.)(?!.*[^/]\/\/+[^/])[\p{L}\p{N}_./ -]{0,500}$/u, {
        error: () => t("That cannot be a folder in a repository")
      })
      .optional(),
    /** Left out, the one already there stays, as long as the repository does. */
    token: z.string().max(1000).optional(),
    firstSource: z.enum(["space", "repository"]).optional(),
    includeRestricted: z.boolean().optional(),
    enabled: z.boolean().optional()
  })
  .strict();

const plainText = z.string().refine(value => !value.includes("\0"));

const pagesFile = z.object({
  pages: z.record(
    z.string(),
    z.object({
      title: plainText.trim().pipe(z.string().min(1).max(200)).optional(),
      order: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
      labels: z.array(plainText).max(50).optional()
    })
  )
});
type PageDetails = z.output<typeof pagesFile>["pages"][string];

interface SyncRow {
  readonly id: string;
  readonly space_id: string;
  readonly repository: string;
  readonly branch: string;
  readonly folder: string;
  readonly token: string;
  readonly first_source: "space" | "repository";
  readonly include_restricted: boolean;
  readonly last_commit: string | null;
  readonly meta_blob: string | null;
  readonly last_success_at: string | null;
  readonly consecutive_failures: number;
}

/**
 * That page at this version and this content in the file were last the same. A version of 0 means they never were, so
 * the next push writes the page's text. While `pending`, what the file says is waiting in a change set.
 */
interface FileRecord {
  readonly path: string;
  readonly document_id: string | null;
  readonly revision_no: number;
  readonly blob_id: string;
  readonly pending: boolean;
}

interface Report {
  pulled: number;
  pushed: number;
  notes: { file: string; reason: string }[];
}

/** One look at one repository. */
interface Run {
  readonly sync: SyncRow;
  /** Which replica this run is, as the lease names it. */
  readonly owner: string;
  /** Stops the run once another replica may have taken the sync over. */
  readonly stillOurs: () => void;
  readonly space: SpaceRecord;
  readonly workspace: GitWorkspace;
  /** Whoever made the latest commit, as far as the pages' history is concerned. */
  readonly principal: Principal;
  readonly message: string;
  readonly report: Report;
  readonly records: Map<string, FileRecord>;
}

/** Another replica may be running this sync now, and two at once would undo each other's work. */
class LeaseLost extends Error {}

type Incoming =
  | {
      readonly kind: "create";
      readonly path: string;
      readonly blob: string;
      readonly title: string;
      readonly markdown: string;
    }
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly blob: string;
      readonly document: DocumentRecord;
      readonly markdown: string;
    }
  | { readonly kind: "delete"; readonly path: string; readonly blob: string; readonly document: DocumentRecord };

/** What one look has found, on its way through. */
interface Pull {
  readonly incoming: Incoming[];
  /** Places pages have left, where a page that only held them may now hold nothing. */
  readonly emptied: Set<string>;
  readonly details: Readonly<Record<string, PageDetails>>;
  /** Someone has yet to decide on what is in a change set from the repository. */
  readonly inReview: boolean;
}

/** The same identifier Git gives these bytes, so nothing unchanged has to be sent or read to find that out. */
export function gitBlobId(bytes: Uint8Array, algorithm: "sha1" | "sha256" = "sha1"): string {
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });
const ASSET_IN_PAGE = /(?<![\w/.-])assets\/([0-9a-f]{64}(?:\.[a-z0-9]+)?)/giu;
const ASSET_IN_FILE = /(?<![\w/.-])(?:\.\/)?(?:\.\.\/)*assets\/([0-9a-f]{64}(?:\.[a-z0-9]+)?)/giu;
const IMAGE = /(!\[[^\]\n]*\]\(\s*<?)([^)\s>]+)/gu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const depthOf = (path: string) => path.split("/").length;
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const slugOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The file a link means, whatever it says after that or however it has been escaped. */
function pathOfLink(target: string): string {
  const path = target.split(/[?#]/u, 1)[0]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Each line, and whether it is part of a code block, where nothing means what it looks like. */
function* linesOf(markdown: string): Generator<{ readonly line: string; readonly code: boolean }> {
  let fence = "";
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      yield { line, code: true };
    } else if (marker) {
      fence = marker;
      yield { line, code: true };
    } else {
      yield { line, code: false };
    }
  }
}

const linesToCompare = (text: string) =>
  new Set(
    text
      .replace(ASSET_IN_FILE, "assets/$1")
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean)
  );

function similarity(one: ReadonlySet<string>, other: ReadonlySet<string>): number {
  if (one.size === 0 || other.size === 0) return 0;
  let shared = 0;
  for (const line of one) if (other.has(line)) shared += 1;
  return (2 * shared) / (one.size + other.size);
}

/** What a file calls itself: in its front matter, as most documentation tools have it, or else in its first heading. */
function titleIn(markdown: string): string | undefined {
  const matter = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(markdown)?.[1];
  const named = matter ? /^title:[ \t]*(.+?)[ \t]*$/mu.exec(matter)?.[1]?.replace(/^(['"])(.*)\1$/u, "$2") : undefined;
  if (named) return named;
  for (const { line, code } of linesOf(markdown)) {
    const heading = code ? undefined : /^# +(.+?)(?: +#+)? *$/u.exec(line)?.[1];
    if (heading) return heading;
  }
  return undefined;
}

/**
 * A page says `assets/<hash>` wherever it is, so moving it needs no rewriting. In a repository, links are relative to the
 * file, or they would not work on the page where someone reads it there.
 */
function toFileText(markdown: string, pagePath: string): string {
  const up = "../".repeat(depthOf(pagePath) - 1);
  return up ? markdown.replace(ASSET_IN_PAGE, `${up}assets/$1`) : markdown;
}

/**
 * Keeps a space and a folder of a Git repository the same, in both directions. What is true stays in the database: each
 * run starts from a fresh copy, so any replica can do it, and what was last the same is what makes three-way merges possible.
 */
export class GitSyncService {
  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService,
    private readonly tree: TreeService,
    private readonly assets: AssetService,
    private readonly changeSets: ChangeSetService,
    private readonly proposals: ProposalService,
    private readonly site: SiteService
  ) {}

  get available(): boolean {
    return this.context.ports.git !== undefined;
  }

  private view(row: Record<string, unknown>) {
    return {
      repository: String(row.repository),
      branch: String(row.branch),
      folder: String(row.folder),
      hasToken: String(row.token) !== "",
      // It only says when to look, so whoever has it can do no more than make a sync come sooner.
      hookPath: `/api/v1/git-hooks/${String(row.hook_token)}`,
      firstSource: String(row.first_source),
      includeRestricted: Boolean(row.include_restricted),
      enabled: Boolean(row.enabled),
      running: row.lease_owner !== null && new Date(row.lease_until as string).getTime() > Date.now(),
      lastCommit: row.last_commit ? String(row.last_commit) : null,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at as string).toISOString() : null,
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at as string).toISOString() : null,
      lastError: row.last_error ? String(row.last_error) : null
    };
  }

  async get(principal: Principal, spaceSlug: string) {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "admin");
    const { rows } = await db.query(`SELECT * FROM pandocs.git_syncs WHERE space_id = $1`, [space.id]);
    return { available: this.available, sync: rows[0] ? this.view(rows[0]) : null };
  }

  async put(principal: Principal, spaceSlug: string, input: z.output<typeof gitSyncInput>) {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "admin");
    if (!this.available) throw invalid("GIT_UNAVAILABLE", t("This server cannot run Git"));
    const folder = (input.folder ?? "").replace(/^\/+|\/+$/gu, "");
    const branch = input.branch ?? "main";
    const firstSource = input.firstSource ?? "space";
    const includeRestricted = input.includeRestricted ?? false;
    const enabled = input.enabled ?? true;
    return db.transaction(async tx => {
      const {
        rows: [before]
      } = await tx.query<SyncRow>(`SELECT * FROM pandocs.git_syncs WHERE space_id = $1 FOR UPDATE`, [space.id]);
      if (!before) {
        const { rows } = await tx.query(
          `INSERT INTO pandocs.git_syncs (space_id, repository, branch, folder, token, hook_token, first_source, include_restricted, enabled, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            space.id,
            input.repository,
            branch,
            folder,
            input.token ?? "",
            randomBytes(24).toString("base64url"),
            firstSource,
            includeRestricted,
            enabled,
            principal.id
          ]
        );
        await audit(tx, principal, "space.git_sync.set", "space", space.id, {
          repository: input.repository,
          branch,
          folder
        });
        return this.view(rows[0]!);
      }
      // A token only ever goes to where it was given for. Being able to change the address must not be a way to collect it.
      const token = input.token ?? (before.repository === input.repository ? before.token : "");
      // Somewhere else is not the same files gone. What was known about the old place says nothing about the new one.
      const elsewhere = before.repository !== input.repository || before.branch !== branch || before.folder !== folder;
      if (elsewhere) await tx.query(`DELETE FROM pandocs.git_sync_files WHERE sync_id = $1`, [before.id]);
      const { rows } = await tx.query(
        `UPDATE pandocs.git_syncs SET repository = $2, branch = $3, folder = $4, token = $5, first_source = $6, include_restricted = $7, enabled = $8, due_at = now(), consecutive_failures = 0, last_error = NULL, updated_at = now(),
           last_commit = CASE WHEN $9 THEN NULL ELSE last_commit END, meta_blob = CASE WHEN $9 THEN NULL ELSE meta_blob END, last_success_at = CASE WHEN $9 THEN NULL ELSE last_success_at END
         WHERE id = $1 RETURNING *`,
        [before.id, input.repository, branch, folder, token, firstSource, includeRestricted, enabled, elsewhere]
      );
      await audit(tx, principal, "space.git_sync.set", "space", space.id, {
        repository: input.repository,
        branch,
        folder
      });
      return this.view(rows[0]!);
    });
  }

  /** The repository and the pages stay as they are. Connecting again later starts by comparing the two. */
  async remove(principal: Principal, spaceSlug: string): Promise<void> {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "admin");
    await db.transaction(async tx => {
      await tx.query(`DELETE FROM pandocs.git_syncs WHERE space_id = $1`, [space.id]);
      await audit(tx, principal, "space.git_sync.remove", "space", space.id);
    });
  }

  async runNow(principal: Principal, spaceSlug: string): Promise<void> {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "admin");
    const { rows } = await db.query(`UPDATE pandocs.git_syncs SET due_at = now() WHERE space_id = $1 RETURNING id`, [
      space.id
    ]);
    if (!rows[0]) throw notFound(t("Git sync"));
  }

  async runs(principal: Principal, spaceSlug: string) {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "admin");
    const { rows } = await db.query(
      `SELECT r.* FROM pandocs.git_sync_runs r JOIN pandocs.git_syncs s ON s.id = r.sync_id WHERE s.space_id = $1 ORDER BY r.started_at DESC LIMIT $2`,
      [space.id, KEPT_RUNS]
    );
    return rows.map(row => ({
      startedAt: new Date(row.started_at as string).toISOString(),
      head: row.head ? String(row.head) : null,
      pulled: Number(row.pulled),
      pushed: Number(row.pushed),
      notes: (row.notes ?? []) as { file: string; reason: string }[],
      error: row.error ? String(row.error) : null
    }));
  }

  /** For the repository's own webhook. Knowing the address is all it takes, and all it does is make the next look come sooner. */
  async hook(token: string): Promise<boolean> {
    const { rows } = await this.context.db.query(
      `UPDATE pandocs.git_syncs SET due_at = now() WHERE hook_token = $1 AND enabled RETURNING id`,
      [token]
    );
    return rows.length > 0;
  }

  /** Looks at one sync that is due. */
  async tick(): Promise<boolean> {
    const {
      db,
      ports: { git }
    } = this.context;
    if (!git) return false;
    const owner = randomUUID();
    const { rows } = await db.query<SyncRow>(
      `UPDATE pandocs.git_syncs SET lease_owner = $1, lease_until = now() + make_interval(secs => $2), last_run_at = now(), due_at = now() + make_interval(secs => $3)
       WHERE id = (SELECT id FROM pandocs.git_syncs WHERE enabled AND due_at <= now() AND (lease_until IS NULL OR lease_until < now()) ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
      [owner, LEASE_SECONDS, POLL_SECONDS]
    );
    if (!rows[0]) return false;
    const { defaultLang } = await this.site.get();
    await inLanguage(defaultLang as Language, () => this.run(rows[0]!, owner));
    return true;
  }

  private async run(sync: SyncRow, owner: string): Promise<void> {
    const {
      db,
      ports: { git }
    } = this.context;
    const startedAt = new Date();
    const report: Report = { pulled: 0, pushed: 0, notes: [] };
    const remote: GitRemote = { repository: sync.repository, branch: sync.branch, token: sync.token };
    let head: string | null = null;
    let workspace: GitWorkspace | null = null;
    const finished = () =>
      db.query(
        `UPDATE pandocs.git_syncs SET last_commit = $2, last_success_at = $3, last_error = NULL, consecutive_failures = 0, lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $4`,
        [sync.id, head, startedAt, owner]
      );
    // A large repository can take longer than a lease, and another replica starting over meanwhile would only get in the way.
    // A renewal that finds the lease taken, or that has not got through for as long as a lease lasts, ends the run before
    // it writes anything more.
    let held = true;
    let renewedAt = Date.now();
    const renewal = setInterval(() => {
      db.query(
        `UPDATE pandocs.git_syncs SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2 RETURNING 1`,
        [sync.id, owner, LEASE_SECONDS]
      ).then(
        ({ rows }) => {
          if (rows.length > 0) renewedAt = Date.now();
          else held = false;
        },
        () => {
          if (Date.now() - renewedAt >= LEASE_SECONDS * 1000) held = false;
        }
      );
    }, RENEW_MS);
    renewal.unref();
    const stillOurs = () => {
      if (!held) throw new LeaseLost();
    };
    try {
      const { rows: spaces } = await db.query(`SELECT * FROM pandocs.spaces WHERE id = $1 AND deleted_at IS NULL`, [
        sync.space_id
      ]);
      if (!spaces[0]) {
        await db.query(
          `UPDATE pandocs.git_syncs SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2`,
          [sync.id, owner]
        );
        return;
      }
      head = await git!.head(remote);
      if (head === sync.last_commit && sync.last_success_at && !(await this.changedHere(sync))) {
        await finished();
        return;
      }
      workspace = await git!.open(remote);
      head = workspace.head;
      const records = await this.records(sync.id);
      const name = workspace.author?.name;
      const run: Run = {
        sync,
        owner,
        stillOurs,
        space: mapSpace(spaces[0]),
        workspace,
        report,
        records,
        principal: {
          id: this.actorId(sync),
          kind: "user",
          displayName: name ? t("{0} (through Git)", name) : t("Git"),
          groups: [],
          isAdmin: true,
          scopes: ["read", "write"],
          channel: "git"
        },
        message: (workspace.author?.subject || t("From Git")).slice(0, 200)
      };
      await this.pull(run);
      head = (await this.push(run)) ?? head;
      await finished();
      await this.keepRun(sync.id, startedAt, head, report, null);
    } catch (error) {
      // Whichever replica has it now carries on, and this one has nothing to record.
      if (error instanceof LeaseLost) return;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const wait = BACKOFF_SECONDS[Math.min(sync.consecutive_failures, BACKOFF_SECONDS.length - 1)]!;
      await db.query(
        `UPDATE pandocs.git_syncs SET last_error = $2, consecutive_failures = consecutive_failures + 1, due_at = now() + make_interval(secs => $3), lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $4`,
        [sync.id, message, wait, owner]
      );
      await this.keepRun(sync.id, startedAt, head, report, message);
    } finally {
      clearInterval(renewal);
      await workspace?.dispose();
    }
  }

  private actorId(sync: Pick<SyncRow, "space_id">): string {
    return `git-sync:${sync.space_id}`;
  }

  /** A run that changed nothing is not worth a line in the record. */
  private async keepRun(
    syncId: string,
    startedAt: Date,
    head: string | null,
    report: Report,
    error: string | null
  ): Promise<void> {
    if (!error && report.pulled === 0 && report.pushed === 0 && report.notes.length === 0) return;
    const { db } = this.context;
    const notes =
      report.notes.length > MAX_NOTES
        ? [
            ...report.notes.slice(0, MAX_NOTES),
            { file: "", reason: t("And {0} more", report.notes.length - MAX_NOTES) }
          ]
        : report.notes;
    await db.query(
      `INSERT INTO pandocs.git_sync_runs (sync_id, started_at, head, pulled, pushed, notes, error) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [syncId, startedAt, head, report.pulled, report.pushed, JSON.stringify(notes), error]
    );
    await db.query(
      `DELETE FROM pandocs.git_sync_runs WHERE sync_id = $1 AND id NOT IN (SELECT id FROM pandocs.git_sync_runs WHERE sync_id = $1 ORDER BY started_at DESC LIMIT $2)`,
      [syncId, KEPT_RUNS]
    );
  }

  /** Whether a look is worth more than asking where the branch is. The margin is for a save still being committed when the last one started. */
  private async changedHere(sync: SyncRow): Promise<boolean> {
    const { rows } = await this.context.db.query<{ changed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pandocs.documents WHERE space_id = $1 AND updated_at > $2::timestamptz - interval '30 seconds')
         OR EXISTS (SELECT 1 FROM pandocs.git_sync_files f WHERE f.sync_id = $3 AND f.pending AND NOT EXISTS (SELECT 1 FROM pandocs.change_sets c WHERE c.space_id = $1 AND c.author_id = $4 AND c.status = 'open')) AS changed`,
      [sync.space_id, sync.last_success_at, sync.id, this.actorId(sync)]
    );
    return Boolean(rows[0]?.changed);
  }

  private async openReview(sync: SyncRow): Promise<string | null> {
    const { rows } = await this.context.db.query<{ id: string }>(
      `SELECT id FROM pandocs.change_sets WHERE space_id = $1 AND author_id = $2 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [sync.space_id, this.actorId(sync)]
    );
    return rows[0]?.id ?? null;
  }

  private async records(syncId: string): Promise<Map<string, FileRecord>> {
    const { rows } = await this.context.db.query<FileRecord>(
      `SELECT path, document_id, revision_no, blob_id, pending FROM pandocs.git_sync_files WHERE sync_id = $1`,
      [syncId]
    );
    return new Map(rows.map(row => [row.path, row]));
  }

  /** What a file was when the two sides last agreed, written only while the lease is still this run's. */
  private async remember(
    run: Run,
    path: string,
    documentId: string | null,
    revision: number,
    blob: string,
    pending = false
  ): Promise<void> {
    run.stillOurs();
    const { rowCount } = await this.context.db.query(
      `INSERT INTO pandocs.git_sync_files (sync_id, path, document_id, revision_no, blob_id, pending)
       SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM pandocs.git_syncs WHERE id = $1 AND lease_owner = $7)
       ON CONFLICT (sync_id, path) DO UPDATE SET document_id = $3, revision_no = $4, blob_id = $5, pending = $6`,
      [run.sync.id, path, documentId, revision, blob, pending, run.owner]
    );
    if (!rowCount) throw new LeaseLost();
    run.records.set(path, { path, document_id: documentId, revision_no: revision, blob_id: blob, pending });
  }

  private async forget(run: Run, path: string): Promise<void> {
    run.stillOurs();
    await this.context.db.query(
      `DELETE FROM pandocs.git_sync_files WHERE sync_id = $1 AND path = $2 AND EXISTS (SELECT 1 FROM pandocs.git_syncs WHERE id = $1 AND lease_owner = $3)`,
      [run.sync.id, path, run.owner]
    );
    run.records.delete(path);
  }

  private prefixOf(sync: SyncRow): string {
    return sync.folder ? `${sync.folder}/` : "";
  }

  private fileOf(sync: SyncRow, pagePath: string): string {
    return `${this.prefixOf(sync)}${pagePath}.md`;
  }

  private hidden(run: Run, document: DocumentRecord): boolean {
    return document.restricted && !run.sync.include_restricted;
  }

  /** The Markdown files in the folder, as the pages they would be. */
  private pagesInRepository({ sync, workspace, report }: Run): Map<string, string> {
    const prefix = this.prefixOf(sync);
    const pages = new Map<string, string>();
    for (const [file, blob] of workspace.files) {
      if (!file.startsWith(prefix) || !file.endsWith(".md")) continue;
      const path = file.slice(prefix.length, -".md".length);
      const segments = path.split("/");
      // Folders of tooling, such as .github, were never pages.
      if (segments.some(segment => segment.startsWith("."))) continue;
      if (!segments.every(validSlug)) {
        report.notes.push({ file, reason: t("This name cannot be a page's address") });
        continue;
      }
      pages.set(path, blob);
    }
    return pages;
  }

  private async readDetails({ sync, workspace, report }: Run): Promise<Readonly<Record<string, PageDetails>>> {
    const file = `${this.prefixOf(sync)}${META_FILE}`;
    if (!workspace.files.has(file)) return {};
    try {
      return pagesFile.parse(JSON.parse(decoder.decode(await workspace.read(file)))).pages;
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      report.notes.push({ file, reason: t("This file could not be read, so titles and order come from the pages") });
      return {};
    }
  }

  /** Text as a page has it, or null with a note if the file cannot be one. Pictures a file points to by its own path are stored, and referred to as any page's are. */
  private async pageText(run: Run, file: string): Promise<string | null> {
    const { space, workspace, principal, report } = run;
    const bytes = await workspace.read(file);
    if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
      report.notes.push({ file, reason: t("The document is larger than 2 MiB") });
      return null;
    }
    if (bytes.includes(0)) {
      report.notes.push({ file, reason: t("This is not a text file") });
      return null;
    }
    const text = decoder.decode(bytes).replace(/\r\n/gu, "\n").replace(ASSET_IN_FILE, "assets/$1");
    const directory = posix.dirname(file);
    const stored = new Map<string, string | null>();
    const lines: string[] = [];
    for (const { line, code } of linesOf(text)) {
      let rewritten = line;
      for (const [whole, before = "", target = ""] of code ? [] : line.matchAll(IMAGE)) {
        if (/^[a-z][a-z0-9+.-]*:|^\/|^#|^assets\/[0-9a-f]{64}/iu.test(target)) continue;
        const inRepository = posix.normalize(posix.join(directory, pathOfLink(target)));
        if (!workspace.files.has(inRepository)) {
          report.notes.push({ file, reason: t("A picture it shows is not in the repository: {0}", target) });
          continue;
        }
        if (!stored.has(inRepository)) {
          try {
            stored.set(
              inRepository,
              (
                await this.assets.put(
                  principal,
                  space.slug,
                  await workspace.read(inRepository),
                  posix.basename(inRepository)
                )
              ).path
            );
          } catch (error) {
            if (!(error instanceof PandocsError)) throw error;
            report.notes.push({ file: inRepository, reason: error.message });
            stored.set(inRepository, null);
          }
        }
        const path = stored.get(inRepository);
        if (path) rewritten = rewritten.replace(whole, () => `${before}${path}`);
      }
      lines.push(rewritten);
    }
    return lines.join("\n");
  }

  private async lockedDocument(tx: Queryable, id: string): Promise<DocumentRecord | null> {
    const { rows } = await tx.query(`SELECT * FROM pandocs.documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [
      id
    ]);
    return rows[0] ? mapDocument(rows[0]) : null;
  }

  private async liveDocument(id: string): Promise<DocumentRecord | null> {
    const { rows } = await this.context.db.query(
      `SELECT * FROM pandocs.documents WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return rows[0] ? mapDocument(rows[0]) : null;
  }

  private async documentAt(space: SpaceRecord, path: string): Promise<DocumentRecord | null> {
    const { rows } = await this.context.db.query(
      `SELECT * FROM pandocs.documents WHERE space_id = $1 AND lower(path) = lower($2) AND deleted_at IS NULL`,
      [space.id, path]
    );
    return rows[0] ? mapDocument(rows[0]) : null;
  }

  private async commit(documentId: string, { principal, message }: Run, markdown: string): Promise<number | null> {
    return this.context.db.transaction(async tx => {
      const document = await this.lockedDocument(tx, documentId);
      return document
        ? (await this.documents.commit(tx, principal, document, { markdown, message })).revision.no
        : null;
    });
  }

  /** A page needs somewhere to go, and a folder in a repository needs no file of its own. */
  private async ensureParents({ space, principal, message }: Run, path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    for (let at = 1; at <= segments.length; at += 1) {
      const parent = segments.slice(0, at).join("/");
      if (await this.documentAt(space, parent)) continue;
      const above = segments.slice(0, at - 1).join("/");
      await this.context.db.transaction(tx =>
        this.documents.createIn(tx, principal, space, {
          title: segments[at - 1]!,
          slug: segments[at - 1]!,
          ...(above ? { parentPath: above } : {}),
          markdown: "",
          message
        })
      );
    }
  }

  /** One file should not hold up all the others, so what the rules refuse goes in the record, and anything else stops the run. */
  private async attempt({ report, stillOurs }: Run, file: string, work: () => Promise<void>): Promise<void> {
    stillOurs();
    try {
      await work();
    } catch (error) {
      if (!(error instanceof PandocsError)) throw error;
      report.notes.push({ file, reason: error.message });
    }
  }

  private async pull(run: Run): Promise<void> {
    const { sync, space, workspace, records } = run;
    // A branch with nothing on it was deleted, which is not the same as someone deleting every page. It gets them all back.
    if (!workspace.head) return;
    const reviewOnly = space.mergeRules.requireChangeSets;
    await this.adoptMerged(run);
    const inRepository = this.pagesInRepository(run);
    const pull: Pull = {
      incoming: [],
      emptied: new Set(),
      details: await this.readDetails(run),
      inReview: (await this.openReview(sync)) !== null
    };
    const arrived: { path: string; blob: string }[] = [];
    const changed: { path: string; blob: string; record: FileRecord; document: DocumentRecord }[] = [];
    for (const [path, blob] of inRepository) {
      const record = records.get(path);
      if (record?.blob_id === blob) continue;
      const document = record?.document_id ? await this.liveDocument(record.document_id) : null;
      if (document) {
        changed.push({ path, blob, record: record!, document });
      } else {
        // Its page is gone from here, or was never made, and now there is new text. That makes it a new page.
        if (record) await this.forget(run, path);
        arrived.push({ path, blob });
      }
    }
    await workspace.prefetch([...arrived, ...changed].map(({ path }) => this.fileOf(sync, path)));
    const gone = [...records.values()].filter(record => !inRepository.has(record.path));
    if (!reviewOnly) {
      await this.followMoves(run, gone, arrived, pull);
      await this.followEditedMoves(run, gone, arrived, changed, pull);
    }
    // What is above something comes before it, and what is below something goes before it.
    for (const arrival of arrived.sort((a, b) => depthOf(a.path) - depthOf(b.path)))
      await this.attempt(run, this.fileOf(sync, arrival.path), () => this.arrive(run, arrival, pull));
    for (const change of changed)
      await this.attempt(run, this.fileOf(sync, change.path), () => this.change(run, change, pull));
    for (const record of gone.sort((a, b) => depthOf(b.path) - depthOf(a.path)))
      await this.attempt(run, this.fileOf(sync, record.path), () => this.depart(run, record, pull));
    if (pull.incoming.length > 0) await this.throughReview(run, pull.incoming);
    await this.tidyEmptied(run, pull.emptied);
    const detailsBlob = workspace.files.get(`${this.prefixOf(sync)}${META_FILE}`);
    if (!reviewOnly && detailsBlob && detailsBlob !== sync.meta_blob) await this.applyDetails(run, pull.details);
  }

  /** Pages that came in through a change set someone has now merged. */
  private async adoptMerged(run: Run): Promise<void> {
    for (const record of [...run.records.values()]) {
      if (record.document_id || !record.pending) continue;
      const document = await this.documentAt(run.space, record.path);
      if (document) await this.remember(run, record.path, document.id, document.currentRevisionNo, record.blob_id);
    }
  }

  /** A file that left one place with the same content it arrived with in another has moved, and comments should stay with it. */
  private async followMoves(
    run: Run,
    gone: FileRecord[],
    arrived: { path: string; blob: string }[],
    pull: Pull
  ): Promise<void> {
    const { space, report } = run;
    for (const record of [...gone].sort((a, b) => depthOf(a.path) - depthOf(b.path))) {
      const arrival = arrived.find(item => item.blob === record.blob_id);
      if (!arrival || !record.document_id) continue;
      const document = await this.liveDocument(record.document_id);
      if (!document || this.hidden(run, document)) continue;
      const here = await this.documentAt(space, arrival.path);
      if (here && here.id !== document.id) continue;
      // Otherwise it is already there, having moved with the page above it.
      if (!here) {
        if (!(await this.moveTo(run, document, arrival.path))) continue;
        report.pulled += 1;
      }
      await this.forget(run, record.path);
      await this.remember(run, arrival.path, document.id, record.revision_no, arrival.blob);
      pull.emptied.add(record.path);
      arrived.splice(arrived.indexOf(arrival), 1);
      gone.splice(gone.indexOf(record), 1);
    }
  }

  /** The same for a file that was edited as well. What comes after that is what happens to any changed file, with its page in its new place. */
  private async followEditedMoves(
    run: Run,
    gone: FileRecord[],
    arrived: { path: string; blob: string }[],
    changed: { path: string; blob: string; record: FileRecord; document: DocumentRecord }[],
    pull: Pull
  ): Promise<void> {
    const { sync, space, workspace } = run;
    if (gone.length === 0 || arrived.length === 0 || gone.length * arrived.length > MOST_COMPARISONS) return;
    const theirs = new Map<string, ReadonlySet<string>>();
    for (const { path } of arrived) {
      const bytes = await workspace.read(this.fileOf(sync, path));
      if (bytes.byteLength <= MAX_MARKDOWN_BYTES && !bytes.includes(0))
        theirs.set(path, linesToCompare(decoder.decode(bytes)));
    }
    for (const record of [...gone].sort((a, b) => depthOf(a.path) - depthOf(b.path))) {
      if (!record.document_id || record.revision_no === 0) continue;
      const document = await this.liveDocument(record.document_id);
      if (!document || this.hidden(run, document)) continue;
      const ours = linesToCompare((await loadRevision(this.context.db, document.id, record.revision_no)).markdown);
      let arrival: { path: string; blob: string } | null = null;
      let best = SIMILAR_ENOUGH;
      for (const item of arrived) {
        const score = similarity(ours, theirs.get(item.path) ?? new Set());
        if (score >= best) {
          arrival = item;
          best = score;
        }
      }
      if (!arrival || (await this.documentAt(space, arrival.path)) || !(await this.moveTo(run, document, arrival.path)))
        continue;
      await this.forget(run, record.path);
      await this.remember(run, arrival.path, document.id, record.revision_no, record.blob_id);
      changed.push({ path: arrival.path, blob: arrival.blob, record: { ...record, path: arrival.path }, document });
      pull.emptied.add(record.path);
      arrived.splice(arrived.indexOf(arrival), 1);
      gone.splice(gone.indexOf(record), 1);
    }
  }

  private async moveTo(run: Run, document: DocumentRecord, path: string): Promise<boolean> {
    let moved = false;
    await this.attempt(run, this.fileOf(run.sync, path), async () => {
      await this.ensureParents(run, path);
      const parent = parentOf(path) ? await this.documentAt(run.space, parentOf(path)) : null;
      await this.tree.moveIn(run.principal, document.id, { parentId: parent?.id ?? null, slug: slugOf(path) });
      moved = true;
    });
    return moved;
  }

  private async arrive(run: Run, { path, blob }: { path: string; blob: string }, pull: Pull): Promise<void> {
    const { sync, space, principal, message, report } = run;
    const reviewOnly = space.mergeRules.requireChangeSets;
    const file = this.fileOf(sync, path);
    const markdown = await this.pageText(run, file);
    if (markdown === null) return;
    const existing = await this.documentAt(space, path);
    if (!existing) {
      const details = pull.details[path];
      const title = (details?.title ?? titleIn(markdown) ?? slugOf(path)).slice(0, 200);
      if (reviewOnly) {
        pull.incoming.push({ kind: "create", path, blob, title, markdown });
        return;
      }
      await this.ensureParents(run, path);
      const parentPath = parentOf(path);
      const made = await this.context.db.transaction(tx =>
        this.documents.createIn(tx, principal, space, {
          title,
          slug: slugOf(path),
          ...(parentPath ? { parentPath } : {}),
          ...(details?.order === undefined ? {} : { sortOrder: details.order }),
          markdown,
          message
        })
      );
      await this.remember(run, path, made.document.id, made.revision.no, blob);
      report.pulled += 1;
      return;
    }
    if (existing.path !== path) {
      report.notes.push({
        file,
        reason: t("Another page's address differs from this only in its capitals: {0}", existing.path)
      });
      return;
    }
    if (this.hidden(run, existing)) {
      report.notes.push({
        file,
        reason: t("Only some people can read this page, so it is not kept the same as the repository")
      });
      return;
    }
    const { markdown: ours } = await loadRevision(this.context.db, existing.id, existing.currentRevisionNo);
    if (ours === markdown) {
      await this.remember(run, path, existing.id, existing.currentRevisionNo, blob);
      return;
    }
    // The same address on both sides, and nothing to say which came first. The first time, someone has chosen.
    const firstTime = !sync.last_success_at;
    if (ours === "" || (firstTime && sync.first_source === "repository")) {
      if (reviewOnly) {
        pull.incoming.push({ kind: "edit", path, blob, document: existing, markdown });
        return;
      }
      await this.remember(
        run,
        path,
        existing.id,
        (await this.commit(existing.id, run, markdown)) ?? existing.currentRevisionNo,
        blob
      );
      report.pulled += 1;
      return;
    }
    if (!firstTime) await this.suggest(run, existing, markdown, file, existing.currentRevisionNo);
    await this.remember(run, path, existing.id, 0, blob);
  }

  private async change(
    run: Run,
    { path, blob, record, document }: { path: string; blob: string; record: FileRecord; document: DocumentRecord },
    pull: Pull
  ): Promise<void> {
    const { space, principal, message, report } = run;
    const file = this.fileOf(run.sync, path);
    if (this.hidden(run, document)) {
      report.notes.push({
        file,
        reason: t("Only some people can read this page, so it is not kept the same as the repository")
      });
      return;
    }
    const markdown = await this.pageText(run, file);
    if (markdown === null) {
      // Writing this side's text over it would be a strange answer to its being too large.
      await this.remember(run, path, document.id, record.revision_no, blob);
      return;
    }
    if (space.mergeRules.requireChangeSets) {
      pull.incoming.push({ kind: "edit", path, blob, document, markdown });
      return;
    }
    // Changed on both sides, different places merge, and the same place is left for a person, with nothing lost either way.
    const { db, registry } = this.context;
    const revision = await db.transaction(async tx => {
      const locked = await this.lockedDocument(tx, document.id);
      if (!locked) return null;
      if (locked.currentRevisionNo === record.revision_no)
        return (await this.documents.commit(tx, principal, locked, { markdown, message })).revision.no;
      if (record.revision_no === 0) return null;
      const base = await loadRevision(tx, locked.id, record.revision_no);
      const ours = await loadRevision(tx, locked.id, locked.currentRevisionNo);
      const merged = mergeThreeWay(base.markdown, markdown, ours.markdown, registry);
      if (!merged.ok) return null;
      await this.documents.commit(tx, principal, locked, { markdown: merged.markdown, message });
      // Not the same as the file yet, so the merged text still has to go back.
      return record.revision_no;
    });
    if (revision !== null) {
      await this.remember(run, path, document.id, revision, blob);
      report.pulled += 1;
      return;
    }
    await this.suggest(run, document, markdown, file, record.revision_no || document.currentRevisionNo);
    await this.remember(run, path, document.id, record.revision_no, blob);
  }

  private async depart(run: Run, record: FileRecord, pull: Pull): Promise<void> {
    const { space, principal, report } = run;
    const file = this.fileOf(run.sync, record.path);
    const document = record.document_id ? await this.liveDocument(record.document_id) : null;
    if (!document || this.hidden(run, document) || (record.pending && !pull.inReview)) {
      // Gone from here too, or not this sync's business, or someone has turned down deleting it, so the file goes back.
      await this.forget(run, record.path);
      return;
    }
    if (document.currentRevisionNo !== record.revision_no) {
      // Changed here and deleted there: it stays, and goes back. Losing work should take someone deciding to.
      report.notes.push({ file, reason: t("Deleted in the repository but changed here, so it was kept") });
      await this.forget(run, record.path);
      return;
    }
    if (space.mergeRules.requireChangeSets) {
      pull.incoming.push({ kind: "delete", path: record.path, blob: record.blob_id, document });
      return;
    }
    const { db } = this.context;
    try {
      await db.transaction(async tx => {
        const locked = await this.lockedDocument(tx, document.id);
        if (locked) await this.tree.removeIn(tx, principal, locked, space);
      });
    } catch (error) {
      if (!(error instanceof PandocsError) || error.code !== "DOCUMENT_HAS_CHILDREN") throw error;
      // The pages below it are still wanted. What is left is what a folder is here: a page with no text.
      await this.commit(document.id, run, "");
    }
    await this.forget(run, record.path);
    pull.emptied.add(record.path);
    report.pulled += 1;
  }

  /** A person decides what could not be merged. The page keeps its text meanwhile, and the repository gets that too. */
  private async suggest(
    { principal, message, report }: Run,
    document: DocumentRecord,
    markdown: string,
    file: string,
    baseRevision: number
  ): Promise<void> {
    try {
      await this.proposals.create(principal, document.id, {
        baseRevision,
        markdown,
        rationale: t("From Git: {0}", message)
      });
      report.notes.push({
        file,
        reason: t(
          "Changed in the same place on both sides. The page keeps its text, and the repository's is a suggestion on it"
        )
      });
    } catch (error) {
      if (!(error instanceof PandocsError) || error.code !== "PROPOSAL_EMPTY") throw error;
    }
  }

  /** In a space where everything goes through review, what comes from the repository does too. It goes back once someone has merged it. */
  private async throughReview(run: Run, incoming: readonly Incoming[]): Promise<void> {
    const { sync, space, principal, message, report } = run;
    const id =
      (await this.openReview(sync)) ??
      (await this.changeSets.create(principal, space.slug, { title: t("From Git: {0}", message).slice(0, 200) })).id;
    const creating = new Set(incoming.flatMap(change => (change.kind === "create" ? [change.path.toLowerCase()] : [])));
    let added = 0;
    for (const change of incoming) {
      await this.attempt(run, this.fileOf(sync, change.path), async () => {
        if (change.kind === "create") {
          const segments = change.path.split("/");
          for (let at = 1; at < segments.length; at += 1) {
            const parent = segments.slice(0, at).join("/");
            if (creating.has(parent.toLowerCase()) || (await this.documentAt(space, parent))) continue;
            await this.changeSets.putPage(principal, id, { path: parent, title: segments[at - 1]!, markdown: "" });
            creating.add(parent.toLowerCase());
          }
          await this.changeSets.putPage(principal, id, {
            path: change.path,
            title: change.title,
            markdown: change.markdown
          });
          await this.remember(run, change.path, null, 0, change.blob, true);
        } else {
          const baseRevision = change.document.currentRevisionNo;
          await this.changeSets.putPage(
            principal,
            id,
            change.kind === "delete"
              ? { document: change.document.id, baseRevision, delete: true }
              : { document: change.document.id, baseRevision, markdown: change.markdown }
          );
          await this.remember(run, change.path, change.document.id, baseRevision, change.blob, true);
        }
        added += 1;
      });
    }
    if (added > 0)
      report.notes.push({
        file: "",
        reason: t("{0} {0|change|changes} from the repository went into a change set for review", added)
      });
  }

  /** A page made only to hold what was below it does not need to outlast that. */
  private async tidyEmptied(run: Run, emptied: ReadonlySet<string>): Promise<void> {
    const { space, principal, records } = run;
    const { db } = this.context;
    for (const path of emptied) {
      const segments = path.split("/");
      for (let at = segments.length - 1; at > 0; at -= 1) {
        const above = segments.slice(0, at).join("/");
        if (records.has(above)) break;
        const document = await this.documentAt(space, above);
        if (!document) continue;
        const { markdown } = await loadRevision(db, document.id, document.currentRevisionNo);
        if (markdown !== "" || this.hidden(run, document)) break;
        try {
          await db.transaction(async tx => {
            const locked = await this.lockedDocument(tx, document.id);
            if (locked) await this.tree.removeIn(tx, principal, locked, space);
          });
        } catch (error) {
          if (!(error instanceof PandocsError) || error.code !== "DOCUMENT_HAS_CHILDREN") throw error;
          break;
        }
      }
    }
  }

  private async applyDetails(run: Run, details: Readonly<Record<string, PageDetails>>): Promise<void> {
    const { sync, space, principal } = run;
    const { db } = this.context;
    for (const [path, page] of Object.entries(details)) {
      await this.attempt(run, this.fileOf(sync, path), async () => {
        const document = await this.documentAt(space, path);
        if (!document || document.path !== path || this.hidden(run, document)) return;
        const patch = {
          ...(page.title !== undefined && page.title !== document.title ? { title: page.title } : {}),
          ...(page.order !== undefined && page.order !== document.sortOrder ? { sortOrder: page.order } : {})
        };
        if (Object.keys(patch).length > 0) await this.documents.updateMeta(principal, document.id, patch);
        if (!page.labels) return;
        const { rows } = await db.query<{ label: string }>(
          `SELECT label FROM pandocs.document_labels WHERE document_id = $1 ORDER BY lower(label)`,
          [document.id]
        );
        if (rows.map(row => row.label).join("\n") !== page.labels.join("\n"))
          await this.documents.setLabels(principal, document.id, page.labels);
      });
    }
  }

  private async push(run: Run): Promise<string | null> {
    const { sync, space, workspace, principal, report, records } = run;
    const prefix = this.prefixOf(sync);
    const inReview = (await this.openReview(sync)) !== null;
    const nodes = (await this.documents.tree(principal, space.slug)).filter(
      node => sync.include_restricted || !node.restricted
    );
    const nodeOf = new Map(nodes.map(node => [node.id, node]));
    const recordOf = new Map(
      [...records.values()].flatMap(record => (record.document_id ? [[record.document_id, record] as const] : []))
    );
    const holdsOthers = new Set(nodes.flatMap(node => (node.parentId ? [node.parentId] : [])));
    const algorithm = workspace.head?.length === 64 ? "sha256" : "sha1";
    const write: { path: string; bytes: Uint8Array }[] = [];
    const remove: string[] = [];
    const settled: { path: string; id: string; revision: number; blob: string }[] = [];
    const lines: string[] = [];
    const authors = new Set<string>();
    const pictures = new Set<string>();
    const details: Record<string, PageDetails> = {};
    for (const node of nodes) {
      const file = this.fileOf(sync, node.path);
      const record = recordOf.get(node.id);
      const inRepository = workspace.files.get(file);
      details[node.path] = {
        title: node.title,
        order: node.sortOrder,
        ...(node.labels.length > 0 ? { labels: [...node.labels] } : {})
      };
      // Nothing has happened on either side since they were last the same. A file saying something a page has the same way, such as a picture's own path, can stay as it is.
      const unchanged = record?.path === node.path && record.revision_no === node.currentRevisionNo;
      if (unchanged && !record.pending && record.blob_id === inRepository) continue;
      // Someone has yet to decide on what the repository says. Sending the page's text now would undo it.
      if (unchanged && record.pending && inReview) continue;
      const { markdown, actorName } = await loadRevision(this.context.db, node.id, node.currentRevisionNo);
      // A page that only holds others needs no file: the folder says as much.
      if (markdown === "" && holdsOthers.has(node.id) && !inRepository) continue;
      const bytes = encoder.encode(toFileText(markdown, node.path));
      const blob = gitBlobId(bytes, algorithm);
      if (inRepository !== blob) {
        write.push({ path: file, bytes });
        lines.push(t("{0} (version {1}, {2})", node.path, node.currentRevisionNo, actorName));
        authors.add(actorName);
        for (const [, picture] of markdown.matchAll(ASSET_IN_PAGE)) pictures.add(picture!);
      }
      settled.push({ path: node.path, id: node.id, revision: node.currentRevisionNo, blob });
    }
    const leaving: string[] = [];
    for (const record of records.values()) {
      if (record.document_id && nodeOf.get(record.document_id)?.path === record.path) continue;
      if (record.pending && inReview) continue;
      leaving.push(record.path);
      const file = this.fileOf(sync, record.path);
      if (workspace.files.has(file) && !write.some(item => item.path === file)) {
        remove.push(file);
        lines.push(t("{0} (removed)", record.path));
      }
    }
    const present = new Set(
      [...workspace.files.keys()]
        .filter(file => file.startsWith(`${prefix}${ASSETS_DIR}`))
        .map(file => posix.basename(file).slice(0, 64).toLowerCase())
    );
    for (const picture of pictures) {
      const hash = picture.slice(0, 64).toLowerCase();
      if (present.has(hash)) continue;
      present.add(hash);
      await this.attempt(run, `${prefix}${ASSETS_DIR}${picture}`, async () => {
        const { bytes } = await this.assets.get(principal, space.slug, hash);
        write.push({ path: `${prefix}${ASSETS_DIR}${picture}`, bytes });
      });
    }
    const pagesPath = `${prefix}${META_FILE}`;
    const pagesBytes = encoder.encode(
      stableJson({
        version: 1,
        pages: Object.fromEntries(Object.entries(details).sort(([a], [b]) => (a < b ? -1 : 1)))
      })
    );
    const pagesBlob = gitBlobId(pagesBytes, algorithm);
    if (workspace.files.get(pagesPath) !== pagesBlob) write.push({ path: pagesPath, bytes: pagesBytes });
    let pushed: string | null = null;
    if (write.length > 0 || remove.length > 0) {
      run.stillOurs();
      const body =
        lines.length > LINES_IN_A_COMMIT
          ? [...lines.slice(0, LINES_IN_A_COMMIT), t("And {0} more", lines.length - LINES_IN_A_COMMIT)]
          : lines;
      pushed = await workspace.commit({
        write,
        remove,
        message: `${lines.length > 0 ? t("Update {0} {0|page|pages} from Pandocs", lines.length) : t("Update page details from Pandocs")}${body.length > 0 ? `\n\n${body.join("\n")}` : ""}`,
        author: { name: authors.size === 1 ? [...authors][0]! : "Pandocs", email: "pandocs@users.noreply.invalid" }
      });
      report.pushed += lines.length;
    }
    for (const path of leaving) await this.forget(run, path);
    for (const { path, id, revision, blob } of settled) await this.remember(run, path, id, revision, blob);
    await this.context.db.query(`UPDATE pandocs.git_syncs SET meta_blob = $2 WHERE id = $1`, [sync.id, pagesBlob]);
    return pushed;
  }
}
