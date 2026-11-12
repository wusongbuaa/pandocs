import { randomUUID } from "node:crypto";
import { currentLanguage, inLanguage, t, type Language } from "@pandocs/i18n";
import { parseDocument, outlineOf, topLevelBlocks } from "@pandocs/markdown";
import { atLeast, canChangeSite } from "../domain/access.js";
import { PandocsError, forbidden, invalid, notFound } from "../domain/errors.js";
import type { Channel, IngestJobRecord, IngestReport, IngestTarget, PersistMode, Principal, Role } from "../domain/types.js";
import { builtinProcessors } from "../ingest/processors.js";
import { defaultIngestRoutes, detectContentType, resolveRoute, type IngestRoute } from "../ingest/routes.js";
import type { Processor } from "../ports.js";
import type { AssetService } from "./assets.js";
import { assertDirectWrites, requireDocument, requireSpace, UUID, type AppContext } from "./context.js";
import { MAX_MARKDOWN_BYTES, type DocumentService } from "./documents.js";
import type { ProposalService } from "./proposals.js";

const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 300;
/** A conversion can outlast the lease, a service reading a long scan can take ten minutes, so it is renewed while it runs. */
const RENEW_EVERY_MS = (LEASE_SECONDS / 3) * 1000;

/** Thrown by processors for input that will never succeed, so the job skips its retries. */
export class PermanentIngestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PermanentIngestError";
  }
}

export interface IngestInput {
  readonly space: string;
  readonly target?: IngestTarget | undefined;
  readonly contentType?: string | undefined;
  readonly filename?: string | undefined;
  readonly bytes?: Uint8Array | undefined;
  readonly markdown?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Bulk migrations label themselves; only administrators may. */
  readonly channel?: "migration" | undefined;
  readonly processors?: readonly string[] | undefined;
}

function mapJob(row: Record<string, unknown>): IngestJobRecord {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    target: row.target as IngestTarget,
    channel: String(row.channel),
    contentType: String(row.content_type),
    filename: String(row.filename),
    sourceAssetSha: row.source_asset_sha ? String(row.source_asset_sha) : null,
    sourceText: row.source_text === null || row.source_text === undefined ? null : String(row.source_text),
    metadata: row.metadata as Record<string, unknown>,
    language: row.language as Language,
    route: String(row.route),
    processors: row.processors as string[],
    persist: row.persist as PersistMode,
    status: row.status as IngestJobRecord["status"],
    attempts: Number(row.attempts),
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    report: row.report as IngestReport,
    draftMarkdown: row.draft_markdown === null || row.draft_markdown === undefined ? null : String(row.draft_markdown),
    draftTitle: row.draft_title ? String(row.draft_title) : null,
    documentId: row.document_id ? String(row.document_id) : null,
    revisionNo: row.revision_no === null || row.revision_no === undefined ? null : Number(row.revision_no),
    proposalId: row.proposal_id ? String(row.proposal_id) : null,
    createdBy: String(row.created_by),
    createdName: String(row.created_name),
    createdKind: row.created_kind as IngestJobRecord["createdKind"],
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string)
  };
}

function originalFileBlock(job: IngestJobRecord): string {
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(job.filename)?.[1]?.toLowerCase() ?? "bin";
  // Brackets would end the label, and a line break would end the block.
  const label = (job.filename || t("Original file")).replace(/[[\]\r\n]/gu, " ");
  return `::file[${label}]{src="assets/${job.sourceAssetSha}.${extension}"}`;
}

