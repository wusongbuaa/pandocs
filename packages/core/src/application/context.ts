import { t } from "@pandocs/i18n";
import type { BlockRegistry, DocumentAnalysis } from "@pandocs/markdown";
import { atLeast, effectiveRole } from "../domain/access.js";
import { PandocsError, forbidden, notFound } from "../domain/errors.js";
import type { DocumentRecord, GlossaryEntry, MemberRecord, MergeRules, Principal, Role, SpaceDefaultRole, SpaceRecord } from "../domain/types.js";
import type { PandocsDb, Queryable } from "../infrastructure/db.js";
import type { PandocsPorts } from "../ports.js";
import { announce } from "./webhook-events.js";

export interface AppContext {
  readonly db: PandocsDb;
  readonly ports: PandocsPorts;
  readonly registry: BlockRegistry;
  readonly analyze: (markdown: string) => Promise<DocumentAnalysis>;
}

export async function audit(tx: Queryable, principal: Principal, action: string, targetType: string, targetId: string, detail: object = {}): Promise<void> {
  await tx.query(
    `INSERT INTO pandocs.audit_events (actor_id, actor_name, actor_kind, channel, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [principal.id, principal.displayName, principal.kind, principal.channel, action, targetType, targetId, JSON.stringify(detail)]
  );
  await announce(tx, principal, action, targetId, detail);
}

/** For a space that has said changes go through review, which leaves nobody a way around it but changing that. */
export function assertDirectWrites(space: SpaceRecord): void {
  if (space.mergeRules.requireChangeSets) throw new PandocsError(403, "CHANGE_SET_REQUIRED", t("Changes in this space go through change sets"));
}

export function mapSpace(row: Record<string, unknown>): SpaceRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    defaultRole: row.default_role as SpaceDefaultRole,
    publicRead: row.public_read === true,
    glossary: (row.glossary ?? []) as GlossaryEntry[],
    mergeRules: { requiredApprovals: 0, requireChangeSets: false, ...(row.merge_rules ?? {}) as Partial<MergeRules> }
  };
}

export function mapDocument(row: Record<string, unknown>): DocumentRecord {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    slug: String(row.slug),
    path: String(row.path),
    title: String(row.title),
    sortOrder: Number(row.sort_order),
    restricted: Boolean(row.restricted),
    currentRevisionNo: Number(row.current_revision_no),
    editingBy: row.editing_by ? String(row.editing_by) : null,
    editingName: row.editing_name ? String(row.editing_name) : null,
    editingUntil: row.editing_until ? new Date(row.editing_until as string) : null,
    updatedAt: new Date(row.updated_at as string)
  };
}

export async function spaceMembers(db: Queryable, spaceId: string): Promise<MemberRecord[]> {
  const { rows } = await db.query<{ subject: string; role: Role }>(`SELECT subject, role FROM pandocs.space_members WHERE space_id = $1`, [spaceId]);
  return rows;
}

export async function documentMembers(db: Queryable, documentId: string): Promise<MemberRecord[]> {
  const { rows } = await db.query<{ subject: string; role: Role }>(`SELECT subject, role FROM pandocs.document_members WHERE document_id = $1`, [documentId]);
  return rows;
}

export interface NamedMember extends MemberRecord {
  /** Absent for groups, and for people the directory no longer knows. */
  readonly name?: string | undefined;
}

export async function nameMembers({ ports }: Pick<AppContext, "ports">, members: readonly MemberRecord[]): Promise<NamedMember[]> {
  const ids = members.filter(member => member.subject.startsWith("user:")).map(member => member.subject.slice("user:".length));
  const known = ids.length > 0 && ports.directory?.names ? await ports.directory.names(ids) : [];
  const names = new Map(known.map(person => [`user:${person.id}`, person.name]));
  return members.map(member => ({ ...member, ...(names.has(member.subject) ? { name: names.get(member.subject) } : {}) }));
}

export interface SpaceAccess {
  readonly space: SpaceRecord;
  readonly role: SpaceDefaultRole;
  readonly members: readonly MemberRecord[];
}

/** Anything a principal may not see answers 404, so existence never leaks. */
export async function requireSpace(db: Queryable, principal: Principal, slug: string, required: Role = "viewer"): Promise<SpaceAccess> {
  const { rows } = await db.query(`SELECT * FROM pandocs.spaces WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
  if (!rows[0]) throw notFound(t("Space"));
  const space = mapSpace(rows[0]);
  const members = await spaceMembers(db, space.id);
  if (principal.shared) {
    if (principal.shared.spaceId !== space.id) throw notFound(t("Space"));
    if (required !== "viewer") throw forbidden();
    return { space, role: "viewer", members };
  }
  const role = effectiveRole(principal, { defaultRole: space.defaultRole, publicRead: space.publicRead, spaceMembers: members });
  if (!atLeast(role, "viewer")) throw notFound(t("Space"));
  if (!atLeast(role, required)) throw forbidden();
  return { space, role, members };
}

export interface DocumentAccess {
  readonly document: DocumentRecord;
  readonly space: SpaceRecord;
  readonly role: SpaceDefaultRole;
}

export async function requireDocument(db: Queryable, principal: Principal, documentId: string, required: Role = "viewer", lock = false): Promise<DocumentAccess> {
  if (!UUID.test(documentId)) throw notFound(t("Document"));
  const { rows } = await db.query(
    `SELECT * FROM pandocs.documents WHERE id = $1 AND deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
    [documentId]
  );
  if (!rows[0]) throw notFound(t("Document"));
  const document = mapDocument(rows[0]);
  const { rows: spaceRows } = await db.query(`SELECT * FROM pandocs.spaces WHERE id = $1 AND deleted_at IS NULL`, [document.spaceId]);
  if (!spaceRows[0]) throw notFound(t("Document"));
  const space = mapSpace(spaceRows[0]);
  if (principal.shared) {
    if (!principal.shared.documents.includes(document.id)) throw notFound(t("Document"));
    if (required !== "viewer") throw forbidden();
    return { document, space, role: "viewer" };
  }
  const role = effectiveRole(principal, {
    defaultRole: space.defaultRole,
    publicRead: space.publicRead,
    spaceMembers: await spaceMembers(db, space.id),
    restricted: document.restricted,
    documentMembers: document.restricted ? await documentMembers(db, document.id) : []
  });
  if (!atLeast(role, "viewer")) throw notFound(t("Document"));
  if (!atLeast(role, required)) throw forbidden(required === "editor" && principal.kind === "agent" ? t("Agents cannot change documents directly. Create a proposal instead.") : undefined);
  return { document, space, role };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
