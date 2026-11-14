import { randomUUID } from "node:crypto";
import { t } from "@pandocs/i18n";
import { relocateDocLinks } from "@pandocs/markdown";
import { atLeast, effectiveRole } from "../domain/access.js";
import { PandocsError, forbidden, invalid, notFound } from "../domain/errors.js";
import type { DocumentRecord, Principal, Role, SpaceRecord } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import {
  assertDirectWrites,
  audit,
  documentMembers,
  mapDocument,
  mapSpace,
  requireDocument,
  requireSpace,
  spaceMembers,
  UUID,
  type AppContext
} from "./context.js";
import { reservedForFrontPage, slugRule, validSlug, type DocumentService } from "./documents.js";
import { loadRevision } from "./revisions.js";

export interface TrashEntry {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly deletedAt: Date;
  readonly deletedName: string | null;
  /** Pages under it that were deleted with it and come back with it. */
  readonly descendants: number;
}

/** What someone may do with a page, whether or not it is in the trash. */
export async function roleOn(
  db: Queryable,
  principal: Principal,
  space: SpaceRecord,
  document: DocumentRecord
): Promise<Role | "none"> {
  return effectiveRole(principal, {
    defaultRole: space.defaultRole,
    publicRead: space.publicRead,
    spaceMembers: await spaceMembers(db, space.id),
    restricted: document.restricted,
    documentMembers: document.restricted ? await documentMembers(db, document.id) : []
  });
}

async function subtree(db: Queryable, spaceId: string, path: string): Promise<DocumentRecord[]> {
  const { rows } = await db.query(
    `SELECT * FROM pandocs.documents WHERE space_id = $1 AND deleted_at IS NULL AND starts_with(path, $2)`,
    [spaceId, `${path}/`]
  );
  return rows.map(mapDocument);
}

