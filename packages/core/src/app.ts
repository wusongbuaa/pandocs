import { analyzeDocument, defaultBlockRegistry } from "@pandocs/markdown";
import { AskService } from "./application/ask.js";
import { AssetService } from "./application/assets.js";
import { ArchiveImportService } from "./application/archive-import.js";
import { BulkImportService } from "./application/bulk-import.js";
import { ChangeService } from "./application/changes.js";
import { AssistService } from "./application/assist.js";
import { AuditLogService } from "./application/audit-log.js";
import { ChangeSetService } from "./application/change-sets.js";
import type { AppContext } from "./application/context.js";
import { DocumentService } from "./application/documents.js";
import { ExportService } from "./application/export.js";
import { FeedbackService } from "./application/feedback.js";
import { GitSyncService } from "./application/git-sync.js";
import { LiveDraftService } from "./application/live-drafts.js";
import { IngestService } from "./application/ingest.js";
import { LlmsService } from "./application/llms.js";
import { ProposalService } from "./application/proposals.js";
import { ShareLinkService } from "./application/share-links.js";
import { SiteService } from "./application/site.js";
import { SpaceService } from "./application/spaces.js";
import { StatsService } from "./application/stats.js";
import { SubscriptionService } from "./application/subscriptions.js";
import { TemplateService } from "./application/templates.js";
import { ThreadService } from "./application/threads.js";
import { TranslationService } from "./application/translations.js";
import { WebhookService } from "./application/webhooks.js";
import { TreeService } from "./application/tree.js";
import type { PandocsDb } from "./infrastructure/db.js";
import type { IngestRoute } from "./ingest/routes.js";
import type { PandocsPorts } from "./ports.js";

export interface PandocsServices {
  readonly context: AppContext;
  readonly site: SiteService;
  readonly spaces: SpaceService;
  readonly documents: DocumentService;
  readonly changes: ChangeService;
  readonly tree: TreeService;
  readonly export: ExportService;
  readonly audit: AuditLogService;
  readonly llms: LlmsService;
  readonly translations: TranslationService;
  readonly threads: ThreadService;
  readonly assist: AssistService;
  readonly ask: AskService;
  readonly stats: StatsService;
  readonly feedback: FeedbackService;
  readonly templates: TemplateService;
  readonly subscriptions: SubscriptionService;
  readonly webhooks: WebhookService;
  readonly shareLinks: ShareLinkService;
  readonly changeSets: ChangeSetService;
  readonly gitSync: GitSyncService;
  readonly live: LiveDraftService;
  readonly archives: ArchiveImportService;
  readonly bulkImports: BulkImportService;
  readonly proposals: ProposalService;
  readonly assets: AssetService;
  readonly ingest: IngestService;
}

export function createPandocsServices(input: { db: PandocsDb; ports: PandocsPorts; routes?: readonly IngestRoute[] | undefined }): PandocsServices {
  const registry = input.ports.registry ?? defaultBlockRegistry;
  const context: AppContext = { db: input.db, ports: input.ports, registry, analyze: input.ports.analyze ?? (async markdown => analyzeDocument(markdown, registry)) };
  const site = new SiteService(context);
  const spaces = new SpaceService(context);
  const documents = new DocumentService(context);
  const threads = new ThreadService(context);
  const assist = new AssistService(context, threads);
  const proposals = new ProposalService(context, documents);
  const assets = new AssetService(context);
  const ingest = new IngestService(context, documents, proposals, assets, input.routes);
  const archives = new ArchiveImportService(context, documents, assets);
  const translations = new TranslationService(context, site);
  const stats = new StatsService(context, documents, spaces);
  const ask = new AskService(context, documents, spaces, site, stats);
  const feedback = new FeedbackService(context, documents, spaces);
  const live = new LiveDraftService(context);
  const tree = new TreeService(context, documents);
  const changeSets = new ChangeSetService(context, documents, tree);
  return { context, site, spaces, documents, changes: new ChangeService(context, documents), archives, tree, changeSets, gitSync: new GitSyncService(context, documents, tree, assets, changeSets, proposals, site), live, export: new ExportService(context, documents, assets), audit: new AuditLogService(context), llms: new LlmsService(context, documents, spaces, site, translations), translations, threads, assist, ask, stats, feedback, templates: new TemplateService(context), subscriptions: new SubscriptionService(context), webhooks: new WebhookService(context, site), bulkImports: new BulkImportService(context, documents, assets, site), shareLinks: new ShareLinkService(context), proposals, assets, ingest };
}

const SWEEP_INTERVAL_MS = 3_600_000;

/** A retry arrives within minutes; keys only need to outlive that, and each one stores a response body. */
export async function sweepIdempotencyKeys(services: PandocsServices): Promise<void> {
  await services.context.db.query(`DELETE FROM pandocs.idempotency_keys WHERE created_at < now() - interval '7 days'`);
  await services.changes.sweep();
  await services.stats.sweep();
  await services.webhooks.sweep();
}

/** Background pump for async ingest jobs and housekeeping. The host owns its lifecycle. */
export function createIngestWorker(services: PandocsServices, intervalMs = 5000): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let swept = 0;
  /** Each kind of work waits only for itself: a mail server that hangs must not hold up imports. */
  const pump = (work: () => Promise<void>) => {
    let busy = false;
    return async () => {
      if (busy) return;
      busy = true;
      try {
        await work();
      } catch {
        // The next tick retries; a job that failed mid-run comes back when its lease expires.
      } finally {
        busy = false;
      }
    };
  };
  const pumps = [
    pump(async () => {
      while (await services.ingest.tick()) { /* drain due jobs */ }
      if (Date.now() - swept >= SWEEP_INTERVAL_MS) {
        swept = Date.now();
        await sweepIdempotencyKeys(services);
        await services.tree.sweepTrash((await services.site.get()).trashRetentionDays);
      }
    }),
    pump(async () => {
      while (await services.subscriptions.sendDueMail() > 0) { /* until none are due */ }
    }),
    pump(async () => {
      while (await services.webhooks.tick()) { /* until none are due */ }
    }),
    pump(async () => {
      while (await services.bulkImports.tick()) { /* until none are due */ }
    }),
    pump(async () => {
      while (await services.gitSync.tick()) { /* until none are due */ }
    }),
    pump(async () => {
      while (await services.live.sweep() > 0) { /* until none are left */ }
    })
  ];
  const run = () => {
    for (const work of pumps) void work();
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
