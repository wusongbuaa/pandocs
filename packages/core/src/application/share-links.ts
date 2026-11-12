import { randomBytes } from "node:crypto";
import { t } from "@pandocs/i18n";
import { z } from "zod";
import { forbidden, invalid, notFound } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import { audit, requireDocument, UUID, type AppContext } from "./context.js";

export const SHARE_TOKEN_PREFIX = "pds_";
const TOKEN_BYTES = 24;
const DEFAULT_DAYS = 30;

export const shareLinkInput = z.object({
  includeChildren: z.boolean().optional(),
  /** Null keeps it going until someone revokes it. */
  expiresInDays: z.number().int().min(1).max(365).nullable().optional()
}).strict();

function mapLink(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    // Only those who can edit the page ever get this, and being able to copy it again is the point of keeping it.
    token: String(row.token),
    path: `/s/${String(row.token)}`,
    includeChildren: Boolean(row.include_children),
    createdName: String(row.created_name),
    createdAt: new Date(row.created_at as string).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at as string).toISOString() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string).toISOString() : null
  };
}

/**
 * Letting someone with no account read a page. A page only some people can read cannot be shared this way, and one that
 * becomes so stops working: whoever closed it did not mean "except for anyone with the link".
 */
export class ShareLinkService {
  constructor(private readonly context: AppContext) {}

  /** A site that must never be open to the internet has no such thing. */
  get available(): boolean {
    return this.context.ports.publicSpacesDisabled !== true;
  }

  async list(principal: Principal, documentId: string) {
    const { db } = this.context;
    await requireDocument(db, principal, documentId, "editor");
    const { rows } = await db.query(
      `SELECT * FROM pandocs.share_links WHERE document_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC`,
      [documentId]
    );
    return rows.map(mapLink);
  }

  async create(principal: Principal, documentId: string, input: z.output<typeof shareLinkInput>) {
    const { db } = this.context;
    const { document } = await requireDocument(db, principal, documentId, "editor");
    if (!this.available) throw forbidden(t("This site does not allow pages to be shared by link"));
    if (document.restricted) throw invalid("SHARE_RESTRICTED", t("A page only some people can read cannot be shared by link"));
    const days = input.expiresInDays === undefined ? DEFAULT_DAYS : input.expiresInDays;
    return db.transaction(async tx => {
      const { rows } = await tx.query(
        `INSERT INTO pandocs.share_links (token, document_id, include_children, created_by, created_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END) RETURNING *`,
        [`${SHARE_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`, documentId, input.includeChildren ?? false, principal.id, principal.displayName, days]
      );
      await audit(tx, principal, "document.share", "document", documentId, { link: rows[0]!.id, includeChildren: input.includeChildren ?? false, expiresAt: rows[0]!.expires_at });
      return mapLink(rows[0]!);
    });
  }

  async revoke(principal: Principal, id: string): Promise<void> {
    const { db } = this.context;
    if (!UUID.test(id)) throw notFound(t("Link"));
    const { rows } = await db.query<{ document_id: string }>(`SELECT document_id FROM pandocs.share_links WHERE id = $1 AND revoked_at IS NULL`, [id]);
    if (!rows[0]) throw notFound(t("Link"));
    await requireDocument(db, principal, rows[0].document_id, "editor");
    await db.transaction(async tx => {
      await tx.query(`UPDATE pandocs.share_links SET revoked_at = now() WHERE id = $1`, [id]);
      await audit(tx, principal, "document.unshare", "document", rows[0]!.document_id, { link: id });
    });
  }

  /**
   * When an account is disabled, what it shared stops letting people in on its behalf. Enabling it again does not bring
   * the links back: someone who can edit the page can share it again.
   */
  async revokeMadeBy(principal: Principal, userId: string): Promise<number> {
    if (!principal.isAdmin) throw forbidden(t("Only administrators can revoke what someone else shared"));
    return this.context.db.transaction(async tx => {
      const { rows } = await tx.query<{ id: string; document_id: string }>(
        `UPDATE pandocs.share_links SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL RETURNING id, document_id`,
        [userId]
      );
      for (const row of rows) await audit(tx, principal, "document.unshare", "document", row.document_id, { link: row.id, disabledAccount: userId });
      return rows.length;
    });
  }

  /** Who a link makes someone. Asked on every request, so that revoking or closing a page takes effect at once. */
  async principalOf(token: string): Promise<Principal | null> {
    const { db } = this.context;
    if (!this.available) return null;
    const { rows } = await db.query<{ id: string; document_id: string; include_children: boolean; space_id: string; path: string }>(
      `SELECT l.id, l.document_id, l.include_children, d.space_id, d.path FROM pandocs.share_links l
       JOIN pandocs.documents d ON d.id = l.document_id AND d.deleted_at IS NULL AND NOT d.restricted
       JOIN pandocs.spaces s ON s.id = d.space_id AND s.deleted_at IS NULL
       WHERE l.token = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())`,
      [token]
    );
    const link = rows[0];
    if (!link) return null;
    const { rows: below } = link.include_children
      ? await db.query<{ id: string }>(`SELECT id FROM pandocs.documents WHERE space_id = $1 AND deleted_at IS NULL AND NOT restricted AND starts_with(path, $2)`, [link.space_id, `${link.path}/`])
      : { rows: [] };
    await db.query(`UPDATE pandocs.share_links SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [link.id]);
    return {
      id: `share:${link.id}`,
      kind: "user",
      displayName: "",
      groups: [],
      isAdmin: false,
      scopes: ["read"],
      channel: "web",
      guest: true,
      anonymous: true,
      shared: { spaceId: link.space_id, documents: [link.document_id, ...below.map(row => row.id)] }
    };
  }
}
