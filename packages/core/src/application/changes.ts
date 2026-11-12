import { atLeast, effectiveRole, spaceRoleOf, subjectsOf } from "../domain/access.js";
import type { MemberRecord, Principal, SpaceDefaultRole } from "../domain/types.js";
import { requireSpace, type AppContext } from "./context.js";
import type { DocumentService } from "./documents.js";
import { tarEnd, tarEntry } from "./tar.js";

const PAGE = 500;
/** A batch stops at whichever comes first, so a space of very large pages does not end up all in memory. */
const BATCH_FILES = 200;
const BATCH_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();

export interface ManifestFile {
  /** Relative to the space's directory, with forward slashes. */
  readonly path: string;
  readonly kind: "document" | "asset";
  readonly sha256: string;
  readonly size: number;
  readonly documentId?: string | undefined;
  readonly title?: string | undefined;
  readonly revision?: number | undefined;
  readonly restricted?: boolean | undefined;
}

/** What one space looks like as files, no older than `cursor`. The same shape whether it comes over HTTP or from a shared directory. */
export interface SpaceManifest {
  readonly space: { readonly id: string; readonly slug: string; readonly name: string };
  readonly cursor: string;
  readonly files: readonly ManifestFile[];
}

export interface ChangeRow {
  /** Where this row is in the feed. Clients keep it and hand it back without looking inside. */
  readonly cursor: string;
  readonly spaceId: string;
  readonly spaceSlug: string;
  readonly kind: "document" | "discussion" | "space";
  readonly documentId: string | null;
  readonly revision: number | null;
  readonly path: string | null;
  readonly deleted: boolean;
  readonly at: Date;
  /** Only for deciding who sees the row; clients do not get it. */
  readonly restricted?: boolean | undefined;
}

export interface SpaceAccess {
  readonly readable: ReadonlySet<string>;
  readonly seesRestricted: ReadonlySet<string>;
}

export const validCursor = (cursor: string) => /^(?:0|\d{1,19}\.\d{1,18})$/u.test(cursor);
const cursorParts = (cursor: string) => (cursor === "0" ? ["0", "0"] : cursor.split("."));

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "video/mp4": "mp4", "video/webm": "webm", "application/pdf": "pdf"
};

function assetPath(row: { sha256: string; mime: string; filename: string }): string {
  const extension = EXTENSIONS[row.mime] ?? /\.([a-z0-9]{1,8})$/iu.exec(row.filename)?.[1]?.toLowerCase() ?? "bin";
  return `assets/${row.sha256}.${extension}`;
}

