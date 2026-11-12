import { inLanguage, t, type Language } from "@pandocs/i18n";
import { z } from "zod";
import { canChangeSite } from "../domain/access.js";
import { PandocsError, forbidden, invalid, notFound } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import type { WebhookSendResult } from "../ports.js";
import { audit, requireSpace, UUID, type AppContext } from "./context.js";
import type { SiteService } from "./site.js";
import { WEBHOOK_EVENTS, type WebhookEvent } from "./webhook-events.js";

export const WEBHOOK_KINDS = ["generic", "slack", "feishu", "wecom", "dingtalk", "teams"] as const;
export type WebhookKind = typeof WEBHOOK_KINDS[number];

const httpUrl = z.string().max(2000).refine(value => /^https?:\/\//iu.test(value) && URL.canParse(value), { error: () => t("A hook's address starts with http:// or https://") });

export const webhookInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(WEBHOOK_KINDS),
  url: httpUrl,
  secret: z.string().max(500).optional(),
  /** Everything, when left out. */
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  includeRestricted: z.boolean().optional(),
  enabled: z.boolean().optional()
}).strict();

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21_600];
/** Long enough for a send to finish. If whoever claimed it died, this is when it is tried again. */
const CLAIM_SECONDS = 120;
/** What goes in one message to a chat, however much happened. */
const MESSAGES_TO_A_CHAT = 50;
/** A hook that has failed this many times in a row has probably gone for good, and is costing a retry for everything that happens. */
const FAILURES_BEFORE_DISABLING = 50;
const LISTED_DELIVERIES = 50;
const KEPT_DAYS = 30;

/** Addresses of chat hooks are secrets themselves, so what was typed never comes back. */
function mapHook(row: Record<string, unknown>, spaceSlug: string | null) {
  return {
    id: String(row.id),
    spaceSlug,
    name: String(row.name),
    kind: String(row.kind) as WebhookKind,
    url: `${new URL(String(row.url)).origin}/…`,
    hasSecret: String(row.secret) !== "",
    events: row.events as string[],
    includeRestricted: Boolean(row.include_restricted),
    enabled: Boolean(row.enabled),
    consecutiveFailures: Number(row.consecutive_failures),
    lastStatus: row.last_status ? String(row.last_status) : null,
    lastDeliveredAt: row.last_delivered_at ? new Date(row.last_delivered_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString()
  };
}

function mapDelivery(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    event: String(row.event),
    status: String(row.status),
    attempts: Number(row.attempts),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    error: row.error ? String(row.error) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at as string).toISOString() : null,
    nextAttemptAt: row.status === "pending" ? new Date(row.next_attempt_at as string).toISOString() : null
  };
}

/** Tells other systems what happens here. A space's administrators look after its hooks, and site administrators those for the whole site. */
export class WebhookService {
  constructor(private readonly context: AppContext, private readonly site: SiteService) {}

  private requireSiteAdmin(principal: Principal): void {
    if (!principal.isAdmin) throw forbidden();
  }

  /** Anyone else gets the same answer as for a hook that is not there. */
  private async owned(principal: Principal, id: string, reading = false): Promise<{ row: Record<string, unknown>; spaceSlug: string | null }> {
    const { db } = this.context;
    if (!UUID.test(id)) throw notFound(t("Webhook"));
    const { rows } = await db.query(`SELECT w.*, s.slug AS space_slug FROM pandocs.webhooks w LEFT JOIN pandocs.spaces s ON s.id = w.space_id AND s.deleted_at IS NULL WHERE w.id = $1`, [id]);
    const row = rows[0];
    if (!row || (row.space_id && !row.space_slug)) throw notFound(t("Webhook"));
    if (row.space_id) await requireSpace(db, principal, String(row.space_slug), "admin").catch((error: unknown) => { throw error instanceof PandocsError && error.status === 403 ? notFound(t("Webhook")) : error; });
    else if (!principal.isAdmin) throw notFound(t("Webhook"));
    else if (!reading && !canChangeSite(principal)) throw forbidden();
    return { row, spaceSlug: row.space_slug ? String(row.space_slug) : null };
  }

