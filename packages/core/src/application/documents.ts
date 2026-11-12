import { createHash } from "node:crypto";
import { currentLanguage, t } from "@pandocs/i18n";
import {
  assetHashesIn,
  applyEditOps,
  EditOpError,
  mergeThreeWay,
  outlineOf,
  parseDocument,
  readScoped,
  ScopeError,
  searchQuery,
  type Diagnostic,
  type DocumentAnalysis,
  type EditOp,
  type OutlineEntry,
  type ReadScope,
  type ScopedBlock,
  type SourceBlock
} from "@pandocs/markdown";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { atLeast, canChangeSite, effectiveRole, spaceRoleOf, subjectsOf } from "../domain/access.js";
import { PandocsError, forbidden, invalid, notFound, revisionConflict } from "../domain/errors.js";
import type {
  DocumentRecord,
  MemberRecord,
  Principal,
  RevisionRecord,
  Role,
  SpaceDefaultRole,
  SpaceRecord
} from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import {
  assertDirectWrites,
  audit,
  documentMembers,
  mapDocument,
  nameMembers,
  requireDocument,
  requireSpace,
  spaceMembers,
  type AppContext,
  type NamedMember
} from "./context.js";
import { tellFollowers } from "./subscriptions.js";
import { loadRevision, mapRevision, metaOf, type RevisionMeta } from "./revisions.js";
import { relocateOpenThreads } from "./threads.js";
import type { TranslationService } from "./translations.js";

export type { RevisionMeta };

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const ANALYSES_MAX_BYTES = 128 * 1024 * 1024;

/** Keyed by content, so it stays right when a rolled-back commit reuses a revision number. Most recently used stays. */
class AnalysisCache {
  private readonly entries = new Map<string, { analysis: DocumentAnalysis; size: number }>();
  private bytes = 0;

  get(sha256: string): DocumentAnalysis | undefined {
    const entry = this.entries.get(sha256);
    if (!entry) return undefined;
    this.entries.delete(sha256);
    this.entries.set(sha256, entry);
    return entry.analysis;
  }

  set(sha256: string, analysis: DocumentAnalysis): void {
    if (this.entries.has(sha256)) return;
    const size = analysis.visibleText.length * 2 + (analysis.blocks.length + analysis.outline.length) * 200;
    this.entries.set(sha256, { analysis, size });
    this.bytes += size;
    for (const [key, entry] of this.entries) {
      if (this.bytes <= ANALYSES_MAX_BYTES) break;
      this.entries.delete(key);
      this.bytes -= entry.size;
    }
  }
}
const EDITING_TTL_SECONDS = 90;

export interface DocumentView {
  readonly document: DocumentRecord;
  readonly spaceSlug: string;
  readonly role: SpaceDefaultRole;
  readonly revision: RevisionMeta;
  readonly markdown?: string | undefined;
  readonly outline: readonly OutlineEntry[];
  readonly blocks: readonly (SourceBlock | ScopedBlock)[];
  readonly diagnostics: readonly Diagnostic[];
  readonly editing: { readonly name: string; readonly until: Date } | null;
}

export interface CommitResult {
  readonly document: DocumentRecord;
  readonly revision: RevisionMeta;
  readonly changed: boolean;
  readonly merged: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export const documentLabels = z.array(z.string().trim().min(1).max(40)).max(20);

export interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly sortOrder: number;
  readonly restricted: boolean;
  readonly currentRevisionNo: number;
  readonly updatedAt: Date;
  /** False for a page that only holds its children, which the sidebar shows as a section heading. */
  readonly hasContent: boolean;
  /** Its title in the languages it has been translated into. */
  readonly titles: Readonly<Record<string, string>>;
  readonly labels: readonly string[];
}

export interface SearchIndexEntry {
  readonly id: number;
  readonly title: string;
  readonly routePath: string;
  readonly toc: readonly {
    readonly id: string;
    readonly text: string;
    readonly depth: number;
    readonly charIndex: number;
  }[];
  readonly content: string;
  readonly frontmatter: Readonly<Record<string, never>>;
  readonly lang: string;
  readonly version: string;
  readonly _filepath: string;
  readonly _relativePath: string;
}

/** A space's front page lives at this path; the app serves it from the space's own URL. */
export const HOME_DOCUMENT_PATH = "index";