/** Splits files so that reading one batch of texts into memory stays bounded. */
export function batchesOf<T extends { readonly size: number }>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && (current.length >= BATCH_FILES || bytes + file.size > BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The feed of what changed, and each space as a set of files. A row says what changed, not what to do about it:
 * readers compare against current state, so seeing a row twice costs nothing and a missed one is caught by the manifest.
 *
 * A write transaction still open holds the feed back, on any database of this PostgreSQL server. Nothing is lost; rows arrive when it ends.
 */
export class ChangeService {
  constructor(private readonly context: AppContext, private readonly documents: DocumentService) {}

  /** Everything up to here is settled: no transaction can still add a row below it. */
  async watermark(): Promise<string> {
    const { rows } = await this.context.db.query<{ xid: string; seq: string }>(
      `SELECT c.xid::text AS xid, c.seq::text AS seq FROM pandocs.change_log c
       WHERE c.xid < pg_snapshot_xmin(pg_current_snapshot()) ORDER BY c.xid DESC, c.seq DESC LIMIT 1`
    );
    return rows[0] ? `${rows[0].xid}.${rows[0].seq}` : "0";
  }

  /** For processes that act on behalf of the site itself, such as publishing to a shared directory. */
  async settledSince(since: string, limit = PAGE): Promise<ChangeRow[]> {
    return this.read(since, limit, null);
  }

  /** Oldest rows go after a while; a client that fell behind that far has to start again from a manifest. */
  async sweep(): Promise<void> {
    await this.context.db.query(`DELETE FROM pandocs.change_log WHERE created_at < now() - interval '30 days'`);
  }

  private async read(since: string, limit: number, spaceIds: readonly string[] | null): Promise<ChangeRow[]> {
    const [xid, seq] = cursorParts(since);
    const { rows } = await this.context.db.query<Record<string, unknown>>(
      `SELECT c.xid::text AS xid, c.seq::text AS seq, c.space_id, s.slug AS space_slug, c.kind, c.document_id, c.revision_no, c.path, c.restricted, c.deleted, c.created_at
       FROM pandocs.change_log c LEFT JOIN pandocs.spaces s ON s.id = c.space_id
       WHERE (c.xid, c.seq) > ($1::xid8, $2::bigint) AND c.xid < pg_snapshot_xmin(pg_current_snapshot()) AND ($3::uuid[] IS NULL OR c.space_id = ANY($3::uuid[]))
       ORDER BY c.xid, c.seq LIMIT $4`,
      [xid, seq, spaceIds, limit]
    );
    return rows.map(row => ({
      cursor: `${String(row.xid)}.${String(row.seq)}`,
      spaceId: String(row.space_id),
      spaceSlug: String(row.space_slug ?? ""),
      kind: row.kind as ChangeRow["kind"],
      documentId: row.document_id ? String(row.document_id) : null,
      revision: row.revision_no === null ? null : Number(row.revision_no),
      path: row.path ? String(row.path) : null,
      deleted: Boolean(row.deleted),
      at: new Date(row.created_at as string),
      restricted: Boolean(row.restricted)
    }));
  }

  async access(principal: Principal, slug?: string | undefined): Promise<SpaceAccess> {
    const { rows } = await this.context.db.query<{ id: string; default_role: SpaceDefaultRole; public_read: boolean; members: MemberRecord[] | null }>(
      `SELECT s.id, s.default_role, s.public_read, (SELECT jsonb_agg(jsonb_build_object('subject', m.subject, 'role', m.role)) FROM pandocs.space_members m WHERE m.space_id = s.id) AS members
       FROM pandocs.spaces s WHERE s.deleted_at IS NULL AND ($1::text IS NULL OR s.slug = $1)`,
      [slug ?? null]
    );
    const readable = new Set<string>();
    const seesRestricted = new Set<string>();
    for (const space of rows) {
      const context = { defaultRole: space.default_role, publicRead: space.public_read, spaceMembers: space.members ?? [] };
      if (!atLeast(effectiveRole(principal, context), "viewer")) continue;
      readable.add(space.id);
      if (atLeast(spaceRoleOf(principal, context), "admin")) seesRestricted.add(space.id);
    }
    return { readable, seesRestricted };
  }

  /**
   * Which of these rows this person may know about. A restricted page shows up only for those who can read it, as it is
   * now: once a page is restricted, where it was is not for others to read in older rows either. They get a row saying it
   * went instead, with no address, which is all a row for a page that stopped being public says.
   */
  async visibleTo(principal: Principal, rows: readonly ChangeRow[], access: SpaceAccess): Promise<ChangeRow[]> {
    const gone = (row: ChangeRow) => row.kind === "document" && row.deleted && row.path === null;
    const candidates = rows.filter(row => access.readable.has(row.spaceId));
    const asked = [...new Set(candidates.filter(row => row.documentId && !access.seesRestricted.has(row.spaceId)).map(row => row.documentId!))];
    const restrictedNow = new Map<string, boolean>();
    if (asked.length > 0) {
      const { rows: pages } = await this.context.db.query<{ id: string; restricted: boolean }>(`SELECT id, restricted FROM pandocs.documents WHERE id = ANY($1::uuid[])`, [asked]);
      for (const page of pages) restrictedNow.set(page.id, page.restricted);
    }
    // A page deleted for good can no longer say, so the row says what it was then.
    const restricted = (row: ChangeRow) => !gone(row) && (row.documentId !== null && restrictedNow.has(row.documentId) ? restrictedNow.get(row.documentId)! : Boolean(row.restricted));
    const restrictedIds = [...new Set(candidates.filter(row => restricted(row) && !access.seesRestricted.has(row.spaceId) && row.documentId).map(row => row.documentId!))];
    const allowed = new Set<string>();
    if (restrictedIds.length > 0) {
      const { rows: granted } = await this.context.db.query<{ document_id: string }>(
        `SELECT DISTINCT document_id FROM pandocs.document_members WHERE document_id = ANY($1::uuid[]) AND subject = ANY($2::text[])`,
        [restrictedIds, [...subjectsOf(principal)]]
      );
      for (const { document_id: id } of granted) allowed.add(id);
    }
    return candidates.filter(row => !restricted(row) || access.seesRestricted.has(row.spaceId) || (row.documentId !== null && allowed.has(row.documentId)));
  }

  async since(principal: Principal, input: { since: string; space?: string | undefined; limit?: number | undefined }): Promise<{ changes: readonly ChangeRow[]; next: string; reset: boolean }> {
    const { db } = this.context;
    if (input.space) await requireSpace(db, principal, input.space);
    const access = await this.access(principal, input.space);
    const limit = Math.min(input.limit ?? PAGE, PAGE);
    const [xid, seq] = cursorParts(input.since);
    // Below everything still kept means this client may have missed rows that are gone by now.
    const { rows: oldest } = await db.query<{ behind: boolean }>(`SELECT ($1::xid8, $2::bigint) < (xid, seq) AS behind FROM pandocs.change_log ORDER BY xid, seq LIMIT 1`, [xid, seq]);
    const reset = input.since !== "0" && oldest[0]?.behind === true;
    const rows = await this.read(input.since, limit, [...access.readable]);
    const visible = await this.visibleTo(principal, rows, access);
    return {
      changes: visible.map(({ restricted: _restricted, ...row }) => row),
      next: rows.at(-1)?.cursor ?? input.since,
      reset
    };
  }

  private async assetFiles(spaceId: string, hashes: readonly string[]): Promise<ManifestFile[]> {
    if (hashes.length === 0) return [];
    const { rows } = await this.context.db.query<{ sha256: string; mime: string; filename: string; size_bytes: string }>(
      `SELECT sha256, mime, filename, size_bytes FROM pandocs.assets WHERE space_id = $1 AND sha256 = ANY($2::text[]) ORDER BY sha256`,
      [spaceId, hashes]
    );
    return rows.map(row => ({ path: assetPath(row), kind: "asset" as const, sha256: row.sha256, size: Number(row.size_bytes) }));
  }

  /** The files one person can read, with the uploads those pages use. */
  async manifest(principal: Principal, slug: string): Promise<SpaceManifest> {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, slug);
    const cursor = await this.watermark();
    const tree = await this.documents.tree(principal, slug);
    const { rows } = await db.query<{ id: string; sha256: string | null; size_bytes: number; asset_refs: string[] }>(
      `SELECT id, sha256, size_bytes, asset_refs FROM pandocs.documents WHERE space_id = $1 AND deleted_at IS NULL`,
      [space.id]
    );
    const facts = new Map(rows.map(row => [row.id, row]));
    const hashes = new Set<string>();
    const files: ManifestFile[] = tree.flatMap(node => {
      const fact = facts.get(node.id);
      if (!fact?.sha256) return [];
      for (const hash of fact.asset_refs) hashes.add(hash);
      return [{ path: `${node.path}.md`, kind: "document" as const, sha256: fact.sha256, size: fact.size_bytes, documentId: node.id, title: node.title, revision: node.currentRevisionNo, restricted: node.restricted }];
    }).sort((a, b) => (a.path < b.path ? -1 : 1));
    return { space: { id: space.id, slug: space.slug, name: space.name }, cursor, files: [...files, ...await this.assetFiles(space.id, [...hashes])] };
  }

  /** The files anyone with the mount can read: shared directories cannot tell people apart, so restricted pages and their images stay out. */
  async publishedManifest(spaceSlug: string): Promise<SpaceManifest | null> {
    const { db } = this.context;
    const { rows: spaces } = await db.query<{ id: string; slug: string; name: string }>(`SELECT id, slug, name FROM pandocs.spaces WHERE slug = $1 AND deleted_at IS NULL`, [spaceSlug]);
    const space = spaces[0];
    if (!space) return null;
    const cursor = await this.watermark();
    const { rows } = await db.query<{ id: string; path: string; title: string; sha256: string; size_bytes: number; current_revision_no: number; asset_refs: string[] }>(
      `SELECT id, path, title, sha256, size_bytes, current_revision_no, asset_refs FROM pandocs.documents
       WHERE space_id = $1 AND deleted_at IS NULL AND NOT restricted AND sha256 IS NOT NULL ORDER BY path COLLATE "C"`,
      [space.id]
    );
    const files: ManifestFile[] = rows.map(row => ({ path: `${row.path}.md`, kind: "document", sha256: row.sha256, size: row.size_bytes, documentId: row.id, title: row.title, revision: row.current_revision_no }));
    return { space, cursor, files: [...files, ...await this.assetFiles(space.id, [...new Set(rows.flatMap(row => row.asset_refs))])] };
  }

  async markdownOf(documentIds: readonly string[]): Promise<Map<string, string>> {
    const { rows } = await this.context.db.query<{ id: string; markdown: string }>(
      `SELECT d.id, r.markdown FROM pandocs.documents d JOIN pandocs.revisions r ON r.document_id = d.id AND r.no = d.current_revision_no WHERE d.id = ANY($1::uuid[])`,
      [documentIds]
    );
    return new Map(rows.map(row => [row.id, row.markdown]));
  }

  async assetBytes(spaceId: string, sha256: string): Promise<Uint8Array | null> {
    return (await this.context.ports.assets.get(`spaces/${spaceId}/${sha256}`))?.bytes ?? null;
  }

  /**
   * A space's documents and its manifest as a gzipped tar, read as the client takes it, so a large space costs neither
   * the server nor the client its memory. Uploads are left out: clients fetch them by hash, and most already have them.
   */
  archive(manifest: SpaceManifest): ReadableStream<Uint8Array> {
    const textsOf = (ids: readonly string[]) => this.markdownOf(ids);
    const mtime = Math.floor(Date.now() / 1000);
    const documents = manifest.files.filter(file => file.kind === "document");
    const parts = (async function* (): AsyncGenerator<Uint8Array> {
      yield* tarEntry(".pandocs/MANIFEST.json", encoder.encode(JSON.stringify(manifest)), mtime);
      for (const batch of batchesOf(documents)) {
        const texts = await textsOf(batch.map(file => file.documentId!));
        for (const file of batch) yield* tarEntry(file.path, encoder.encode(texts.get(file.documentId!) ?? ""), mtime);
      }
      yield tarEnd();
    })();
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await parts.next();
        if (done) controller.close();
        else if (value.length > 0) controller.enqueue(value);
      },
      cancel: async () => {
        await parts.return(undefined);
      }
    });
    return source.pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  }
}
