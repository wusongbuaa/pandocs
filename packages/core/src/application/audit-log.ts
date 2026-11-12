import { forbidden } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import { requireSpace, type AppContext } from "./context.js";
import { t } from "@pandocs/i18n";

export const AUDIT_CATEGORIES = ["document", "discussion", "proposal", "member", "space"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

const CATEGORY_FILTER: Readonly<Record<AuditCategory, string>> = {
  document: `(e.action LIKE 'document.%' AND e.action <> 'document.member.set' AND e.action <> 'document.summarize_threads' AND e.action <> 'document.assist')`,
  discussion: `(e.action LIKE 'thread.%' OR e.action LIKE 'comment.%' OR e.action = 'document.summarize_threads')`,
  proposal: `e.action LIKE 'proposal.%'`,
  member: `e.action LIKE '%.member.set'`,
  space: `(e.action LIKE 'space.%' AND e.action <> 'space.member.set' OR e.action LIKE 'site.%')`
};

export interface AuditEntry {
  readonly id: string;
  readonly actorName: string;
  readonly actorKind: string;
  readonly channel: string;
  readonly action: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly documentTitle: string | null;
  readonly documentPath: string | null;
  readonly spaceSlug: string | null;
  readonly createdAt: Date;
}

export interface AuditQuery {
  readonly category?: AuditCategory | undefined;
  /** The `id` of the last entry already shown. */
  readonly before?: string | undefined;
  readonly limit?: number | undefined;
}

/** Discussions and proposals are logged against themselves; what a person wants to see is the page they belong to. */
const DOCUMENT_OF_EVENT = `
  LEFT JOIN LATERAL (
    SELECT d.title, d.path, d.space_id, (SELECT s.slug FROM pandocs.spaces s WHERE s.id = d.space_id) AS space_slug FROM pandocs.documents d
    WHERE d.id = CASE e.target_type
      WHEN 'document' THEN e.target_id::uuid
      WHEN 'thread' THEN (SELECT t.document_id FROM pandocs.threads t WHERE t.id = e.target_id::uuid)
      WHEN 'comment' THEN (SELECT t.document_id FROM pandocs.comments c JOIN pandocs.threads t ON t.id = c.thread_id WHERE c.id = e.target_id::uuid)
      WHEN 'proposal' THEN (SELECT p.document_id FROM pandocs.proposals p WHERE p.id = e.target_id::uuid)
    END
  ) doc ON true`;

export class AuditLogService {
  constructor(private readonly context: AppContext) {}

  private async read(where: string, params: readonly unknown[], query: AuditQuery): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const conditions = [
      where,
      ...(query.category ? [CATEGORY_FILTER[query.category]] : []),
      ...(query.before ? [`e.id < $${params.length + 2}`] : [])
    ];
    const { rows } = await this.context.db.query(
      `SELECT e.id, e.actor_id, e.actor_name, e.actor_kind, e.channel, e.action, e.detail, e.created_at, doc.title AS document_title, doc.path AS document_path, doc.space_slug
       FROM pandocs.audit_events e ${DOCUMENT_OF_EVENT}
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.id DESC LIMIT $${params.length + 1}`,
      [...params, limit, ...(query.before ? [query.before] : [])]
    );
    // Events from before names were recorded only have the identifier.
    const unnamed = [...new Set(rows.filter(row => !row.actor_name).map(row => String(row.actor_id)))];
    // A change to who can see what is about a person, not an identifier.
    const subjectOf = (row: Record<string, unknown>) =>
      /^user:(.+)$/u.exec(String((row.detail as Record<string, unknown>).subject ?? ""))?.[1];
    const subjects = rows.map(subjectOf).filter((id): id is string => id !== undefined);
    const { directory } = this.context.ports;
    const wanted = [...new Set([...unnamed, ...subjects])];
    const known = wanted.length > 0 && directory?.names ? await directory.names(wanted) : [];
    const names = new Map(known.map(person => [person.id, person.name]));
    return rows.map(row => ({
      id: String(row.id),
      actorName: String(row.actor_name ?? names.get(String(row.actor_id)) ?? row.actor_id),
      actorKind: String(row.actor_kind),
      channel: String(row.channel),
      action: String(row.action),
      detail: {
        ...(row.detail as Record<string, unknown>),
        ...(names.has(subjectOf(row) ?? "") ? { subjectName: names.get(subjectOf(row)!) } : {})
      },
      documentTitle: row.document_title ? String(row.document_title) : null,
      documentPath: row.document_path ? String(row.document_path) : null,
      spaceSlug: row.space_slug ? String(row.space_slug) : null,
      createdAt: new Date(row.created_at as string)
    }));
  }

  async forSpace(principal: Principal, slug: string, query: AuditQuery): Promise<AuditEntry[]> {
    const { space } = await requireSpace(this.context.db, principal, slug, "admin");
    return this.read(
      `((e.target_type = 'space' AND e.target_id = $1) OR doc.space_id::text = $1 OR e.detail->>'spaceId' = $1)`,
      [space.id],
      query
    );
  }

  async forSite(principal: Principal, query: AuditQuery): Promise<AuditEntry[]> {
    if (!principal.isAdmin) throw forbidden(t("Only administrators can see the site audit log"));
    return this.read("true", [], query);
  }
}