const UNPORTABLE_NAME = /[/\\\s<>:"|?*\p{Cc}]/u;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu;

/**
 * A segment of a page's path. Pages also exist as `<path>.md` on every platform, so it has to work as a file name on
 * all of them and cannot climb out of its directory. Ending in `.md` could put a file and a directory at the same name.
 */
/** A percent sign or a hash in an address reads as an escape or as where in the page to go, and `.html` is dropped by the site. */
const NOT_AN_ADDRESS = /[%#]|\.html$/iu;
export const validSlug = (slug: string) =>
  slug.length > 0 &&
  slug.length <= 120 &&
  Buffer.byteLength(slug, "utf8") <= 240 &&
  !UNPORTABLE_NAME.test(slug) &&
  !slug.startsWith(".") &&
  !slug.endsWith(".") &&
  !/\.md$/iu.test(slug) &&
  !RESERVED_NAME.test(slug) &&
  !NOT_AN_ADDRESS.test(slug);
export const slugRule = () =>
  t(
    "A path segment cannot contain slashes, whitespace or < > : \" | ? * % #, start or end with a dot, end in .md or .html, or be a name systems reserve such as CON or NUL. Only a space's front page is called index."
  );
/** The site opens `a/index` as `a`, and `Index` as the front page, so only the front page itself can be called that. */
export const reservedForFrontPage = (slug: string, parentPath: string | undefined) =>
  slug.toLowerCase() === HOME_DOCUMENT_PATH && (Boolean(parentPath) || slug !== HOME_DOCUMENT_PATH);

export function slugFromTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug.slice(0, 80) || `page-${Date.now().toString(36)}`;
}

export interface MyDraft {
  readonly documentId: string;
  readonly lang: string;
  readonly title: string;
  readonly path: string;
  readonly spaceSlug: string;
  readonly spaceName: string;
  readonly updatedAt: Date;
}

export interface CommitInput {
  readonly markdown: string;
  readonly message?: string | undefined;
  readonly proposalId?: string | undefined;
  readonly ingestJobId?: string | undefined;
  readonly strict?: boolean | undefined;
  readonly changeSetId?: string | undefined;
}

/** Above this much text the browser's index only holds titles and headings, and full text comes from the server. */
const BROWSER_INDEX_MAX_CHARS = 4_000_000;
const SEARCH_CANDIDATES = 200;

/** What an analysis says about problems is in the language of whoever asked. */
const analysisKey = (sha256: string) => `${currentLanguage()}:${sha256}`;

export class DocumentService {
  private readonly analyses = new AnalysisCache();

  constructor(private readonly context: AppContext) {}

  private async analysisOf(sha256: string, markdown: string): Promise<DocumentAnalysis> {
    const key = analysisKey(sha256);
    const known = this.analyses.get(key);
    if (known) return known;
    const { searchTokens: _searchTokens, ...analysis } = await this.context.analyze(markdown);
    this.analyses.set(key, analysis);
    return analysis;
  }

  async tree(principal: Principal, spaceSlug: string): Promise<TreeNode[]> {
    const { db } = this.context;
    const { space, members } = await requireSpace(db, principal, spaceSlug);
    const { rows } = await db.query(
      `SELECT d.*, t.titles, l.labels FROM pandocs.documents d
       LEFT JOIN (SELECT document_id, jsonb_object_agg(lang, title) AS titles FROM pandocs.document_translations GROUP BY document_id) t ON t.document_id = d.id
       LEFT JOIN (SELECT document_id, array_agg(label ORDER BY lower(label)) AS labels FROM pandocs.document_labels GROUP BY document_id) l ON l.document_id = d.id
       WHERE d.space_id = $1 AND d.deleted_at IS NULL ORDER BY d.sort_order, d.title`,
      [space.id]
    );
    const restrictedMembers = new Map<string, MemberRecord[]>();
    if (rows.some(row => row.restricted)) {
      const { rows: grants } = await db.query<{ document_id: string; subject: string; role: Role }>(
        `SELECT m.document_id, m.subject, m.role FROM pandocs.document_members m JOIN pandocs.documents d ON d.id = m.document_id WHERE d.space_id = $1 AND d.restricted`,
        [space.id]
      );
      for (const { document_id: id, subject, role } of grants)
        restrictedMembers.set(id, [...(restrictedMembers.get(id) ?? []), { subject, role }]);
    }
    const visible: TreeNode[] = [];
    for (const row of rows) {
      const document = mapDocument(row);
      const role = effectiveRole(principal, {
        defaultRole: space.defaultRole,
        publicRead: space.publicRead,
        spaceMembers: members,
        restricted: document.restricted,
        documentMembers: restrictedMembers.get(document.id) ?? []
      });
      if (principal.shared ? !principal.shared.documents.includes(document.id) : !atLeast(role, "viewer")) continue;
      const { id, parentId, slug, path, title, sortOrder, restricted, currentRevisionNo, updatedAt } = document;
      visible.push({
        id,
        parentId,
        slug,
        path,
        title,
        sortOrder,
        restricted,
        currentRevisionNo,
        updatedAt,
        hasContent: Boolean(row.has_content),
        labels: (row.labels ?? []) as string[],
        titles: (row.titles ?? {}) as Record<string, string>
      });
    }
    return visible;
  }

  /** Labels are about a page rather than in it: changing them makes no new version, and needs edit access. They count as the same in any letter case. */
  async setLabels(principal: Principal, documentId: string, labels: readonly string[]): Promise<readonly string[]> {
    const distinct = [
      ...new Map(
        labels
          .map(label => label.trim().replace(/\s+/gu, " "))
          .filter(Boolean)
          .map(label => [label.toLowerCase(), label])
      ).values()
    ];
    return this.context.db.transaction(async tx => {
      await requireDocument(tx, principal, documentId, "editor", true);
      await tx.query(`DELETE FROM pandocs.document_labels WHERE document_id = $1`, [documentId]);
      if (distinct.length > 0)
        await tx.query(`INSERT INTO pandocs.document_labels (document_id, label) SELECT $1, unnest($2::text[])`, [
          documentId,
          distinct
        ]);
      await audit(tx, principal, "document.labels", "document", documentId, { labels: distinct });
      return [...distinct].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    });
  }

  /** What is in use in a space, by what this person can read. */
  async spaceLabels(
    principal: Principal,
    spaceSlug: string
  ): Promise<readonly { readonly label: string; readonly pages: number }[]> {
    const counts = new Map<string, { label: string; pages: number }>();
    for (const { labels } of await this.tree(principal, spaceSlug)) {
      for (const label of labels) {
        const known = counts.get(label.toLowerCase());
        if (known) known.pages += 1;
        else counts.set(label.toLowerCase(), { label, pages: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.pages - a.pages || a.label.localeCompare(b.label));
  }

  /** An address a page used to have still finds it. */
  async resolve(
    principal: Principal,
    spaceSlug: string,
    path: string
  ): Promise<{ id: string; path: string; redirected: boolean }> {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM pandocs.documents WHERE space_id = $1 AND path = $2 AND deleted_at IS NULL`,
      [space.id, path]
    );
    if (rows[0]) {
      await requireDocument(db, principal, rows[0].id);
      return { id: rows[0].id, path, redirected: false };
    }
    const { rows: moved } = await db.query<{ document_id: string }>(
      `SELECT document_id FROM pandocs.document_redirects WHERE space_id = $1 AND old_path = $2`,
      [space.id, path]
    );
    if (!moved[0]) throw notFound(t("Document"));
    const { document } = await requireDocument(db, principal, moved[0].document_id);
    return { id: document.id, path: document.path, redirected: true };
  }

  async resolvePath(principal: Principal, spaceSlug: string, path: string): Promise<string> {
    return (await this.resolve(principal, spaceSlug, path)).id;
  }

  async read(
    principal: Principal,
    documentId: string,
    options: { scope?: ReadScope | undefined; revision?: number | undefined } = {}
  ): Promise<DocumentView> {
    const { db } = this.context;
    const { document, space, role } = await requireDocument(db, principal, documentId);
    const revision = await loadRevision(db, documentId, options.revision ?? document.currentRevisionNo);
    const analysis = await this.analysisOf(revision.sha256, revision.markdown);
    const editing =
      document.editingBy &&
      document.editingBy !== principal.id &&
      document.editingUntil &&
      document.editingUntil > new Date()
        ? { name: document.editingName ?? "", until: document.editingUntil }
        : null;
    const { rows: labelled } = await db.query<{ label: string }>(
      `SELECT label FROM pandocs.document_labels WHERE document_id = $1 ORDER BY lower(label)`,
      [documentId]
    );
    const base = {
      document,
      spaceSlug: space.slug,
      role,
      revision: metaOf(revision),
      diagnostics: analysis.diagnostics,
      editing,
      labels: labelled.map(row => row.label)
    };
    if (options.scope && options.scope.scope !== "full") {
      try {
        const scoped = readScoped({ markdown: revision.markdown, analysis }, options.scope);
        return { ...base, outline: scoped.outline, blocks: scoped.blocks };
      } catch (error) {
        if (error instanceof ScopeError) throw invalid(error.code, error.message);
        throw error;
      }
    }
    return { ...base, markdown: revision.markdown, outline: analysis.outline, blocks: analysis.blocks };
  }

  async create(
    principal: Principal,
    input: {
      space: string;
      title: string;
      markdown: string;
      parentPath?: string | undefined;
      slug?: string | undefined;
      sortOrder?: number | undefined;
      restricted?: boolean | undefined;
      message?: string | undefined;
      ingestJobId?: string | undefined;
      strict?: boolean | undefined;
    }
  ): Promise<CommitResult> {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, input.space, "editor");
    if (input.slug !== undefined && reservedForFrontPage(input.slug, input.parentPath))
      throw invalid("SLUG_INVALID", slugRule());
    if (input.restricted && !canChangeSite(principal)) {
      await requireSpace(db, principal, input.space, "admin");
    }
    assertDirectWrites(space);
    return db.transaction(tx => this.createIn(tx, principal, space, input));
  }

  /** The new page and its first version, as part of a larger change. Whoever calls this has checked they may. */
  async createIn(
    tx: Queryable,
    principal: Principal,
    space: Pick<SpaceRecord, "id">,
    input: {
      title: string;
      markdown: string;
      parentPath?: string | undefined;
      slug?: string | undefined;
      sortOrder?: number | undefined;
      restricted?: boolean | undefined;
      message?: string | undefined;
      ingestJobId?: string | undefined;
      strict?: boolean | undefined;
      changeSetId?: string | undefined;
    }
  ): Promise<CommitResult> {
    // A page called Index, or anything that comes out as index, keeps its title and gets an address the site can open.
    const generated = input.slug === undefined ? slugFromTitle(input.title) : null;
    const slug =
      input.slug ??
      (generated !== null && reservedForFrontPage(generated, input.parentPath) ? `${generated}-page` : generated!);
    if (!validSlug(slug)) throw invalid("SLUG_INVALID", slugRule());
    let parentId: string | null = null;
    let path = slug;
    if (input.parentPath) {
      // Held until this page exists, so that the page above cannot go to the trash or move without it in the meantime.
      // One that did so first is no longer where it was, and the page has nowhere to go.
      const { rows } = await tx.query<{ id: string; path: string }>(
        `SELECT id, path FROM pandocs.documents WHERE space_id = $1 AND path = $2 AND deleted_at IS NULL FOR SHARE`,
        [space.id, input.parentPath]
      );
      if (!rows[0]) throw notFound(t("Parent document"));
      parentId = rows[0].id;
      path = `${rows[0].path}/${slug}`;
    }
    const taken = await tx.query(
      `SELECT 1 FROM pandocs.documents WHERE space_id = $1 AND lower(path) = lower($2) AND deleted_at IS NULL`,
      [space.id, path]
    );
    if (taken.rows[0]) throw new PandocsError(409, "DOCUMENT_PATH_TAKEN", t("The path {0} is taken", path));
    // A new page goes after its siblings unless the caller says otherwise.
    const { rows: last } = await tx.query<{ next: number }>(
      // A sibling at the end of the range leaves no room after it; the new page shares its place rather than failing.
      `SELECT LEAST(COALESCE(MAX(sort_order), 0)::bigint + 10, 2147483647)::int AS next FROM pandocs.documents WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
      [space.id, parentId]
    );
    const { rows } = await tx.query(
      `INSERT INTO pandocs.documents (space_id, parent_id, slug, path, title, sort_order, restricted, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        space.id,
        parentId,
        slug,
        path,
        input.title,
        input.sortOrder ?? last[0]!.next,
        input.restricted ?? false,
        principal.id
      ]
    );
    const document = mapDocument(rows[0]!);
    await audit(tx, principal, "document.create", "document", document.id, { path });
    return this.commit(tx, principal, document, {
      markdown: input.markdown,
      message: input.message ?? t("Created the document"),
      ingestJobId: input.ingestJobId,
      strict: input.strict,
      changeSetId: input.changeSetId
    });
  }

  /** Whole-document save. `merge` lets a stale editor merge block by block instead of failing outright. */
  async saveContent(
    principal: Principal,
    documentId: string,
    input: {
      markdown: string;
      expectedRevision: number;
      message?: string | undefined;
      merge?: boolean | undefined;
      strict?: boolean | undefined;
      title?: string | undefined;
      fromLiveDraft?: boolean | undefined;
    }
  ): Promise<CommitResult> {
    return this.context.db.transaction(async tx => {
      const { document, space } = await requireDocument(tx, principal, documentId, "editor", true);
      assertDirectWrites(space);
      let markdown = input.markdown;
      let merged = false;
      if (document.currentRevisionNo !== input.expectedRevision) {
        if (!input.merge) throw revisionConflict(document.currentRevisionNo);
        const base = await loadRevision(tx, documentId, input.expectedRevision);
        const current = await loadRevision(tx, documentId, document.currentRevisionNo);
        const result = mergeThreeWay(base.markdown, markdown, current.markdown, this.context.registry);
        if (!result.ok) {
          throw new PandocsError(
            409,
            "MERGE_CONFLICT",
            t("Someone changed the same text, so this needs merging by hand"),
            { currentRevision: document.currentRevisionNo, conflicts: result.conflicts }
          );
        }
        markdown = result.markdown;
        merged = true;
      }
      const committed = await this.commit(tx, principal, document, {
        markdown,
        message: input.fromLiveDraft
          ? await this.creditingOthers(tx, principal, documentId, input.message)
          : input.message,
        strict: input.strict
      });
      // A title has no versions of its own, but the editor saves it with the text so neither lands without the other.
      if (input.title === undefined || input.title === document.title) return { ...committed, merged };
      const { rows } = await tx.query(
        `UPDATE pandocs.documents SET title = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [documentId, input.title]
      );
      await audit(tx, principal, "document.update", "document", documentId, { title: input.title });
      return { ...committed, document: mapDocument(rows[0]!), merged };
    });
  }

  /** A version saved from a shared draft has one author on record, and says who else wrote it. */
  private async creditingOthers(
    tx: Queryable,
    principal: Principal,
    documentId: string,
    message: string | undefined
  ): Promise<string | undefined> {
    const { rows } = await tx.query<{ contributors: Readonly<Record<string, string>> }>(
      `SELECT contributors FROM pandocs.live_drafts WHERE document_id = $1`,
      [documentId]
    );
    const others = Object.entries(rows[0]?.contributors ?? {})
      .filter(([id]) => id !== principal.id)
      .map(([, name]) => name);
    if (others.length === 0) return message;
    const credit = t("Written with {0}", others.join(", "));
    return message ? `${message} (${credit})` : credit;
  }

  /** Block refs only mean something against the revision they were read from, so stale edits always fail. */
  async applyOps(
    principal: Principal,
    documentId: string,
    input: {
      ops: readonly EditOp[];
      expectedRevision: number;
      message?: string | undefined;
      strict?: boolean | undefined;
    }
  ): Promise<CommitResult> {
    return this.context.db.transaction(async tx => {
      const { document, space } = await requireDocument(tx, principal, documentId, "editor", true);
      assertDirectWrites(space);
      if (document.currentRevisionNo !== input.expectedRevision) throw revisionConflict(document.currentRevisionNo);
      const current = await loadRevision(tx, documentId, document.currentRevisionNo);
      return this.commit(tx, principal, document, {
        markdown: applyOpsOrThrow(current.markdown, input.ops, this.context),
        message: input.message,
        strict: input.strict
      });
    });
  }

  async rollback(
    principal: Principal,
    documentId: string,
    input: { to: number; expectedRevision: number }
  ): Promise<CommitResult> {
    return this.context.db.transaction(async tx => {
      const { document, space } = await requireDocument(tx, principal, documentId, "editor", true);
      assertDirectWrites(space);
      if (document.currentRevisionNo !== input.expectedRevision) throw revisionConflict(document.currentRevisionNo);
      const target = await loadRevision(tx, documentId, input.to);
      return this.commit(tx, principal, document, {
        markdown: target.markdown,
        message: t("Restored version {0}", input.to)
      });
    });
  }

  /** The single write path: every version, from any channel, goes through here and relocates open threads. */
  async commit(
    tx: Queryable,
    principal: Principal,
    document: DocumentRecord,
    input: CommitInput
  ): Promise<CommitResult> {
    if (Buffer.byteLength(input.markdown, "utf8") > MAX_MARKDOWN_BYTES)
      throw invalid("DOCUMENT_TOO_LARGE", t("The document is larger than 2 MiB"));
    const sha256 = createHash("sha256").update(input.markdown).digest("hex");
    const analysis = await this.context.analyze(input.markdown);
    this.analyses.set(analysisKey(sha256), { ...analysis, searchTokens: undefined });
    // Every reader would only see its source, and anything walking it would have to be careful, so it never becomes a version.
    const tooDeep = analysis.diagnostics.find(item => item.code === "DOCUMENT_TOO_DEEP");
    if (tooDeep) throw invalid("DOCUMENT_TOO_DEEP", tooDeep.message);
    if (input.strict && analysis.diagnostics.some(item => item.severity === "error")) {
      throw invalid("DOCUMENT_INVALID", t("The document has blocks with markup errors"), {
        diagnostics: analysis.diagnostics
      });
    }
    if (document.currentRevisionNo > 0) {
      const current = await loadRevision(tx, document.id, document.currentRevisionNo);
      if (current.sha256 === sha256) {
        return {
          document,
          revision: metaOf(current),
          changed: false,
          merged: false,
          diagnostics: analysis.diagnostics
        };
      }
    }
    const no = document.currentRevisionNo + 1;
    const text = analysis.visibleText;
    const { rows } = await tx.query(
      `INSERT INTO pandocs.revisions (document_id, no, markdown, sha256, visible_text, actor_id, actor_name, actor_kind, channel, on_behalf_of, proposal_id, ingest_job_id, message, change_set_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        document.id,
        no,
        input.markdown,
        sha256,
        text,
        principal.id,
        principal.displayName,
        principal.kind,
        principal.channel,
        principal.onBehalfOf?.id ?? null,
        input.proposalId ?? null,
        input.ingestJobId ?? null,
        input.message ?? "",
        input.changeSetId ?? null
      ]
    );
    const { rows: updated } = await tx.query(
      `UPDATE pandocs.documents SET current_revision_no = $2, has_content = $3, outline = $4, visible_chars = $5, sha256 = $6, size_bytes = $7, asset_refs = $8, updated_at = now() WHERE id = $1 RETURNING *`,
      [
        document.id,
        no,
        text.trim() !== "",
        JSON.stringify(analysis.outline),
        text.length,
        sha256,
        Buffer.byteLength(input.markdown, "utf8"),
        assetHashesIn(input.markdown)
      ]
    );
    await tx.query(
      `INSERT INTO pandocs.document_search (document_id, vector) VALUES ($1, array_to_tsvector($2::text[]))
       ON CONFLICT (document_id) DO UPDATE SET vector = EXCLUDED.vector`,
      [document.id, analysis.searchTokens ?? []]
    );
    await relocateOpenThreads(tx, document.id, no, input.markdown, analysis);
    await audit(tx, principal, "document.commit", "document", document.id, { revision: no, sha256 });
    await tellFollowers(tx, principal, document, input.message ?? "");
    // A repository kept the same as this space hears about it soon, and a run of saves is still one commit there.
    if (principal.channel !== "git")
      await tx.query(
        `UPDATE pandocs.git_syncs SET due_at = now() + interval '5 seconds' WHERE space_id = $1 AND enabled AND due_at > now() + interval '5 seconds'`,
        [document.spaceId]
      );
    return {
      document: mapDocument(updated[0]!),
      revision: metaOf(mapRevision(rows[0]!)),
      changed: true,
      merged: false,
      diagnostics: analysis.diagnostics
    };
  }

  /** Newest first. `before` is a version number, to page back through a long history from the oldest one shown. */
  async revisions(
    principal: Principal,
    documentId: string,
    limit = 50,
    before?: number | undefined
  ): Promise<RevisionMeta[]> {
    const { db } = this.context;
    await requireDocument(db, principal, documentId);
    const { rows } = await db.query(
      `SELECT document_id, no, '' AS markdown, sha256, '' AS visible_text, actor_id, actor_name, actor_kind, channel, on_behalf_of, proposal_id, ingest_job_id, change_set_id, message, created_at
       FROM pandocs.revisions WHERE document_id = $1 AND ($3::int IS NULL OR no < $3) ORDER BY no DESC LIMIT $2`,
      [documentId, Math.min(Math.max(limit, 1), 200), before ?? null]
    );
    return rows.map(row => metaOf(mapRevision(row)));
  }

  async revisionContent(principal: Principal, documentId: string, no: number): Promise<RevisionRecord> {
    await requireDocument(this.context.db, principal, documentId);
    return loadRevision(this.context.db, documentId, no);
  }

  async diff(principal: Principal, documentId: string, from: number, to: number) {
    const { db } = this.context;
    await requireDocument(db, principal, documentId);
    const [before, after] = await Promise.all([loadRevision(db, documentId, from), loadRevision(db, documentId, to)]);
    return {
      from,
      to,
      before: before.markdown,
      after: after.markdown,
      patch: createTwoFilesPatch(`revision-${from}.md`, `revision-${to}.md`, before.markdown, after.markdown, "", "", {
        context: 2
      })
    };
  }

  async updateMeta(
    principal: Principal,
    documentId: string,
    patch: { title?: string | undefined; sortOrder?: number | undefined; restricted?: boolean | undefined }
  ): Promise<DocumentRecord> {
    return this.context.db.transaction(async tx => {
      const { document, role, space } = await requireDocument(tx, principal, documentId, "editor", true);
      // What a page is called and where it sits among its siblings are what readers see of it, so they go through review
      // where its text does. Who can see it is for its administrators either way.
      if (
        (patch.title !== undefined && patch.title !== document.title) ||
        (patch.sortOrder !== undefined && patch.sortOrder !== document.sortOrder)
      )
        assertDirectWrites(space);
      if (patch.restricted !== undefined && patch.restricted !== document.restricted && !atLeast(role, "admin")) {
        throw forbidden(t("Only space administrators can change who can see a page"));
      }
      const { rows } = await tx.query(
        `UPDATE pandocs.documents SET title = $2, sort_order = $3, restricted = $4, updated_at = now() WHERE id = $1 RETURNING *`,
        [
          documentId,
          patch.title ?? document.title,
          patch.sortOrder ?? document.sortOrder,
          patch.restricted ?? document.restricted
        ]
      );
      await audit(tx, principal, "document.update", "document", documentId, patch);
      return mapDocument(rows[0]!);
    });
  }

  async documentMembers(principal: Principal, documentId: string): Promise<readonly NamedMember[]> {
    await requireDocument(this.context.db, principal, documentId, "admin");
    return nameMembers(this.context, await documentMembers(this.context.db, documentId));
  }

  async setDocumentMember(
    principal: Principal,
    documentId: string,
    subject: string,
    role: Role | null
  ): Promise<readonly NamedMember[]> {
    const { db } = this.context;
    await db.transaction(async tx => {
      await requireDocument(tx, principal, documentId, "admin", true);
      if (role === null)
        await tx.query(`DELETE FROM pandocs.document_members WHERE document_id = $1 AND subject = $2`, [
          documentId,
          subject
        ]);
      else {
        await tx.query(
          `INSERT INTO pandocs.document_members (document_id, subject, role) VALUES ($1, $2, $3)
           ON CONFLICT (document_id, subject) DO UPDATE SET role = EXCLUDED.role`,
          [documentId, subject, role]
        );
      }
      await audit(tx, principal, "document.member.set", "document", documentId, { subject, role });
    });
    return nameMembers(this.context, await documentMembers(db, documentId));
  }

  /** A suggestion on the page takes commenter rights; a translation is written directly, so its draft takes edit rights. */
  private draftRole(lang: string): Role {
    return lang ? "editor" : "commenter";
  }

  async draft(
    principal: Principal,
    documentId: string,
    lang = ""
  ): Promise<{ markdown: string; title: string | null; baseRevision: number; updatedAt: Date } | null> {
    const { db } = this.context;
    await requireDocument(db, principal, documentId, this.draftRole(lang));
    const { rows } = await db.query<{
      markdown: string;
      title: string | null;
      base_revision_no: number;
      updated_at: string;
    }>(
      `SELECT markdown, title, base_revision_no, updated_at FROM pandocs.drafts WHERE document_id = $1 AND user_id = $2 AND lang = $3`,
      [documentId, principal.id, lang]
    );
    return rows[0]
      ? {
          markdown: rows[0].markdown,
          title: rows[0].title,
          baseRevision: Number(rows[0].base_revision_no),
          updatedAt: new Date(rows[0].updated_at)
        }
      : null;
  }

  async saveDraft(
    principal: Principal,
    documentId: string,
    input: { markdown: string; baseRevision: number; title?: string | undefined },
    lang = ""
  ): Promise<{ updatedAt: Date }> {
    const { db } = this.context;
    await requireDocument(db, principal, documentId, this.draftRole(lang));
    if (Buffer.byteLength(input.markdown, "utf8") > MAX_MARKDOWN_BYTES)
      throw invalid("DOCUMENT_TOO_LARGE", t("The document is larger than 2 MiB"));
    const { rows } = await db.query<{ updated_at: string }>(
      `INSERT INTO pandocs.drafts (document_id, user_id, lang, title, markdown, base_revision_no) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (document_id, user_id, lang) DO UPDATE SET title = EXCLUDED.title, markdown = EXCLUDED.markdown, base_revision_no = EXCLUDED.base_revision_no, updated_at = now()
       RETURNING updated_at`,
      [documentId, principal.id, lang, input.title ?? null, input.markdown, input.baseRevision]
    );
    return { updatedAt: new Date(rows[0]!.updated_at) };
  }

  async deleteDraft(principal: Principal, documentId: string, lang = ""): Promise<void> {
    const { db } = this.context;
    await requireDocument(db, principal, documentId, this.draftRole(lang));
    await db.query(`DELETE FROM pandocs.drafts WHERE document_id = $1 AND user_id = $2 AND lang = $3`, [
      documentId,
      principal.id,
      lang
    ]);
  }

  /** What this person left unfinished, on pages they can still work on. */
  async myDrafts(principal: Principal): Promise<MyDraft[]> {
    const { db } = this.context;
    const { rows } = await db.query<{
      document_id: string;
      lang: string;
      draft_title: string | null;
      title: string;
      path: string;
      space_slug: string;
      space_name: string;
      updated_at: string;
    }>(
      `SELECT dr.document_id, dr.lang, dr.title AS draft_title, dr.updated_at, d.title, d.path, s.slug AS space_slug, s.name AS space_name
       FROM pandocs.drafts dr
       JOIN pandocs.documents d ON d.id = dr.document_id AND d.deleted_at IS NULL
       JOIN pandocs.spaces s ON s.id = d.space_id AND s.deleted_at IS NULL
       WHERE dr.user_id = $1 ORDER BY dr.updated_at DESC LIMIT 100`,
      [principal.id]
    );
    const drafts: MyDraft[] = [];
    for (const row of rows) {
      const allowed = await requireDocument(db, principal, row.document_id, this.draftRole(row.lang)).then(
        () => true,
        () => false
      );
      if (allowed)
        drafts.push({
          documentId: row.document_id,
          lang: row.lang,
          title: row.draft_title ?? row.title,
          path: row.path,
          spaceSlug: row.space_slug,
          spaceName: row.space_name,
          updatedAt: new Date(row.updated_at)
        });
    }
    return drafts;
  }

  /** A soft lock: it warns the next editor and blocks nothing, because saves are protected by CAS. */
  async setEditing(
    principal: Principal,
    documentId: string,
    editing: boolean
  ): Promise<{ name: string; until: Date } | null> {
    const { db } = this.context;
    const { document } = await requireDocument(db, principal, documentId, "editor");
    const someoneElse =
      document.editingBy &&
      document.editingBy !== principal.id &&
      document.editingUntil &&
      document.editingUntil > new Date();
    if (someoneElse) return { name: document.editingName ?? "", until: document.editingUntil! };
    if (editing) {
      await db.query(
        `UPDATE pandocs.documents SET editing_by = $2, editing_name = $3, editing_until = now() + make_interval(secs => $4) WHERE id = $1`,
        [documentId, principal.id, principal.displayName, EDITING_TTL_SECONDS]
      );
    } else {
      await db.query(
        `UPDATE pandocs.documents SET editing_by = NULL, editing_name = NULL, editing_until = NULL WHERE id = $1 AND editing_by = $2`,
        [documentId, principal.id]
      );
    }
    return null;
  }

  /** How much text a set of spaces holds, which decides whether its full text can go to the browser at all. */
  async fullTextOnServer(spaceIds: readonly string[]): Promise<boolean> {
    const { rows } = await this.context.db.query<{ total: string | null }>(
      `SELECT sum(visible_chars) AS total FROM pandocs.documents WHERE space_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [spaceIds]
    );
    return Number(rows[0]?.total ?? 0) > BROWSER_INDEX_MAX_CHARS;
  }

  /** Everything the person can read, in the shape the theme's search panel indexes in the browser. A large site sends titles and headings only. */
  async searchIndex(
    translations: Pick<TranslationService, "forIndex">,
    lang: string,
    routePrefix: string,
    spaces: readonly { readonly id: string; readonly slug: string; readonly tree: readonly TreeNode[] }[]
  ): Promise<SearchIndexEntry[]> {
    const { db, registry } = this.context;
    const titlesOnly = await this.fullTextOnServer(spaces.map(space => space.id));
    const entries: SearchIndexEntry[] = [];
    for (const { slug, tree } of spaces) {
      if (tree.length === 0) continue;
      const ids = tree.map(node => node.id);
      const { rows } = await db.query<{ id: string; outline: readonly OutlineEntry[]; visible_text: string | null }>(
        titlesOnly
          ? `SELECT id, outline, NULL AS visible_text FROM pandocs.documents WHERE id = ANY($1::uuid[])`
          : `SELECT d.id, d.outline, r.visible_text FROM pandocs.documents d
             JOIN pandocs.revisions r ON r.document_id = d.id AND r.no = d.current_revision_no WHERE d.id = ANY($1::uuid[])`,
        [ids]
      );
      const byDocument = new Map(rows.map(row => [row.id, row]));
      const translated = titlesOnly
        ? new Map<string, { title: string; markdown: string; visibleText: string }>()
        : await translations.forIndex(ids, lang);
      for (const node of tree) {
        const page = byDocument.get(node.id);
        if (!page) continue;
        const translation = translated.get(node.id);
        const text = translation?.visibleText ?? page.visible_text ?? "";
        // A translation can change without a new revision, and parsing is cheap enough for the few there are.
        const outline = translation ? outlineOf(parseDocument(translation.markdown, registry)) : page.outline;
        let searchFrom = 0;
        const toc = outline.map(entry => {
          const at = text.indexOf(entry.text, searchFrom);
          if (at >= 0) searchFrom = at + entry.text.length;
          return { id: entry.slug, text: entry.text, depth: entry.depth, charIndex: Math.max(at, 0) };
        });
        const file = `${slug}/${node.path}.md`;
        entries.push({
          id: entries.length,
          title: translation?.title ?? node.titles[lang] ?? node.title,
          // As the app writes addresses: a percent sign or a hash would be read as something else.
          routePath: `${routePrefix}/${slug}/${node.path === HOME_DOCUMENT_PATH ? "" : node.path.replace(/[%#?]/gu, encodeURIComponent)}`,
          toc,
          content: text,
          frontmatter: {},
          lang,
          version: "",
          _filepath: file,
          _relativePath: file
        });
      }
    }
    return entries;
  }

  /**
   * Titles first, then full text through the index. Access rules are part of the query, so a large site never filters
   * its way down to nothing. In another language, a page with a translation into it is searched, and found, as its
   * translation, which is what the site shows there; one without is searched as written.
   */
  async search(
    principal: Principal,
    input: {
      query: string;
      space?: string | undefined;
      label?: string | undefined;
      limit?: number | undefined;
      lang?: string | undefined;
    }
  ) {
    const { db } = this.context;
    const query = input.query.trim();
    const label = input.label?.trim() || null;
    if (!query && !label) return [];
    const limit = Math.min(input.limit ?? 30, 100);
    const { rows: spaces } = await db.query<{
      id: string;
      slug: string;
      name: string;
      default_role: SpaceDefaultRole;
      public_read: boolean;
      members: MemberRecord[] | null;
    }>(
      `SELECT s.id, s.slug, s.name, s.default_role, s.public_read,
         (SELECT jsonb_agg(jsonb_build_object('subject', m.subject, 'role', m.role)) FROM pandocs.space_members m WHERE m.space_id = s.id) AS members
       FROM pandocs.spaces s WHERE s.deleted_at IS NULL AND ($1::text IS NULL OR s.slug = $1)`,
      [input.space ?? null]
    );
    const readable: typeof spaces = [];
    const allRestricted: string[] = [];
    for (const space of spaces) {
      const context = {
        defaultRole: space.default_role,
        publicRead: space.public_read,
        spaceMembers: space.members ?? []
      };
      if (!atLeast(effectiveRole(principal, context), "viewer")) continue;
      readable.push(space);
      if (atLeast(spaceRoleOf(principal, context), "admin")) allRestricted.push(space.id);
    }
    if (readable.length === 0) return [];
    const spaceOf = new Map(readable.map(space => [space.id, space]));
    const access = [readable.map(space => space.id), allRestricted, [...subjectsOf(principal)], label];
    const readableRow = `($4::text IS NULL OR EXISTS (SELECT 1 FROM pandocs.document_labels l WHERE l.document_id = d.id AND lower(l.label) = lower($4)))
      AND d.deleted_at IS NULL AND d.space_id = ANY($1::uuid[])
      AND (NOT d.restricted OR d.space_id = ANY($2::uuid[]) OR EXISTS (SELECT 1 FROM pandocs.document_members m WHERE m.document_id = d.id AND m.subject = ANY($3::text[])))`;
    const pattern = `%${query.replace(/[\\%_]/gu, match => `\\${match}`)}%`;
    const lang = input.lang ?? null;
    const { rows: titled } = await db.query(
      `SELECT d.*, t.title AS translated_title FROM pandocs.documents d LEFT JOIN pandocs.document_translations t ON t.document_id = d.id AND t.lang = $7
       WHERE ${readableRow} AND COALESCE(t.title, d.title) ILIKE $5 ORDER BY d.updated_at DESC LIMIT $6`,
      [...access, pattern, limit, lang]
    );
    const terms = searchQuery(query);
    const { rows: matched } = terms
      ? await db.query(
          `SELECT d.* FROM pandocs.document_search s JOIN pandocs.documents d ON d.id = s.document_id
         WHERE ${readableRow} AND s.vector @@ $5::tsquery AND NOT EXISTS (SELECT 1 FROM pandocs.document_translations t WHERE t.document_id = d.id AND t.lang = $7)
         ORDER BY d.updated_at DESC LIMIT $6`,
          [...access, terms, SEARCH_CANDIDATES, lang]
        )
      : { rows: [] };
    // Translations have no index of their own, and are far fewer than pages.
    const { rows: translated } =
      lang && query
        ? await db.query(
            `SELECT d.*, t.title AS translated_title FROM pandocs.document_translations t JOIN pandocs.documents d ON d.id = t.document_id
         WHERE ${readableRow} AND t.lang = $7 AND t.visible_text ILIKE $5 ORDER BY d.updated_at DESC LIMIT $6`,
            [...access, pattern, SEARCH_CANDIDATES, lang]
          )
        : { rows: [] };
    const seen = new Set<string>();
    const candidates = [...titled, ...matched, ...translated].filter(
      row => !seen.has(String(row.id)) && seen.add(String(row.id))
    );
    if (candidates.length === 0) return [];
    const { rows: texts } = await db.query<{ document_id: string; visible_text: string }>(
      `SELECT d.id AS document_id, COALESCE(t.visible_text, r.visible_text) AS visible_text
       FROM pandocs.documents d JOIN pandocs.revisions r ON r.document_id = d.id AND r.no = d.current_revision_no
       LEFT JOIN pandocs.document_translations t ON t.document_id = d.id AND t.lang = $2
       WHERE d.id = ANY($1::uuid[])`,
      [candidates.map(row => row.id), lang]
    );
    const textOf = new Map(texts.map(row => [row.document_id, row.visible_text]));
    const needle = query.toLowerCase();
    const titledIds = new Set(titled.map(row => String(row.id)));
    const results = [];
    for (const row of candidates) {
      const document = mapDocument(row);
      const text = textOf.get(document.id) ?? "";
      // Tokens can all be there without being next to each other; what someone typed should actually appear. A last word still being typed stays a prefix.
      if (!titledIds.has(document.id) && !text.replace(/\s+/gu, " ").toLowerCase().includes(needle)) continue;
      const space = spaceOf.get(document.spaceId)!;
      results.push({
        id: document.id,
        spaceSlug: space.slug,
        spaceName: space.name,
        path: document.path,
        title: row.translated_title ? String(row.translated_title) : document.title,
        snippet: snippetOf(text, query),
        updatedAt: document.updatedAt
      });
      if (results.length >= limit) break;
    }
    return results;
  }
}

export function applyOpsOrThrow(
  markdown: string,
  ops: readonly EditOp[],
  context: Pick<AppContext, "registry">
): string {
  try {
    return applyEditOps(markdown, ops, context.registry);
  } catch (error) {
    if (error instanceof EditOpError) throw invalid(error.code, error.message, { opIndex: error.opIndex });
    throw error;
  }
}

function snippetOf(text: string, query: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 40);
  return `${start > 0 ? "…" : ""}${flat.slice(start, at + query.length + 80)}${at + query.length + 80 < flat.length ? "…" : ""}`;
}