export class IngestService {
  private readonly routes: readonly IngestRoute[];
  private readonly processors: ReadonlyMap<string, Processor>;

  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService,
    private readonly proposals: ProposalService,
    private readonly assets: AssetService,
    routes: readonly IngestRoute[] = defaultIngestRoutes
  ) {
    this.routes = routes;
    this.processors = new Map([...builtinProcessors, ...(context.ports.processors ?? [])].map(processor => [processor.name, processor]));
  }

  async submit(principal: Principal, input: IngestInput): Promise<IngestJobRecord> {
    const { db } = this.context;
    if (input.channel === "migration" && !canChangeSite(principal)) throw forbidden(t("Only administrators can run migrations"));
    const channel: Channel = input.channel ?? principal.channel;
    const contentType = detectContentType({ bytes: input.bytes, filename: input.filename, declared: input.contentType ?? (input.markdown === undefined ? undefined : "text/markdown") });
    const route = resolveRoute(this.routes, channel, contentType);
    const { space, role } = await requireSpace(db, principal, input.space, "commenter");
    const target = input.target ?? {};
    if (target.documentId) await requireDocument(db, principal, target.documentId, "commenter");
    const canPublish = target.documentId
      ? atLeast((await requireDocument(db, principal, target.documentId)).role, "editor")
      : atLeast(role, "editor");
    // Where every change goes through a change set, what comes in waits as a draft like anything else would.
    const publishes = canPublish && !space.mergeRules.requireChangeSets;
    const persist: PersistMode = route.persist === "auto" ? (publishes ? "publish" : target.documentId && !canPublish ? "proposal" : "draft") : route.persist;
    if (persist === "publish" && !canPublish) throw forbidden(t("You cannot publish here"));
    if (input.markdown !== undefined && Buffer.byteLength(input.markdown, "utf8") > MAX_MARKDOWN_BYTES) throw invalid("DOCUMENT_TOO_LARGE", t("The content is larger than 2 MiB"));
    if (input.bytes === undefined && input.markdown === undefined) throw invalid("INGEST_EMPTY", t("There is nothing to import"));

    const asset = input.bytes ? await this.assets.put(principal, input.space, input.bytes, input.filename ?? "", "commenter") : undefined;
    const { rows } = await db.query(
      `INSERT INTO pandocs.ingest_jobs (space_id, target, channel, content_type, filename, source_asset_sha, source_text, metadata, route, processors, persist, created_by, created_name, created_kind, language)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [space.id, JSON.stringify(target), channel, contentType, input.filename ?? "", asset?.sha256 ?? null, input.markdown ?? null,
        JSON.stringify(input.metadata ?? {}), route.name, JSON.stringify(input.processors ?? route.processors), persist, principal.id, principal.displayName, principal.kind, currentLanguage()]
    );
    const job = mapJob(rows[0]!);
    if (route.mode === "sync") return this.execute(job, principal, input.space);
    void this.tick().catch(() => undefined);
    return job;
  }

  /** Runs the processor chain, validates the result, then persists according to the route. */
  private execute(job: IngestJobRecord, submitter: Principal | null, spaceSlug: string): Promise<IngestJobRecord> {
    // It may run long after the request that asked for it, and what it reports is for that person to read.
    return inLanguage(job.language, () => this.process(job, submitter, spaceSlug));
  }

  private async process(job: IngestJobRecord, submitter: Principal | null, spaceSlug: string): Promise<IngestJobRecord> {
    const { db, registry } = this.context;
    const principal = submitter && job.channel === "migration" ? { ...submitter, channel: "migration" as const } : submitter;
    try {
      const converted = await this.runProcessors(job, spaceSlug);
      const hasText = converted.markdown.trim() !== "";
      const keepsOriginal = job.sourceAssetSha !== null && job.processors.includes("extract");
      if (!hasText && !keepsOriginal) throw new PermanentIngestError("INGEST_EMPTY_RESULT", converted.warnings[0] ?? t("No content could be extracted"));
      // What a file looks like does not survive conversion, so the page keeps the file it came from. It may be all the page has.
      const output = keepsOriginal ? { ...converted, markdown: `${originalFileBlock(job)}\n${hasText ? `\n${converted.markdown}` : ""}` } : converted;
      const parsed = parseDocument(output.markdown, registry);
      const report: IngestReport = {
        processors: output.steps,
        warnings: output.warnings,
        diagnostics: parsed.diagnostics.map(({ severity, code, message, line }) => ({ severity, code, message, ...(line ? { line } : {}) })),
        stats: { characters: output.markdown.length, blocks: topLevelBlocks(parsed).length, unknownBlocks: parsed.blocks.filter(block => block.kind === "unknown").length }
      };
      const title = job.target.title ?? output.title ?? outlineOf(parsed)[0]?.text ?? job.filename.replace(/\.[^.]+$/u, "") ?? t("Untitled document");
      if (job.persist === "draft" || !principal) return await this.finish(job.id, { status: "succeeded", report, draft_markdown: output.markdown, draft_title: title });
      if (job.persist === "proposal") {
        const documentId = job.target.documentId!;
        const current = await this.documents.read(principal, documentId);
        const refs = current.blocks;
        const ops = refs.length > 0
          ? [{ op: "block_replace" as const, ref: refs[0]!.ref, end: refs.at(-1)!.ref, content: output.markdown }]
          : [{ op: "block_insert_after" as const, ref: "start" as const, content: output.markdown }];
        const proposal = await this.proposals.create(principal, documentId, { baseRevision: current.revision.no, ops, rationale: t("Imported: {0}", job.filename || title) });
        return await this.finish(job.id, { status: "succeeded", report, proposal_id: proposal.id, document_id: documentId });
      }
      const commit = job.target.documentId
        ? await this.commitToExisting(principal, job.target.documentId, output.markdown, job.id, title)
        : await this.documents.create(principal, {
            space: spaceSlug, title, markdown: output.markdown, parentPath: job.target.parentPath, slug: job.target.slug,
            sortOrder: job.target.sortOrder, restricted: job.target.restricted, message: t("Imported: {0}", job.filename || title), ingestJobId: job.id
          });
      return await this.finish(job.id, { status: "succeeded", report, document_id: commit.document.id, revision_no: commit.revision.no });
    } catch (error) {
      if (error instanceof PandocsError) {
        return this.finish(job.id, { status: "failed", error_code: error.code, error_message: error.message });
      }
      const permanent = error instanceof PermanentIngestError;
      const attempts = (await db.query(`SELECT attempts FROM pandocs.ingest_jobs WHERE id = $1`, [job.id])).rows[0]?.attempts as number ?? 1;
      // A caller waiting on a sync route sees the failure now; only background runs retry.
      if (!permanent && !principal && attempts < MAX_ATTEMPTS) {
        return this.finish(job.id, { status: "retry_wait", error_code: "PROCESSOR_FAILED", error_message: messageOf(error), next_run_at: new Date(Date.now() + 30_000 * attempts) });
      }
      return this.finish(job.id, { status: "failed", error_code: permanent ? error.code : "PROCESSOR_FAILED", error_message: messageOf(error) });
    }
  }

  private async commitToExisting(principal: Principal, documentId: string, markdown: string, jobId: string, title: string) {
    return this.context.db.transaction(async tx => {
      const { document, space } = await requireDocument(tx, principal, documentId, "editor", true);
      assertDirectWrites(space);
      return this.documents.commit(tx, principal, document, { markdown, ingestJobId: jobId, message: t("Imported: {0}", title) });
    });
  }

  private async runProcessors(job: IngestJobRecord, spaceSlug: string) {
    const steps: { name: string; detail?: string }[] = [];
    const warnings: string[] = [];
    let markdown = job.sourceText ?? undefined;
    let bytes: Uint8Array | undefined;
    let title: string | undefined;
    if (job.sourceAssetSha) bytes = await this.readSource(job, spaceSlug);
    for (const name of job.processors) {
      const processor = this.processors.get(name);
      if (!processor) throw new PermanentIngestError("PROCESSOR_UNAVAILABLE", t("The processor {0} is not available here", name));
      const output = await processor.run({ bytes, markdown, contentType: job.contentType, filename: job.filename, metadata: job.metadata, jobId: job.id });
      markdown = output.markdown;
      bytes = undefined;
      title = output.title ?? title;
      steps.push({ name, ...(output.detail ? { detail: output.detail } : {}) });
      warnings.push(...(output.warnings ?? []));
      if (output.files?.length) {
        const { rows } = await this.context.db.query<{ id: string }>(`SELECT id FROM pandocs.spaces WHERE slug = $1 AND deleted_at IS NULL`, [spaceSlug]);
        for (const file of output.files) await this.assets.storeForJob(rows[0]!.id, file.bytes, file.filename, job.createdBy);
      }
    }
    return { markdown: markdown ?? "", title, steps, warnings };
  }

  private async readSource(job: IngestJobRecord, spaceSlug: string): Promise<Uint8Array> {
    const { rows } = await this.context.db.query(`SELECT id FROM pandocs.spaces WHERE slug = $1 AND deleted_at IS NULL`, [spaceSlug]);
    const stored = await this.context.ports.assets.get(`spaces/${String(rows[0]!.id)}/${job.sourceAssetSha}`);
    if (!stored) throw new PermanentIngestError("SOURCE_MISSING", t("The original file is missing"));
    return stored.bytes;
  }

  private async finish(jobId: string, fields: Record<string, unknown>): Promise<IngestJobRecord> {
    // A try that works leaves nothing of the one that failed before it.
    const entries = Object.entries(fields.status === "succeeded" ? { error_code: null, error_message: null, ...fields } : fields);
    const assignments = entries.map(([key], index) => `${key} = $${index + 2}`).join(", ");
    const { rows } = await this.context.db.query(
      `UPDATE pandocs.ingest_jobs SET ${assignments}, lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [jobId, ...entries.map(([key, value]) => (key === "report" ? JSON.stringify(value) : value))]
    );
    return mapJob(rows[0]!);
  }

  /** Claims one due job. A crashed worker's lease expires and the job comes back. */
  async tick(): Promise<boolean> {
    const { db } = this.context;
    const owner = randomUUID();
    const { rows } = await db.query(
      `UPDATE pandocs.ingest_jobs SET status = 'running', lease_owner = $1, lease_until = now() + make_interval(secs => $2), attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM pandocs.ingest_jobs
         WHERE (status IN ('queued', 'retry_wait') AND next_run_at <= now()) OR (status = 'running' AND lease_until < now())
         ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING *`,
      [owner, LEASE_SECONDS]
    );
    if (!rows[0]) return false;
    const job = mapJob(rows[0]);
    // Otherwise another worker takes a long conversion for a crashed one, and converts the file a second time.
    const renewing = setInterval(() => {
      void db.query(
        `UPDATE pandocs.ingest_jobs SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [job.id, owner, LEASE_SECONDS]
      ).catch(() => undefined);
    }, RENEW_EVERY_MS);
    renewing.unref?.();
    try {
      const { rows: spaces } = await db.query<{ slug: string }>(`SELECT slug FROM pandocs.spaces WHERE id = $1`, [job.spaceId]);
      await this.execute(job, null, spaces[0]!.slug);
    } finally {
      clearInterval(renewing);
    }
    return true;
  }

  private async loadJob(principal: Principal, jobId: string, required: Role = "viewer"): Promise<{ job: IngestJobRecord; spaceSlug: string }> {
    const { db } = this.context;
    if (!UUID.test(jobId)) throw notFound(t("Import job"));
    const { rows } = await db.query(`SELECT j.*, s.slug AS space_slug FROM pandocs.ingest_jobs j JOIN pandocs.spaces s ON s.id = j.space_id WHERE j.id = $1`, [jobId]);
    if (!rows[0]) throw notFound(t("Import job"));
    const job = mapJob(rows[0]);
    const spaceSlug = String(rows[0].space_slug);
    const { role } = await requireSpace(db, principal, spaceSlug);
    if (job.createdBy !== principal.id && !atLeast(role, "editor")) throw notFound(t("Import job"));
    if (!atLeast(role, required)) throw forbidden();
    return { job, spaceSlug };
  }

  async get(principal: Principal, jobId: string): Promise<IngestJobRecord> {
    return (await this.loadJob(principal, jobId)).job;
  }

  async list(principal: Principal, spaceSlug: string): Promise<IngestJobRecord[]> {
    const { db } = this.context;
    const { space, role } = await requireSpace(db, principal, spaceSlug, "commenter");
    const { rows } = await db.query(
      `SELECT * FROM pandocs.ingest_jobs WHERE space_id = $1 AND ($2::boolean OR created_by = $3) ORDER BY created_at DESC LIMIT 100`,
      [space.id, atLeast(role, "editor"), principal.id]
    );
    return rows.map(mapJob);
  }

  /** The original file is kept, so a better processor can always have another go. */
  async retry(principal: Principal, jobId: string, input: { processors?: readonly string[] | undefined } = {}): Promise<IngestJobRecord> {
    const { job } = await this.loadJob(principal, jobId, "commenter");
    if (job.status === "running" || job.documentId) throw new PandocsError(409, "INGEST_NOT_RETRYABLE", t("This job cannot run again"));
    await this.context.db.query(
      `UPDATE pandocs.ingest_jobs SET status = 'queued', attempts = 0, next_run_at = now(), error_code = NULL, error_message = NULL, draft_markdown = NULL, processors = $2, updated_at = now() WHERE id = $1`,
      [jobId, JSON.stringify(input.processors ?? job.processors)]
    );
    void this.tick().catch(() => undefined);
    return (await this.loadJob(principal, jobId)).job;
  }

  /** Turns a reviewed draft into a document or a new version. */
  async publish(principal: Principal, jobId: string, input: { title?: string | undefined; parentPath?: string | undefined; slug?: string | undefined; markdown?: string | undefined; documentId?: string | undefined } = {}): Promise<IngestJobRecord> {
    const { job, spaceSlug } = await this.loadJob(principal, jobId);
    if (job.status !== "succeeded" || job.draftMarkdown === null || job.documentId) throw new PandocsError(409, "INGEST_NOT_PUBLISHABLE", t("This job has no draft to publish"));
    const markdown = input.markdown ?? job.draftMarkdown;
    const title = input.title ?? job.draftTitle ?? t("Untitled document");
    const documentId = input.documentId ?? job.target.documentId;
    const commit = documentId
      ? await this.commitToExisting(principal, documentId, markdown, job.id, title)
      : await this.documents.create(principal, {
          space: spaceSlug, title, markdown, parentPath: input.parentPath ?? job.target.parentPath, slug: input.slug ?? job.target.slug,
          sortOrder: job.target.sortOrder, restricted: job.target.restricted, message: t("Imported: {0}", job.filename || title), ingestJobId: job.id
        });
    return this.finish(job.id, { document_id: commit.document.id, revision_no: commit.revision.no });
  }

  async discard(principal: Principal, jobId: string): Promise<IngestJobRecord> {
    const { job } = await this.loadJob(principal, jobId, "commenter");
    if (job.documentId) throw new PandocsError(409, "INGEST_ALREADY_PUBLISHED", t("A published job cannot be discarded"));
    return this.finish(jobId, { status: "discarded" });
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