/** Renumbers rather than finding a gap: a level holds few pages, and the numbers mean nothing outside it. */
async function placeAmongSiblings(
  tx: Queryable,
  document: DocumentRecord,
  parentId: string | null,
  beforeId: string | null
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM pandocs.documents WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL AND id <> $3 ORDER BY sort_order, title`,
    [document.spaceId, parentId, document.id]
  );
  const ids = rows.map(row => row.id);
  const at = beforeId === null ? -1 : ids.indexOf(beforeId);
  if (beforeId !== null && at === -1)
    throw invalid("MOVE_TARGET_INVALID", t("The page to go before is not at this level"));
  ids.splice(at === -1 ? ids.length : at, 0, document.id);
  await tx.query(
    `UPDATE pandocs.documents d SET sort_order = o.position * 10 FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position) WHERE d.id = o.id`,
    [ids]
  );
}

interface MovedPage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** Old addresses of pages keep working, unless a page lives at that address now. */
async function rememberOldAddresses(tx: Queryable, spaceId: string, moved: readonly MovedPage[]): Promise<void> {
  await tx.query(
    `INSERT INTO pandocs.document_redirects (space_id, old_path, document_id)
     SELECT $1, old_path, id FROM unnest($2::text[], $3::uuid[]) AS m(old_path, id)
     ON CONFLICT (space_id, old_path) DO UPDATE SET document_id = EXCLUDED.document_id`,
    [spaceId, moved.map(item => item.from), moved.map(item => item.id)]
  );
  await tx.query(`DELETE FROM pandocs.document_redirects WHERE space_id = $1 AND old_path = ANY($2::text[])`, [
    spaceId,
    moved.map(item => item.to)
  ]);
}

/** How many other addresses a page coming back from the trash tries before giving up, `guide-2` to `guide-100`. */
const MOST_RESTORE_TRIES = 100;

export class TreeService {
  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService
  ) {}

  /**
   * Links from other pages reach a moved page through its old address. Its own relative links have no such help: they
   * would start from the new place and miss. Translations are rewritten in place, because they have no versions.
   */
  private async relink(tx: Queryable, principal: Principal, moved: readonly MovedPage[]): Promise<void> {
    const { registry } = this.context;
    const newPaths = new Map(moved.map(item => [item.from, item.to]));
    const movedTo = (path: string) => newPaths.get(path) ?? path;
    for (const item of moved) {
      const { rows } = await tx.query(`SELECT * FROM pandocs.documents WHERE id = $1`, [item.id]);
      const document = mapDocument(rows[0]!);
      if (document.currentRevisionNo > 0) {
        const { markdown } = await loadRevision(tx, item.id, document.currentRevisionNo);
        const relinked = relocateDocLinks(markdown, item.from, item.to, movedTo, registry);
        if (relinked !== markdown) {
          const { revision } = await this.documents.commit(tx, principal, document, {
            markdown: relinked,
            message: t("Updated relative links after a page moved")
          });
          // Only addresses changed, so a translation that was up to date still is.
          await tx.query(
            `UPDATE pandocs.document_translations SET source_revision_no = $3 WHERE document_id = $1 AND source_revision_no = $2`,
            [item.id, document.currentRevisionNo, revision.no]
          );
        }
      }
      const { rows: translations } = await tx.query<{ lang: string; markdown: string }>(
        `SELECT lang, markdown FROM pandocs.document_translations WHERE document_id = $1`,
        [item.id]
      );
      for (const { lang, markdown } of translations) {
        const relinked = relocateDocLinks(markdown, item.from, item.to, movedTo, registry);
        if (relinked !== markdown)
          await tx.query(
            `UPDATE pandocs.document_translations SET markdown = $3 WHERE document_id = $1 AND lang = $2`,
            [item.id, lang, relinked]
          );
      }
    }
  }

  /**
   * One way to rename its address, move it under another page, or change its order. Everything below the page moves
   * with it, and every old address keeps working.
   */
  async move(
    principal: Principal,
    documentId: string,
    input: { parentId?: string | null | undefined; beforeId?: string | null | undefined; slug?: string | undefined }
  ): Promise<DocumentRecord> {
    const { space, document } = await requireDocument(this.context.db, principal, documentId, "editor");
    assertDirectWrites(space);
    const parentId = input.parentId === undefined ? document.parentId : input.parentId;
    if (input.slug !== undefined && reservedForFrontPage(input.slug, parentId === null ? undefined : parentId))
      throw invalid("SLUG_INVALID", slugRule());
    return this.moveIn(principal, documentId, input);
  }

  /** The same, for what the space's rules have already been applied to. */
  async moveIn(
    principal: Principal,
    documentId: string,
    input: { parentId?: string | null | undefined; beforeId?: string | null | undefined; slug?: string | undefined }
  ): Promise<DocumentRecord> {
    return this.context.db.transaction(async tx => {
      const { document } = await requireDocument(tx, principal, documentId, "editor", true);
      const parentId = input.parentId === undefined ? document.parentId : input.parentId;
      let parentPath = "";
      if (parentId !== null) {
        const { document: parent } = await requireDocument(tx, principal, parentId, "editor");
        // The same as making a page under it: where it goes cannot go to the trash or move while this lands there.
        const { rows: still } = await tx.query(
          `SELECT 1 FROM pandocs.documents WHERE id = $1 AND path = $2 AND deleted_at IS NULL FOR SHARE`,
          [parent.id, parent.path]
        );
        if (!still[0]) throw notFound(t("Document"));
        if (parent.spaceId !== document.spaceId)
          throw invalid("MOVE_TARGET_INVALID", t("Pages can only move within a space"));
        if (parent.id === document.id || parent.path.startsWith(`${document.path}/`))
          throw invalid("MOVE_INTO_SELF", t("A page cannot move under itself"));
        parentPath = `${parent.path}/`;
      }
      const slug = input.slug ?? document.slug;
      if (!validSlug(slug)) throw invalid("SLUG_INVALID", slugRule());
      const path = `${parentPath}${slug}`;
      if (path !== document.path) {
        const below = await subtree(tx, document.spaceId, document.path);
        const moved = [document, ...below].map(item => ({
          id: item.id,
          from: item.path,
          to: `${path}${item.path.slice(document.path.length)}`
        }));
        const { rows: taken } = await tx.query<{ path: string }>(
          `SELECT path FROM pandocs.documents WHERE space_id = $1 AND deleted_at IS NULL AND lower(path) = ANY(SELECT lower(item) FROM unnest($2::text[]) AS item) AND NOT (id = ANY($3::uuid[])) LIMIT 1`,
          [document.spaceId, moved.map(item => item.to), moved.map(item => item.id)]
        );
        if (taken[0]) throw new PandocsError(409, "DOCUMENT_PATH_TAKEN", t("The path {0} is taken", taken[0].path));
        await tx.query(
          `UPDATE pandocs.documents d SET path = m.path FROM unnest($1::uuid[], $2::text[]) AS m(id, path) WHERE d.id = m.id`,
          [moved.map(item => item.id), moved.map(item => item.to)]
        );
        await rememberOldAddresses(tx, document.spaceId, moved);
        await this.relink(tx, principal, moved);
      }
      const parentChanged = parentId !== document.parentId;
      await tx.query(`UPDATE pandocs.documents SET parent_id = $2, slug = $3, updated_at = now() WHERE id = $1`, [
        documentId,
        parentId,
        slug
      ]);
      if (parentChanged || input.beforeId !== undefined)
        await placeAmongSiblings(tx, document, parentId, input.beforeId ?? null);
      await audit(tx, principal, "document.move", "document", documentId, { from: document.path, to: path });
      const { rows } = await tx.query(`SELECT * FROM pandocs.documents WHERE id = $1`, [documentId]);
      return mapDocument(rows[0]!);
    });
  }

  async remove(
    principal: Principal,
    documentId: string,
    options: { recursive?: boolean | undefined } = {}
  ): Promise<void> {
    await this.context.db.transaction(async tx => {
      const { document, space } = await requireDocument(tx, principal, documentId, "editor", true);
      assertDirectWrites(space);
      await this.removeIn(tx, principal, document, space, options);
    });
  }

  /** As part of a larger change. Whoever calls this has checked they may delete this page. */
  async removeIn(
    tx: Queryable,
    principal: Principal,
    document: DocumentRecord,
    space: SpaceRecord,
    options: { recursive?: boolean | undefined } = {}
  ): Promise<void> {
    const below = await subtree(tx, space.id, document.path);
    if (below.length > 0 && !options.recursive)
      throw new PandocsError(409, "DOCUMENT_HAS_CHILDREN", t("Deal with its subpages first"));
    for (const child of below) {
      if (!atLeast(await roleOn(tx, principal, space, child), "editor"))
        throw forbidden(t("It has subpages you cannot delete"));
    }
    await tx.query(
      `UPDATE pandocs.documents SET deleted_at = now(), deleted_by = $2, deleted_name = $3, deleted_batch = $4, updated_at = now() WHERE id = ANY($1::uuid[])`,
      [[document.id, ...below.map(child => child.id)], principal.id, principal.displayName, randomUUID()]
    );
    await audit(tx, principal, "document.delete", "document", document.id, {
      path: document.path,
      title: document.title,
      descendants: below.length
    });
  }

  async trash(principal: Principal, spaceSlug: string): Promise<TrashEntry[]> {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "editor");
    // A page deleted because its parent was comes back with the parent, so only the parent is listed.
    const { rows } = await db.query(
      `SELECT d.*, (SELECT count(*) FROM pandocs.documents c WHERE c.deleted_batch = d.deleted_batch AND c.id <> d.id) AS descendants
       FROM pandocs.documents d
       WHERE d.space_id = $1 AND d.deleted_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pandocs.documents p WHERE p.id = d.parent_id AND p.deleted_batch = d.deleted_batch)
       ORDER BY d.deleted_at DESC LIMIT 200`,
      [space.id]
    );
    const entries: TrashEntry[] = [];
    for (const row of rows) {
      if (!atLeast(await roleOn(db, principal, space, mapDocument(row)), "editor")) continue;
      entries.push({
        id: String(row.id),
        title: String(row.title),
        path: String(row.path),
        deletedAt: new Date(row.deleted_at as string),
        deletedName: row.deleted_name ? String(row.deleted_name) : null,
        descendants: Number(row.descendants)
      });
    }
    return entries;
  }

  private async deletedDocument(tx: Queryable, principal: Principal, documentId: string, required: Role) {
    if (!UUID.test(documentId)) throw notFound(t("Document"));
    const { rows } = await tx.query(
      `SELECT * FROM pandocs.documents WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE`,
      [documentId]
    );
    if (!rows[0]) throw notFound(t("Document"));
    const document = mapDocument(rows[0]);
    const { rows: spaces } = await tx.query(`SELECT * FROM pandocs.spaces WHERE id = $1 AND deleted_at IS NULL`, [
      document.spaceId
    ]);
    if (!spaces[0]) throw notFound(t("Document"));
    const space = mapSpace(spaces[0]);
    const role = await roleOn(tx, principal, space, document);
    if (!atLeast(role, "viewer")) throw notFound(t("Document"));
    if (!atLeast(role, required)) throw forbidden();
    const { rows: below } = await tx.query(
      `SELECT * FROM pandocs.documents WHERE deleted_batch = $1 AND id <> $2 AND starts_with(path, $3)`,
      [rows[0].deleted_batch, document.id, `${document.path}/`]
    );
    return { document, space, below: below.map(mapDocument) };
  }

  /** Comes back where it was. If that parent is gone it goes to the top level; if its address was taken, it gets a free one. */
  async restore(principal: Principal, documentId: string): Promise<DocumentRecord> {
    return this.context.db.transaction(async tx => {
      const found = await this.deletedDocument(tx, principal, documentId, "editor");
      assertDirectWrites(found.space);
      return this.restoreFound(tx, principal, found);
    });
  }

  /** The same, as part of a larger change such as a change set, whose rules whoever calls this has applied. */
  async restoreIn(tx: Queryable, principal: Principal, documentId: string): Promise<DocumentRecord> {
    return this.restoreFound(tx, principal, await this.deletedDocument(tx, principal, documentId, "editor"));
  }

  private async restoreFound(
    tx: Queryable,
    principal: Principal,
    { document, below }: { document: DocumentRecord; below: readonly DocumentRecord[] }
  ): Promise<DocumentRecord> {
    const { rows: parents } = await tx.query<{ path: string }>(
      `SELECT path FROM pandocs.documents WHERE id = $1 AND deleted_at IS NULL`,
      [document.parentId]
    );
    const parentPath = parents[0] ? `${parents[0].path}/` : "";
    let slug = document.slug;
    for (let suffix = 2; ; suffix += 1) {
      // Each try is a query, and nobody keeps a hundred pages at one address in the trash.
      if (suffix > MOST_RESTORE_TRIES)
        throw new PandocsError(409, "DOCUMENT_PATH_TAKEN", t("The path {0} is taken", `${parentPath}${document.slug}`));
      const taken = await tx.query(
        `SELECT 1 FROM pandocs.documents WHERE space_id = $1 AND deleted_at IS NULL AND (lower(path) = lower($2) OR starts_with(lower(path), lower($3))) LIMIT 1`,
        [document.spaceId, `${parentPath}${slug}`, `${parentPath}${slug}/`]
      );
      if (!taken.rows[0]) break;
      slug = `${document.slug}-${suffix}`;
    }
    const path = `${parentPath}${slug}`;
    await tx.query(
      `UPDATE pandocs.documents d SET path = m.path, deleted_at = NULL, deleted_by = NULL, deleted_name = NULL, deleted_batch = NULL, updated_at = now()
       FROM unnest($1::uuid[], $2::text[]) AS m(id, path) WHERE d.id = m.id`,
      [
        [document.id, ...below.map(item => item.id)],
        [path, ...below.map(item => `${path}${item.path.slice(document.path.length)}`)]
      ]
    );
    await tx.query(`UPDATE pandocs.documents SET slug = $2, parent_id = $3 WHERE id = $1`, [
      document.id,
      slug,
      parents[0] ? document.parentId : null
    ]);
    if (path !== document.path) {
      const moved = [document, ...below].map(item => ({
        id: item.id,
        from: item.path,
        to: `${path}${item.path.slice(document.path.length)}`
      }));
      await rememberOldAddresses(tx, document.spaceId, moved);
      await this.relink(tx, principal, moved);
    }
    await audit(tx, principal, "document.restore", "document", document.id, { path, descendants: below.length });
    const { rows } = await tx.query(`SELECT * FROM pandocs.documents WHERE id = $1`, [document.id]);
    return mapDocument(rows[0]!);
  }

  /** The only way a page's history really goes away. */
  /** Only what this person could delete one page at a time. */
  async emptyTrash(principal: Principal, spaceSlug: string): Promise<{ removed: number }> {
    return this.context.db.transaction(async tx => {
      const { space } = await requireSpace(tx, principal, spaceSlug, "admin");
      const { rows } = await tx.query(
        `SELECT * FROM pandocs.documents WHERE space_id = $1 AND deleted_at IS NOT NULL FOR UPDATE`,
        [space.id]
      );
      const ids: string[] = [];
      for (const row of rows) {
        const document = mapDocument(row);
        if (atLeast(await roleOn(tx, principal, space, document), "admin")) ids.push(document.id);
      }
      await tx.query(`DELETE FROM pandocs.documents WHERE id = ANY($1::uuid[])`, [ids]);
      await audit(tx, principal, "space.empty_trash", "space", space.id, { removed: ids.length, spaceId: space.id });
      return { removed: ids.length };
    });
  }

  /** Nothing is removed unless an administrator set a retention period. */
  async sweepTrash(retentionDays: number | null): Promise<number> {
    if (!retentionDays) return 0;
    const { rowCount } = await this.context.db.query(
      `DELETE FROM pandocs.documents WHERE deleted_at < now() - make_interval(days => $1)`,
      [retentionDays]
    );
    return rowCount ?? 0;
  }

  async purge(principal: Principal, documentId: string): Promise<void> {
    await this.context.db.transaction(async tx => {
      const { document, below } = await this.deletedDocument(tx, principal, documentId, "admin");
      await tx.query(`DELETE FROM pandocs.documents WHERE id = ANY($1::uuid[])`, [
        [document.id, ...below.map(item => item.id)]
      ]);
      await audit(tx, principal, "document.purge", "document", documentId, {
        path: document.path,
        title: document.title,
        descendants: below.length,
        spaceId: document.spaceId
      });
    });
  }
}
