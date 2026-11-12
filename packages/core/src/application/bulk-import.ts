import { randomUUID } from "node:crypto";
import { inLanguage, t, type Language } from "@pandocs/i18n";
import { PandocsError, invalid, notFound } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import type { BulkImporter, ImportSink } from "../ports.js";
import type { AssetService } from "./assets.js";
import { requireSpace, UUID, type AppContext } from "./context.js";
import type { DocumentService } from "./documents.js";
import { PermanentIngestError } from "./ingest.js";
import { PageWriter } from "./page-writer.js";
import type { SiteService } from "./site.js";

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 3;
const RETRY_SECONDS = 60;
const MAX_NOTES = 500;
const LISTED = 50;

const uploadKey = (id: string) => `imports/${id}`;

/** Only what someone looking at it needs: who it runs as stays out of it. */
function mapImport(row: Record<string, unknown>) {
  const input = (row.input ?? {}) as { url?: string; includeChildren?: boolean };
  return {
    id: String(row.id),
    source: String(row.source),
    filename: String(row.filename),
    url: input.url ?? null,
    includeChildren: input.includeChildren ?? false,
    parentPath: row.parent_path ? String(row.parent_path) : null,
    status: String(row.status),
    progress: (row.progress ?? { done: 0, total: null }) as { done: number; total: number | null },
    report: (row.report ?? null) as ImportReport | null,
    error: row.error ? String(row.error) : null,
    createdName: String(row.created_name),
    createdAt: new Date(row.created_at as string).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null
  };
}

export interface ImportReport {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly assets: number;
  /** What did not come over, or not all of it. Only so many are kept. */
  readonly notes: readonly { readonly file: string; readonly reason: string }[];
  readonly notesLeftOut: number;
}

/** Someone cancelled it, or another replica took it over after this one seemed to have died. */
class ImportStopped extends Error {}

/**
 * Bringing in a whole set of pages from another tool, which takes longer than a request should. It runs in the background
 * as whoever asked for it, so what they can no longer do by then, it cannot do either. It can safely start over.
 */
export class BulkImportService {
  constructor(private readonly context: AppContext, private readonly documents: DocumentService, private readonly assets: AssetService, private readonly site: SiteService) {}

  /** What this server can import from. Some need credentials it may not have been given. */
  sources() {
    return (this.context.ports.importers ?? []).map(({ source, input }) => ({ source, input }));
  }

  async submit(principal: Principal, spaceSlug: string, input: { source: string; bytes?: Uint8Array | undefined; filename?: string | undefined; url?: string | undefined; includeChildren?: boolean | undefined; parentPath?: string | undefined }) {
    const { db, ports } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "editor");
    const importer = ports.importers?.find(item => item.source === input.source);
    if (!importer) throw invalid("IMPORT_SOURCE_UNKNOWN", t("This server cannot import from {0}", input.source));
    if (importer.input === "file" && !input.bytes?.byteLength) throw invalid("INGEST_EMPTY", t("There is no file to import"));
    if (importer.input === "url" && !input.url?.trim()) throw invalid("IMPORT_URL_MISSING", t("Say what to import, by its address"));
    if (input.parentPath) {
      const { rows } = await db.query(`SELECT 1 FROM pandocs.documents WHERE space_id = $1 AND path = $2 AND deleted_at IS NULL`, [space.id, input.parentPath]);
      if (!rows[0]) throw notFound(t("Parent document"));
    }
    const id = randomUUID();
    if (input.bytes) await ports.assets.put(uploadKey(id), input.bytes, "application/zip");
    const { rows } = await db.query(
      `INSERT INTO pandocs.bulk_imports (id, space_id, source, input, filename, parent_path, principal, created_by, created_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, space.id, input.source, JSON.stringify({ ...(input.url ? { url: input.url.trim() } : {}), ...(input.includeChildren ? { includeChildren: true } : {}) }), input.filename ?? "", input.parentPath ?? null, JSON.stringify(principal), principal.id, principal.displayName]
    );
    return mapImport(rows[0]!);
  }

  async list(principal: Principal, spaceSlug: string) {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "editor");
    const { rows } = await db.query(`SELECT * FROM pandocs.bulk_imports WHERE space_id = $1 ORDER BY created_at DESC LIMIT $2`, [space.id, LISTED]);
    return rows.map(mapImport);
  }

  private async owned(principal: Principal, id: string) {
    const { db } = this.context;
    if (!UUID.test(id)) throw notFound(t("Import job"));
    const { rows } = await db.query(`SELECT b.*, s.slug FROM pandocs.bulk_imports b JOIN pandocs.spaces s ON s.id = b.space_id AND s.deleted_at IS NULL WHERE b.id = $1`, [id]);
    if (!rows[0]) throw notFound(t("Import job"));
    await requireSpace(db, principal, String(rows[0].slug), "editor").catch((error: unknown) => { throw error instanceof PandocsError ? notFound(t("Import job")) : error; });
    return rows[0];
  }

  async get(principal: Principal, id: string) {
    return mapImport(await this.owned(principal, id));
  }

  async cancel(principal: Principal, id: string) {
    await this.owned(principal, id);
    const { rows } = await this.context.db.query(
      `UPDATE pandocs.bulk_imports SET status = 'cancelled', lease_owner = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`,
      [id]
    );
    if (!rows[0]) throw invalid("IMPORT_NOT_RUNNING", t("This import is not running"));
    await this.forgetUpload(id);
    return mapImport(rows[0]);
  }

  /** Whatever came in stays, and starting over changes none of that. A file already forgotten has to be chosen again. */
  async retry(principal: Principal, id: string) {
    const row = await this.owned(principal, id);
    if (String(row.status) !== "failed") throw invalid("IMPORT_NOT_FAILED", t("Only a failed import can be tried again"));
    const importer = this.context.ports.importers?.find(item => item.source === row.source);
    if (importer?.input === "file" && !await this.context.ports.assets.get(uploadKey(id))) throw invalid("IMPORT_FILE_GONE", t("The file for this import is no longer kept. Upload it again."));
    const { rows } = await this.context.db.query(
      `UPDATE pandocs.bulk_imports SET status = 'queued', attempts = 0, next_run_at = now(), error = NULL, finished_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    return mapImport(rows[0]!);
  }

