import { atLeast, canChangeSite, effectiveRole } from "../domain/access.js";
import { PandocsError, forbidden, invalid, notFound } from "../domain/errors.js";
import type {
  GlossaryEntry,
  MemberRecord,
  Principal,
  Role,
  SpaceDefaultRole,
  SpaceRecord,
  MergeRules
} from "../domain/types.js";
import { storageKey } from "./assets.js";
import {
  audit,
  mapSpace,
  nameMembers,
  requireSpace,
  spaceMembers,
  UUID,
  type AppContext,
  type NamedMember
} from "./context.js";
import { t } from "@pandocs/i18n";

const SUBJECT = /^(?:user:.+|group:.+|everyone)$/u;

/** A space's address is the first segment of the URL, next to the server's own addresses and the language prefixes. */
const RESERVED_SLUGS = new Set([
  "api",
  "assets",
  "auth",
  "embed",
  "forgot-password",
  "healthz",
  "login",
  "logout",
  "mcp",
  "readyz",
  "set-password",
  "setup",
  "en",
  "ja",
  "ko",
  "ru",
  "ta",
  "zh"
]);

export interface SpaceView extends SpaceRecord {
  readonly role: SpaceDefaultRole;
}

export interface DeletedSpace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly deletedAt: Date;
  readonly deletedName: string | null;
}

export class SpaceService {
  constructor(private readonly context: AppContext) {}

  async list(principal: Principal): Promise<SpaceView[]> {
    // Members come along in the same query: every page load asks for this, and a site can have many spaces.
    const { rows } = await this.context.db.query(
      `SELECT s.*, (SELECT coalesce(jsonb_agg(jsonb_build_object('subject', m.subject, 'role', m.role)), '[]') FROM pandocs.space_members m WHERE m.space_id = s.id) AS members
       FROM pandocs.spaces s WHERE s.deleted_at IS NULL ORDER BY s.name`
    );
    const views: SpaceView[] = [];
    for (const row of rows) {
      const space = mapSpace(row);
      if (principal.shared) {
        if (principal.shared.spaceId === space.id) views.push({ ...space, role: "viewer" });
        continue;
      }
      const role = effectiveRole(principal, {
        defaultRole: space.defaultRole,
        publicRead: space.publicRead,
        spaceMembers: row.members as MemberRecord[]
      });
      if (atLeast(role, "viewer")) views.push({ ...space, role });
    }
    return views;
  }

  async get(principal: Principal, slug: string): Promise<SpaceView> {
    const { space, role } = await requireSpace(this.context.db, principal, slug);
    return { ...space, role };
  }

  async create(
    principal: Principal,
    input: { slug: string; name: string; description?: string | undefined; defaultRole?: SpaceDefaultRole | undefined }
  ): Promise<SpaceView> {
    if (!canChangeSite(principal)) throw forbidden(t("Only administrators can create spaces"));
    if (RESERVED_SLUGS.has(input.slug))
      throw invalid("SPACE_SLUG_RESERVED", t("The address {0} is reserved. Choose another.", input.slug));
    return this.context.db.transaction(async tx => {
      const { rows } = await tx.query(
        `INSERT INTO pandocs.spaces (slug, name, description, default_role, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) WHERE deleted_at IS NULL DO NOTHING RETURNING *`,
        [input.slug, input.name, input.description ?? "", input.defaultRole ?? "none", principal.id]
      );
      if (!rows[0]) throw new PandocsError(409, "SPACE_SLUG_TAKEN", t("The space {0} already exists", input.slug));
      const space = mapSpace(rows[0]);
      await audit(tx, principal, "space.create", "space", space.id, { slug: space.slug });
      return { ...space, role: "admin" as const };
    });
  }

  /** The spaces open to people with no login, for deciding whether to answer them at all. */
  async publicSlugs(): Promise<string[]> {
    const { rows } = await this.context.db.query<{ slug: string }>(
      `SELECT slug FROM pandocs.spaces WHERE public_read AND deleted_at IS NULL`
    );
    return rows.map(row => row.slug);
  }