  async list(principal: Principal, spaceSlug: string | null) {
    const { db } = this.context;
    if (spaceSlug === null) {
      this.requireSiteAdmin(principal);
      const { rows } = await db.query(`SELECT * FROM pandocs.webhooks WHERE space_id IS NULL ORDER BY created_at`);
      return rows.map(row => mapHook(row, null));
    }
    const { space } = await requireSpace(db, principal, spaceSlug, "admin");
    const { rows } = await db.query(`SELECT * FROM pandocs.webhooks WHERE space_id = $1 ORDER BY created_at`, [space.id]);
    return rows.map(row => mapHook(row, space.slug));
  }

  async create(principal: Principal, spaceSlug: string | null, input: z.output<typeof webhookInput>) {
    const { db } = this.context;
    const space = spaceSlug === null ? null : (await requireSpace(db, principal, spaceSlug, "admin")).space;
    if (!space && !canChangeSite(principal)) throw forbidden();
    return db.transaction(async tx => {
      const { rows } = await tx.query(
        `INSERT INTO pandocs.webhooks (space_id, name, kind, url, secret, events, include_restricted, enabled, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [space?.id ?? null, input.name, input.kind, input.url, input.secret ?? "", input.events ?? [...WEBHOOK_EVENTS], input.includeRestricted ?? false, input.enabled ?? true, principal.id]
      );
      await audit(tx, principal, space ? "space.webhook.create" : "site.webhook.create", space ? "space" : "site", space?.id ?? "site", { name: input.name, kind: input.kind });
      return mapHook(rows[0]!, space?.slug ?? null);
    });
  }

  /** Turning one back on starts its count again: someone has presumably looked at what was wrong. */
  async update(principal: Principal, id: string, patch: { [Key in keyof z.output<typeof webhookInput>]?: z.output<typeof webhookInput>[Key] | undefined }) {
    const { row, spaceSlug } = await this.owned(principal, id);
    return this.context.db.transaction(async tx => {
      const { rows } = await tx.query(
        `UPDATE pandocs.webhooks SET name = COALESCE($2, name), kind = COALESCE($3, kind), url = COALESCE($4, url), secret = COALESCE($5, secret), events = COALESCE($6, events),
           include_restricted = COALESCE($7, include_restricted), enabled = COALESCE($8, enabled), consecutive_failures = CASE WHEN $8 THEN 0 ELSE consecutive_failures END, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.name ?? null, patch.kind ?? null, patch.url ?? null, patch.secret ?? null, patch.events ?? null, patch.includeRestricted ?? null, patch.enabled ?? null]
      );
      await audit(tx, principal, row.space_id ? "space.webhook.update" : "site.webhook.update", row.space_id ? "space" : "site", row.space_id ? String(row.space_id) : "site", { name: rows[0]!.name, fields: Object.keys(patch).filter(key => key !== "secret" && key !== "url") });
      return mapHook(rows[0]!, spaceSlug);
    });
  }

  async remove(principal: Principal, id: string): Promise<void> {
    const { row } = await this.owned(principal, id);
    await this.context.db.transaction(async tx => {
      await tx.query(`DELETE FROM pandocs.webhooks WHERE id = $1`, [id]);
      await audit(tx, principal, row.space_id ? "space.webhook.delete" : "site.webhook.delete", row.space_id ? "space" : "site", row.space_id ? String(row.space_id) : "site", { name: row.name });
    });
  }

  async deliveries(principal: Principal, id: string) {
    await this.owned(principal, id, true);
    const { rows } = await this.context.db.query(`SELECT * FROM pandocs.webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2`, [id, LISTED_DELIVERIES]);
    return rows.map(mapDelivery);
  }

  async retry(principal: Principal, id: string, deliveryId: string) {
    await this.owned(principal, id);
    if (!UUID.test(deliveryId)) throw notFound(t("Delivery"));
    const { rows } = await this.context.db.query(
      `UPDATE pandocs.webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), error = NULL, response_status = NULL WHERE id = $1 AND webhook_id = $2 AND status = 'failed' RETURNING *`,
      [deliveryId, id]
    );
    if (!rows[0]) throw notFound(t("Delivery"));
    return mapDelivery(rows[0]);
  }

  /** Right now, and it leaves no record: this is someone at a screen checking they have the address and secret right. */
  async test(principal: Principal, id: string): Promise<WebhookSendResult> {
    const { row } = await this.owned(principal, id);
    const sender = this.context.ports.webhookSender;
    if (!sender) throw invalid("WEBHOOKS_UNAVAILABLE", t("This server cannot send webhooks"));
    const { title } = await this.site.get();
    return sender.send({ kind: String(row.kind) as WebhookKind, url: String(row.url), secret: String(row.secret) }, { id: `test-${String(row.id)}`, siteTitle: title, events: [{ event: "ping", occurredAt: new Date().toISOString() }] });
  }

  /**
   * Sends one thing that is due. Claiming it pushes its next try into the future rather than holding a lock while talking
   * to another server, so any number of replicas can work through these, and what a dead one was sending comes back.
   */
  async tick(): Promise<boolean> {
    const { db, ports: { webhookSender: sender } } = this.context;
    if (!sender) return false;
    const claimed = await db.transaction(async tx => {
      const { rows: due } = await tx.query(
        `SELECT d.webhook_id, w.kind, w.url, w.secret FROM pandocs.webhook_deliveries d JOIN pandocs.webhooks w ON w.id = d.webhook_id AND w.enabled
         WHERE d.status = 'pending' AND d.next_attempt_at <= now() ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`
      );
      if (!due[0]) return null;
      const { rows } = await tx.query<{ id: string; attempts: number; payload: WebhookEvent }>(
        `UPDATE pandocs.webhook_deliveries SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $3)
         WHERE id IN (SELECT id FROM pandocs.webhook_deliveries WHERE webhook_id = $1 AND status = 'pending' AND next_attempt_at <= now() ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         RETURNING id, attempts, payload`,
        [due[0].webhook_id, due[0].kind === "generic" ? 1 : MESSAGES_TO_A_CHAT, CLAIM_SECONDS]
      );
      return { hook: due[0], deliveries: rows };
    });
    if (!claimed) return false;
    const { hook, deliveries } = claimed;
    if (deliveries.length === 0) return true;
    const { title, defaultLang } = await this.site.get();
    // They read this in a chat, where nobody has a language of their own to ask for.
    const result = await inLanguage(defaultLang as Language, () => sender.send(
      { kind: hook.kind as WebhookKind, url: String(hook.url), secret: String(hook.secret) },
      { id: deliveries[0]!.id, siteTitle: title, events: [...deliveries].sort((a, b) => a.payload.occurredAt.localeCompare(b.payload.occurredAt)).map(item => item.payload) }
    )).catch((error: unknown): WebhookSendResult => ({ ok: false, status: null, error: error instanceof Error ? error.message : String(error) }));
    await this.record(String(hook.webhook_id), deliveries, result);
    return true;
  }

  private async record(hookId: string, deliveries: readonly { id: string; attempts: number }[], result: WebhookSendResult): Promise<void> {
    const { db } = this.context;
    const ids = deliveries.map(item => item.id);
    if (result.ok) {
      await db.query(`UPDATE pandocs.webhook_deliveries SET status = 'delivered', delivered_at = now(), response_status = $2, error = NULL WHERE id = ANY($1::uuid[])`, [ids, result.status]);
      await db.query(`UPDATE pandocs.webhooks SET consecutive_failures = 0, last_status = 'delivered', last_delivered_at = now() WHERE id = $1`, [hookId]);
      return;
    }
    for (const { id, attempts } of deliveries) {
      const exhausted = attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE pandocs.webhook_deliveries SET status = $2, next_attempt_at = now() + make_interval(secs => $3), response_status = $4, error = $5 WHERE id = $1`,
        [id, exhausted ? "failed" : "pending", BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)], result.status, result.error]
      );
    }
    await db.query(
      `UPDATE pandocs.webhooks SET consecutive_failures = consecutive_failures + 1, last_status = 'failed', enabled = enabled AND consecutive_failures + 1 < $2 WHERE id = $1`,
      [hookId, FAILURES_BEFORE_DISABLING]
    );
  }

  async sweep(): Promise<void> {
    await this.context.db.query(`DELETE FROM pandocs.webhook_deliveries WHERE status <> 'pending' AND created_at < now() - make_interval(days => $1)`, [KEPT_DAYS]);
  }
}