  private async forgetUpload(id: string): Promise<void> {
    await this.context.ports.assets.remove?.(uploadKey(id));
  }

  /** Runs one import to the end. */
  async tick(): Promise<boolean> {
    const { db } = this.context;
    const owner = randomUUID();
    const { rows } = await db.query(
      `UPDATE pandocs.bulk_imports SET status = 'running', lease_owner = $1, lease_until = now() + make_interval(secs => $2), attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM pandocs.bulk_imports WHERE (status = 'queued' AND next_run_at <= now()) OR (status = 'running' AND lease_until < now())
         ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING *`,
      [owner, LEASE_SECONDS]
    );
    if (!rows[0]) return false;
    await this.run(rows[0], owner);
    return true;
  }

  private async run(row: Record<string, unknown>, owner: string): Promise<void> {
    const { db, ports } = this.context;
    const id = String(row.id);
    const asked = row.principal as Principal;
    const input = (row.input ?? {}) as { url?: string; includeChildren?: boolean };
    const prefix = row.parent_path ? `${String(row.parent_path)}/` : "";
    const report = { created: 0, updated: 0, unchanged: 0, assets: 0, notes: [] as { file: string; reason: string }[], notesLeftOut: 0 };
    const progress: { done: number; total: number | null } = { done: 0, total: null };
    const note = (file: string, reason: string) => {
      if (report.notes.length < MAX_NOTES) report.notes.push({ file, reason });
      else report.notesLeftOut += 1;
    };
    /** Keeps this import from looking dead, and finds out if it has been told to stop. */
    const stillOurs = async () => {
      const { rows: held } = await db.query(
        `UPDATE pandocs.bulk_imports SET lease_until = now() + make_interval(secs => $3), progress = $4, updated_at = now() WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING 1 AS held`,
        [id, owner, LEASE_SECONDS, JSON.stringify(progress)]
      );
      if (!held[0]) throw new ImportStopped();
    };
    const finish = async (status: "succeeded" | "failed", error: string | null) => {
      await db.query(
        `UPDATE pandocs.bulk_imports SET status = $3, error = $4, report = $5, progress = $6, lease_owner = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND lease_owner = $2`,
        [id, owner, status, error, JSON.stringify(report), JSON.stringify(progress)]
      );
      await this.forgetUpload(id);
    };
    try {
      // Who asked may have stopped being an administrator, or changed groups, or gone, since. Their rights in a space are
      // read on every write anyway; these come with the account, and are read again each time the import starts.
      const now = ports.directory?.principal ? await ports.directory.principal(asked.id) : asked;
      if (!now) throw new PermanentIngestError("IMPORT_ACCOUNT_GONE", t("The account that started this import is no longer active"));
      const principal: Principal = { ...asked, isAdmin: now.isAdmin, groups: now.groups };
      const importer = ports.importers?.find(item => item.source === row.source);
      if (!importer) throw new PermanentIngestError("IMPORT_SOURCE_UNKNOWN", t("This server cannot import from {0}", String(row.source)));
      const { rows: spaces } = await db.query<{ slug: string }>(`SELECT slug FROM pandocs.spaces WHERE id = $1 AND deleted_at IS NULL`, [row.space_id]);
      if (!spaces[0]) throw new PermanentIngestError("IMPORT_SPACE_GONE", t("The space no longer exists"));
      const space = spaces[0].slug;
      const stored = importer.input === "file" ? await ports.assets.get(uploadKey(id)) : null;
      if (importer.input === "file" && !stored) throw new PermanentIngestError("IMPORT_FILE_GONE", t("The file for this import is no longer kept. Upload it again."));
      const { defaultLang } = await this.site.get();
      await inLanguage(defaultLang as Language, async () => {
        const writer = await PageWriter.open(this.context, this.documents, principal, space, t("Imported from {0}", importer.label()));
        const sink: ImportSink = {
          expect(total) {
            progress.total = total;
          },
          note,
          asset: async (bytes, filename) => {
            await stillOurs();
            try {
              const { path } = await this.assets.put(principal, space, bytes, filename);
              report.assets += 1;
              return path;
            } catch (error) {
              if (!(error instanceof PandocsError)) throw error;
              note(filename, error.message);
              return null;
            }
          },
          page: async page => {
            await stillOurs();
            try {
              report[await writer.write({ ...page, path: `${prefix}${page.path}` })] += 1;
            } catch (error) {
              if (!(error instanceof PandocsError)) throw error;
              note(page.title, error.message);
            }
            progress.done += 1;
          }
        };
        await importer.run({ ...(stored ? { bytes: stored.bytes } : {}), ...(input.url ? { url: input.url } : {}), includeChildren: input.includeChildren ?? false }, sink);
      });
      await finish("succeeded", null);
    } catch (error) {
      if (error instanceof ImportStopped) return;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentIngestError || Number(row.attempts) >= MAX_ATTEMPTS) {
        await finish("failed", message);
        return;
      }
      await db.query(
        `UPDATE pandocs.bulk_imports SET status = 'queued', next_run_at = now() + make_interval(secs => $3), error = $4, lease_owner = NULL, updated_at = now() WHERE id = $1 AND lease_owner = $2`,
        [id, owner, RETRY_SECONDS, message]
      );
    }
  }
}