  async update(
    principal: Principal,
    slug: string,
    patch: {
      name?: string | undefined;
      description?: string | undefined;
      defaultRole?: SpaceDefaultRole | undefined;
      publicRead?: boolean | undefined;
      mergeRules?: MergeRules | undefined;
      glossary?: readonly GlossaryEntry[] | undefined;
    }
  ): Promise<SpaceView> {
    return this.context.db.transaction(async tx => {
      const { rows: locked } = await tx.query(
        `SELECT 1 FROM pandocs.spaces WHERE slug = $1 AND deleted_at IS NULL FOR UPDATE`,
        [slug]
      );
      if (!locked[0]) throw notFound(t("Space"));
      const { space, role } = await requireSpace(tx, principal, slug, "admin");
      if (patch.publicRead === true && this.context.ports.publicSpacesDisabled)
        throw new PandocsError(403, "PUBLIC_SPACES_DISABLED", t("This site does not allow public spaces"));
      const { rows } = await tx.query(
        `UPDATE pandocs.spaces SET name = $2, description = $3, default_role = $4, glossary = $5, public_read = $6, merge_rules = $7, updated_at = now() WHERE id = $1 RETURNING *`,
        [
          space.id,
          patch.name ?? space.name,
          patch.description ?? space.description,
          patch.defaultRole ?? space.defaultRole,
          JSON.stringify(patch.glossary ?? space.glossary),
          patch.publicRead ?? space.publicRead,
          JSON.stringify(patch.mergeRules ?? space.mergeRules)
        ]
      );
      if (patch.mergeRules && JSON.stringify(patch.mergeRules) !== JSON.stringify(space.mergeRules))
        await audit(tx, principal, "space.merge_rules", "space", space.id, { ...patch.mergeRules });
      // Who opened this to the whole internet, and when, is something someone will want to know.
      if (patch.publicRead !== undefined && patch.publicRead !== space.publicRead)
        await audit(tx, principal, patch.publicRead ? "space.public" : "space.private", "space", space.id, {
          slug: space.slug
        });
      // Opening a space to everyone with an account is as much someone's doing as opening it to the internet.
      if (patch.defaultRole !== undefined && patch.defaultRole !== space.defaultRole)
        await audit(tx, principal, "space.default_role", "space", space.id, {
          slug: space.slug,
          defaultRole: patch.defaultRole
        });
      return { ...mapSpace(rows[0]!), role };
    });
  }

  async members(principal: Principal, slug: string): Promise<readonly NamedMember[]> {
    const { members } = await requireSpace(this.context.db, principal, slug, "admin");
    return nameMembers(this.context, members);
  }

  async setMember(
    principal: Principal,
    slug: string,
    subject: string,
    role: Role | null
  ): Promise<readonly NamedMember[]> {
    if (!SUBJECT.test(subject))
      throw invalid("SUBJECT_INVALID", t("A grant is for user:<id>, group:<name> or everyone"));
    const { space } = await requireSpace(this.context.db, principal, slug, "admin");
    return this.context.db.transaction(async tx => {
      if (role === null) {
        await tx.query(`DELETE FROM pandocs.space_members WHERE space_id = $1 AND subject = $2`, [space.id, subject]);
      } else {
        await tx.query(
          `INSERT INTO pandocs.space_members (space_id, subject, role) VALUES ($1, $2, $3)
           ON CONFLICT (space_id, subject) DO UPDATE SET role = EXCLUDED.role`,
          [space.id, subject, role]
        );
      }
      await audit(tx, principal, "space.member.set", "space", space.id, { subject, role });
      return nameMembers(this.context, await spaceMembers(tx, space.id));
    });
  }

  /** Reversible until someone empties it from the database: pages, history and discussions all stay. */
  async remove(principal: Principal, slug: string): Promise<void> {
    if (!canChangeSite(principal)) throw forbidden(t("Only administrators can delete spaces"));
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, slug);
    await db.transaction(async tx => {
      await tx.query(
        `UPDATE pandocs.spaces SET deleted_at = now(), deleted_name = $2, updated_at = now() WHERE id = $1`,
        [space.id, principal.displayName]
      );
      await audit(tx, principal, "space.delete", "space", space.id, { slug: space.slug, name: space.name });
    });
  }

  async deleted(principal: Principal): Promise<readonly DeletedSpace[]> {
    if (!principal.isAdmin) throw forbidden(t("Only administrators can see deleted spaces"));
    const { rows } = await this.context.db.query(
      `SELECT id, slug, name, deleted_at, deleted_name FROM pandocs.spaces WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
    );
    return rows.map(row => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      deletedAt: new Date(row.deleted_at as string),
      deletedName: row.deleted_name ? String(row.deleted_name) : null
    }));
  }

  /** Back at its address, or at another one given here when a space made since has taken it. */
  async restore(principal: Principal, id: string, input: { slug?: string | undefined } = {}): Promise<SpaceView> {
    if (!canChangeSite(principal)) throw forbidden(t("Only administrators can restore spaces"));
    if (!UUID.test(id)) throw notFound(t("Space"));
    return this.context.db.transaction(async tx => {
      const { rows } = await tx.query(
        `SELECT * FROM pandocs.spaces WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE`,
        [id]
      );
      if (!rows[0]) throw notFound(t("Space"));
      const slug = input.slug ?? String(rows[0].slug);
      // The addresses a restored space could take are the ones a new one could: next to the server's own routes is not among them.
      if (RESERVED_SLUGS.has(slug))
        throw invalid("SPACE_SLUG_RESERVED", t("The address {0} is reserved. Choose another.", slug));
      const taken = await tx.query(`SELECT 1 FROM pandocs.spaces WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
      if (taken.rows[0])
        throw new PandocsError(
          409,
          "SPACE_SLUG_TAKEN",
          t("Another space has the address {0}. Restore this one at another address.", slug)
        );
      // A site that has since turned public spaces off keeps them off: restoring cannot do what the settings refuse.
      const publicRead = rows[0].public_read === true && !this.context.ports.publicSpacesDisabled;
      const { rows: restored } = await tx.query(
        `UPDATE pandocs.spaces SET slug = $2, deleted_at = NULL, deleted_name = NULL, public_read = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, slug, publicRead]
      );
      await audit(tx, principal, "space.restore", "space", id, {
        slug,
        ...(slug === rows[0].slug ? {} : { was: rows[0].slug }),
        ...(publicRead === false && rows[0].public_read === true ? { publicRead: false } : {})
      });
      return { ...mapSpace(restored[0]!), role: "admin" as const };
    });
  }

  /**
   * The end of a deleted space: its pages, history, discussions and uploads go with it, and it cannot come back.
   * Only one that is already deleted, so deleting a space people still use stays reversible.
   * Uploads leave the store after the row is gone. A store that fails then leaves files nobody can reach, which is the
   * direction that can be cleaned up later; the other way would be a space that looks deleted and is not.
   */
  async purge(principal: Principal, id: string): Promise<void> {
    if (!canChangeSite(principal)) throw forbidden(t("Only administrators can delete spaces for good"));
    if (!UUID.test(id)) throw notFound(t("Space"));
    const removed = await this.context.db.transaction(async tx => {
      const { rows } = await tx.query(
        `SELECT slug, name FROM pandocs.spaces WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE`,
        [id]
      );
      if (!rows[0]) throw notFound(t("Space"));
      const { rows: counted } = await tx.query<{ pages: string; assets: string; hashes: string[] }>(
        `SELECT (SELECT count(*) FROM pandocs.documents WHERE space_id = $1) AS pages,
                (SELECT count(*) FROM pandocs.assets WHERE space_id = $1) AS assets,
                (SELECT coalesce(array_agg(sha256), '{}') FROM pandocs.assets WHERE space_id = $1) AS hashes`,
        [id]
      );
      // A file chosen for import is kept beside the space's uploads until the import finishes, so it goes too.
      const { rows: imports } = await tx.query<{ id: string }>(
        `SELECT id FROM pandocs.bulk_imports WHERE space_id = $1`,
        [id]
      );
      await tx.query(`DELETE FROM pandocs.spaces WHERE id = $1`, [id]);
      await audit(tx, principal, "space.purge", "space", id, {
        slug: rows[0].slug,
        name: rows[0].name,
        pages: Number(counted[0]?.pages ?? 0),
        assets: Number(counted[0]?.assets ?? 0)
      });
      return { hashes: counted[0]?.hashes ?? [], imports: imports.map(row => row.id) };
    });
    const { remove } = this.context.ports.assets;
    if (!remove) return;
    await Promise.all([
      ...removed.hashes.map(sha256 => remove(storageKey(id, sha256))),
      ...removed.imports.map(importId => remove(`imports/${importId}`))
    ]);
  }
}
