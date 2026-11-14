import { t } from "@pandocs/i18n";
import { mergeThreeWay } from "@pandocs/markdown";
import { z } from "zod";
import { atLeast } from "../domain/access.js";
import { PandocsError, forbidden, invalid, notFound } from "../domain/errors.js";
import type { DocumentRecord, Principal, SpaceRecord } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import { audit, mapDocument, requireDocument, requireSpace, UUID, type AppContext } from "./context.js";
import { MAX_MARKDOWN_BYTES, reservedForFrontPage, validSlug, type DocumentService } from "./documents.js";
import { loadRevision } from "./revisions.js";
import { roleOn, type TreeService } from "./tree.js";

const MAX_PAGES = 200;
const LISTED = 100;

export const changeSetInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).optional()
  })
  .strict();

export const changeSetPageInput = z.union([
  z
    .object({
      document: z.string().min(1),
      baseRevision: z.number().int().positive(),
      markdown: z.string(),
      title: z.string().trim().min(1).max(200).optional()
    })
    .strict(),
  z
    .object({ document: z.string().min(1), baseRevision: z.number().int().positive(), delete: z.literal(true) })
    .strict(),
  z
    .object({ path: z.string().min(1).max(1000), title: z.string().trim().min(1).max(200), markdown: z.string() })
    .strict(),
  z.object({ document: z.string().min(1), restore: z.literal(true) }).strict()
]);

export const reviewInput = z
  .object({
    verdict: z.enum(["approved", "changes_requested"]),
    note: z.string().trim().max(2000).optional()
  })
  .strict();

type PageKind = "edit" | "create" | "delete" | "restore";

interface PageRow {
  readonly id: string;
  readonly kind: PageKind;
  readonly document_id: string | null;
  readonly path: string;
  readonly title: string | null;
  readonly base_revision_no: number | null;
  readonly markdown: string | null;
}

interface Blocker {
  readonly code: string;
  readonly message: string;
  /** The page it is about, where it is about one. */
  readonly path?: string;
}

const iso = (value: unknown) => new Date(value as string).toISOString();

function mapChangeSet(row: Record<string, unknown>, slug: string) {
  return {
    id: String(row.id),
    spaceSlug: slug,
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as "open" | "merged" | "closed",
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    authorKind: String(row.author_kind),
    decidedName: row.decided_name ? String(row.decided_name) : null,
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

const mergeRulesOf = (space: SpaceRecord) => space.mergeRules;

const depth = (path: string) => path.split("/").length;
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

/**
 * Changes to several pages, read and decided together, that land together or not at all. Anyone who can comment can make
 * one, which is what an agent working across pages needs. Only people can approve one, and only someone who can edit every
 * page in it can merge it.
 */
export class ChangeSetService {
  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService,
    private readonly tree: TreeService
  ) {}

  async create(principal: Principal, spaceSlug: string, input: z.output<typeof changeSetInput>) {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug, "commenter");
    return db.transaction(async tx => {
      const { rows } = await tx.query(
        `INSERT INTO pandocs.change_sets (space_id, title, description, author_id, author_name, author_kind, on_behalf_of, channel) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          space.id,
          input.title,
          input.description ?? "",
          principal.id,
          principal.displayName,
          principal.kind,
          principal.onBehalfOf?.id ?? null,
          principal.channel
        ]
      );
      const id = String(rows[0]!.id);
      await audit(tx, principal, "space.change_set.create", "space", space.id, { changeSet: id, title: input.title });
      return mapChangeSet(rows[0]!, space.slug);
    });
  }

  async list(principal: Principal, spaceSlug: string, status?: string | undefined) {
    const { db } = this.context;
    // What is proposed is not published yet, so it is for those who take part, as it is in the app.
    const { space } = await requireSpace(db, principal, spaceSlug, "commenter");
    const { rows } = await db.query(
      `SELECT c.*, (SELECT count(*)::int FROM pandocs.change_set_pages p WHERE p.change_set_id = c.id) AS pages,
         (SELECT count(*)::int FROM pandocs.change_set_reviews r WHERE r.change_set_id = c.id AND r.verdict = 'approved' AND NOT r.stale) AS approvals
       FROM pandocs.change_sets c WHERE c.space_id = $1 AND ($2::text IS NULL OR c.status = $2) ORDER BY c.updated_at DESC LIMIT $3`,
      [space.id, status ?? null, LISTED]
    );
    return rows.map(row => ({
      ...mapChangeSet(row, space.slug),
      pages: Number(row.pages),
      approvals: Number(row.approvals)
    }));
  }

  private async load(db: Queryable, principal: Principal, id: string, lock = false) {
    if (!UUID.test(id)) throw notFound(t("Change set"));
    const { rows } = await db.query(`SELECT * FROM pandocs.change_sets WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [
      id
    ]);
    if (!rows[0]) throw notFound(t("Change set"));
    const { rows: spaces } = await db.query<{ slug: string }>(
      `SELECT slug FROM pandocs.spaces WHERE id = $1 AND deleted_at IS NULL`,
      [rows[0].space_id]
    );
    if (!spaces[0]) throw notFound(t("Change set"));
    const access = await requireSpace(db, principal, spaces[0].slug, "commenter").catch((error: unknown) => {
      throw error instanceof PandocsError ? notFound(t("Change set")) : error;
    });
    return { row: rows[0], ...access };
  }

  private ownsOrEdits(principal: Principal, row: Record<string, unknown>, role: Parameters<typeof atLeast>[0]) {
    return (
      atLeast(role, "editor") ||
      row.author_id === principal.id ||
      (row.on_behalf_of !== null && row.on_behalf_of === principal.id) ||
      (principal.onBehalfOf !== undefined && row.on_behalf_of === principal.onBehalfOf.id)
    );
  }

  /** Taking one back is for whoever made it, or the person an agent made it for, and for those who run the space: not for agents. */
  private mayDelete(principal: Principal, row: Record<string, unknown>, role: Parameters<typeof atLeast>[0]) {
    if (principal.kind !== "user" || principal.guest) return false;
    return atLeast(role, "admin") || row.author_id === principal.id || row.on_behalf_of === principal.id;
  }

  private assertOpen(row: Record<string, unknown>): void {
    if (row.status !== "open")
      throw new PandocsError(409, "CHANGE_SET_NOT_OPEN", t("This change set is no longer open"));
  }

  /** What makes a page worth reviewing is what it would say, and anything said about it before that no longer counts. */
  private async touched(tx: Queryable, id: string): Promise<void> {
    await tx.query(`UPDATE pandocs.change_set_reviews SET stale = true WHERE change_set_id = $1`, [id]);
    await tx.query(`UPDATE pandocs.change_sets SET updated_at = now() WHERE id = $1`, [id]);
  }

  async update(
    principal: Principal,
    id: string,
    patch: { title?: string | undefined; description?: string | undefined }
  ) {
    const { db } = this.context;
    return db.transaction(async tx => {
      const { row, role, space } = await this.load(tx, principal, id, true);
      if (!this.ownsOrEdits(principal, row, role)) throw forbidden();
      this.assertOpen(row);
      const { rows } = await tx.query(
        `UPDATE pandocs.change_sets SET title = COALESCE($2, title), description = COALESCE($3, description), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, patch.title ?? null, patch.description ?? null]
      );
      return mapChangeSet(rows[0]!, space.slug);
    });
  }

  private async documentRef(principal: Principal, space: SpaceRecord, reference: string): Promise<string> {
    if (UUID.test(reference)) return reference;
    return this.documents.resolvePath(principal, space.slug, reference);
  }

  /** A page in this space's trash that this person may comment on, by its id or by the address it had. */
  private async trashedPage(
    db: Queryable,
    principal: Principal,
    space: SpaceRecord,
    reference: string
  ): Promise<DocumentRecord> {
    const { rows } = UUID.test(reference)
      ? await db.query(`SELECT * FROM pandocs.documents WHERE id = $1 AND space_id = $2`, [reference, space.id])
      : await db.query(
          `SELECT * FROM pandocs.documents WHERE space_id = $1 AND path = $2 ORDER BY deleted_at IS NULL DESC, deleted_at DESC LIMIT 1`,
          [space.id, reference]
        );
    if (!rows[0]) throw notFound(t("Document"));
    const document = mapDocument(rows[0]);
    const role = await roleOn(db, principal, space, document);
    if (!atLeast(role, "viewer")) throw notFound(t("Document"));
    if (!atLeast(role, "commenter")) throw forbidden();
    if (rows[0].deleted_at === null)
      throw invalid("CHANGE_SET_NOT_IN_TRASH", t("{0} is not in the trash", document.path));
    return document;
  }

  /**
   * Whether this person may see what a change set says about a page, wherever that page is now. One in the trash is
   * read as it was; one gone for good can no longer say whether it was theirs to read, so only those who read everything do.
   */
  private async readsPage(
    db: Queryable,
    principal: Principal,
    space: SpaceRecord,
    page: PageRow,
    readsEverything: boolean
  ): Promise<boolean> {
    if (readsEverything || (page.kind === "create" && !page.document_id)) return true;
    if (!page.document_id) return false;
    const { rows } = await db.query(`SELECT * FROM pandocs.documents WHERE id = $1`, [page.document_id]);
    if (!rows[0]) return false;
    return atLeast(await roleOn(db, principal, space, mapDocument(rows[0])), "viewer");
  }

  /** Saying something about a page again replaces what was said about it. */
  async putPage(principal: Principal, id: string, input: z.output<typeof changeSetPageInput>) {
    const { db } = this.context;
    if ("markdown" in input && Buffer.byteLength(input.markdown, "utf8") > MAX_MARKDOWN_BYTES)
      throw invalid("DOCUMENT_TOO_LARGE", t("The document is larger than 2 MiB"));
    return db.transaction(async tx => {
      const { row, role, space } = await this.load(tx, principal, id, true);
      if (!this.ownsOrEdits(principal, row, role)) throw forbidden();
      if (!atLeast(role, "commenter")) throw forbidden();
      this.assertOpen(row);
      let page: Omit<PageRow, "id">;
      if ("path" in input) {
        const path = input.path.replace(/^\/+|\/+$/gu, "");
        const segments = path.split("/");
        if (
          !segments.every(validSlug) ||
          reservedForFrontPage(segments.at(-1)!, segments.slice(0, -1).join("/") || undefined)
        )
          throw invalid("SLUG_INVALID", t("The path {0} cannot be a page's address", path));
        const { rows: taken } = await tx.query(
          `SELECT 1 FROM pandocs.documents WHERE space_id = $1 AND lower(path) = lower($2) AND deleted_at IS NULL`,
          [space.id, path]
        );
        if (taken[0]) throw new PandocsError(409, "DOCUMENT_PATH_TAKEN", t("The path {0} is taken", path));
        page = {
          kind: "create",
          document_id: null,
          path,
          title: input.title,
          base_revision_no: null,
          markdown: input.markdown
        };
      } else if ("restore" in input) {
        const document = await this.trashedPage(tx, principal, space, input.document);
        page = {
          kind: "restore",
          document_id: document.id,
          path: document.path,
          title: document.title,
          base_revision_no: document.currentRevisionNo,
          markdown: null
        };
      } else {
        const documentId = await this.documentRef(principal, space, input.document);
        const { document } = await requireDocument(tx, principal, documentId, "commenter");
        if (document.spaceId !== space.id)
          throw invalid("CHANGE_SET_OTHER_SPACE", t("A change set stays within one space"));
        if (input.baseRevision > document.currentRevisionNo)
          throw invalid("REVISION_INVALID", t("The base version does not exist"));
        page =
          "delete" in input
            ? {
                kind: "delete",
                document_id: document.id,
                path: document.path,
                title: document.title,
                base_revision_no: input.baseRevision,
                markdown: null
              }
            : {
                kind: "edit",
                document_id: document.id,
                path: document.path,
                title: input.title ?? null,
                base_revision_no: input.baseRevision,
                markdown: input.markdown
              };
      }
      const { rows: existing } = await tx.query<{ id: string }>(
        `SELECT id FROM pandocs.change_set_pages WHERE change_set_id = $1 AND (document_id = $2 OR lower(path) = lower($3))`,
        [id, page.document_id, page.path]
      );
      for (const item of existing) await tx.query(`DELETE FROM pandocs.change_set_pages WHERE id = $1`, [item.id]);
      const { rows: counted } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pandocs.change_set_pages WHERE change_set_id = $1`,
        [id]
      );
      if (Number(counted[0]!.count) >= MAX_PAGES)
        throw invalid("CHANGE_SET_TOO_LARGE", t("A change set can hold at most {0} pages", MAX_PAGES));
      const { rows } = await tx.query(
        `INSERT INTO pandocs.change_set_pages (change_set_id, kind, document_id, path, title, base_revision_no, markdown) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [id, page.kind, page.document_id, page.path, page.title, page.base_revision_no, page.markdown]
      );
      await this.touched(tx, id);
      return { id: String(rows[0]!.id), kind: page.kind, path: page.path };
    });
  }

  async removePage(principal: Principal, id: string, pageId: string): Promise<void> {
    if (!UUID.test(pageId)) throw notFound(t("Page"));
    await this.context.db.transaction(async tx => {
      const { row, role } = await this.load(tx, principal, id, true);
      if (!this.ownsOrEdits(principal, row, role)) throw forbidden();
      this.assertOpen(row);
      const { rows } = await tx.query(
        `DELETE FROM pandocs.change_set_pages WHERE id = $1 AND change_set_id = $2 RETURNING id`,
        [pageId, id]
      );
      if (!rows[0]) throw notFound(t("Page"));
      await this.touched(tx, id);
    });
  }

  private async pagesOf(db: Queryable, id: string): Promise<PageRow[]> {
    const { rows } = await db.query<PageRow>(
      `SELECT id, kind, document_id, path, title, base_revision_no, markdown FROM pandocs.change_set_pages WHERE change_set_id = $1 ORDER BY path`,
      [id]
    );
    return rows;
  }

  /** Whether a page can land on what is there now, and if so as what. Nothing here writes. */
  private async planPage(
    db: Queryable,
    page: PageRow,
    pages: readonly PageRow[],
    space: SpaceRecord
  ): Promise<{ markdown: string | null; document: DocumentRecord | null; problem: Blocker | null }> {
    const problem = (code: string, message: string) => ({
      markdown: null,
      document: null,
      problem: { code, message, path: page.path }
    });
    if (page.kind === "restore") {
      const { rows } = page.document_id
        ? await db.query(`SELECT * FROM pandocs.documents WHERE id = $1`, [page.document_id])
        : { rows: [] };
      if (!rows[0]) return problem("CHANGE_SET_PAGE_GONE", t("This page no longer exists"));
      if (rows[0].deleted_at === null)
        return problem("CHANGE_SET_NOT_IN_TRASH", t("This page is no longer in the trash"));
      return { markdown: null, document: mapDocument(rows[0]), problem: null };
    }
    if (page.kind === "create") {
      const { rows } = await db.query(
        `SELECT 1 FROM pandocs.documents WHERE space_id = $1 AND lower(path) = lower($2) AND deleted_at IS NULL`,
        [space.id, page.path]
      );
      if (rows[0]) return problem("DOCUMENT_PATH_TAKEN", t("The path {0} is taken", page.path));
      const parent = parentOf(page.path);
      if (parent && !pages.some(item => item.kind === "create" && item.path.toLowerCase() === parent.toLowerCase())) {
        const { rows: above } = await db.query(
          `SELECT 1 FROM pandocs.documents WHERE space_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [space.id, parent]
        );
        if (!above[0]) return problem("CHANGE_SET_NO_PARENT", t("The page above {0} does not exist", page.path));
      }
      return { markdown: page.markdown ?? "", document: null, problem: null };
    }
    if (!page.document_id) return problem("CHANGE_SET_PAGE_GONE", t("This page no longer exists"));
    const { rows } = await db.query(`SELECT * FROM pandocs.documents WHERE id = $1 AND deleted_at IS NULL`, [
      page.document_id
    ]);
    if (!rows[0]) return problem("CHANGE_SET_PAGE_GONE", t("This page no longer exists"));
    const document = mapDocument(rows[0]);
    const moved = document.currentRevisionNo !== page.base_revision_no;
    if (page.kind === "delete") {
      if (moved)
        return problem("CHANGE_SET_CONFLICT", t("This page has changed since, so deleting it needs another look"));
      return { markdown: null, document, problem: null };
    }
    if (!moved) return { markdown: page.markdown ?? "", document, problem: null };
    const [base, current] = await Promise.all([
      loadRevision(db, document.id, page.base_revision_no!),
      loadRevision(db, document.id, document.currentRevisionNo)
    ]);
    const merged = mergeThreeWay(base.markdown, page.markdown ?? "", current.markdown, this.context.registry);
    if (!merged.ok) return problem("CHANGE_SET_CONFLICT", t("This page has changed in the same place"));
    return { markdown: merged.markdown, document, problem: null };
  }

  private async blockers(
    db: Queryable,
    row: Record<string, unknown>,
    space: SpaceRecord,
    pages: readonly PageRow[]
  ): Promise<Blocker[]> {
    const blockers: Blocker[] = [];
    if (pages.length === 0)
      blockers.push({ code: "CHANGE_SET_EMPTY", message: t("This change set has no pages in it") });
    const { rows: reviews } = await db.query<{ verdict: string }>(
      `SELECT verdict FROM pandocs.change_set_reviews WHERE change_set_id = $1 AND NOT stale`,
      [row.id]
    );
    const { requiredApprovals } = mergeRulesOf(space);
    const approvals = reviews.filter(review => review.verdict === "approved").length;
    if (approvals < requiredApprovals)
      blockers.push({
        code: "APPROVALS_NEEDED",
        message: t("It needs {0} {0|approval|approvals}, and has {1}", requiredApprovals, approvals)
      });
    if (reviews.some(review => review.verdict === "changes_requested"))
      blockers.push({ code: "CHANGES_REQUESTED", message: t("Someone has asked for changes") });
    for (const page of pages) {
      const { problem } = await this.planPage(db, page, pages, space);
      if (problem) blockers.push(problem);
    }
    return blockers;
  }

  /** Pages this person cannot read are left out, with a count: they should know there is more, but not what. */
  async get(principal: Principal, id: string) {
    const { db } = this.context;
    const { row, space, role } = await this.load(db, principal, id);
    const pages = await this.pagesOf(db, id);
    const shown = [];
    let hidden = 0;
    const readsEverything = atLeast(role, "admin");
    for (const page of pages) {
      if (!(await this.readsPage(db, principal, space, page, readsEverything))) {
        hidden += 1;
        continue;
      }
      const { rows: current } = page.document_id
        ? await db.query<{ current_revision_no: number; title: string; deleted_at: string | null }>(
            `SELECT current_revision_no, title, deleted_at FROM pandocs.documents WHERE id = $1`,
            [page.document_id]
          )
        : { rows: [] };
      const base =
        page.document_id && page.base_revision_no
          ? await loadRevision(db, page.document_id, page.base_revision_no).catch(() => null)
          : null;
      // Coming back from the trash, the page reads as it did when it went.
      const restoring = page.kind === "restore";
      shown.push({
        id: page.id,
        kind: page.kind,
        documentId: page.document_id,
        path: page.path,
        title: page.title ?? current[0]?.title ?? page.path,
        baseRevisionNo: page.base_revision_no,
        currentRevisionNo: current[0] ? Number(current[0].current_revision_no) : null,
        baseMarkdown: restoring ? "" : (base?.markdown ?? ""),
        proposedMarkdown: restoring ? (base?.markdown ?? "") : (page.markdown ?? "")
      });
    }
    const { rows: reviews } = await db.query(
      `SELECT reviewer_name, verdict, note, stale, created_at FROM pandocs.change_set_reviews WHERE change_set_id = $1 ORDER BY created_at`,
      [id]
    );
    const open = row.status === "open";
    // What stands in the way on a page someone cannot read is not theirs to know about, though the count says there is one.
    const visiblePaths = new Set(shown.map(page => page.path));
    const blockers = open
      ? (await this.blockers(db, row, space, pages)).filter(blocker => !blocker.path || visiblePaths.has(blocker.path))
      : [];
    return {
      ...mapChangeSet(row, space.slug),
      pages: shown,
      hiddenPages: hidden,
      reviews: reviews.map(review => ({
        reviewerName: String(review.reviewer_name),
        verdict: String(review.verdict),
        note: String(review.note),
        stale: Boolean(review.stale),
        createdAt: iso(review.created_at)
      })),
      rules: mergeRulesOf(space),
      blockers,
      canReview:
        open &&
        principal.kind === "user" &&
        !principal.guest &&
        atLeast(role, "editor") &&
        row.author_id !== principal.id,
      canChange: open && Boolean(this.ownsOrEdits(principal, row, role)),
      canMerge: open && atLeast(role, "editor") && blockers.length === 0 && hidden === 0,
      canDelete: row.status !== "merged" && this.mayDelete(principal, row, role)
    };
  }

  /** A person's say. Saying again replaces what they said, and it stops counting once what they looked at changes. */
  async review(principal: Principal, id: string, input: z.output<typeof reviewInput>) {
    const { db } = this.context;
    return db.transaction(async tx => {
      const { row, role, space } = await this.load(tx, principal, id, true);
      this.assertOpen(row);
      if (principal.kind !== "user" || principal.guest) throw forbidden(t("Only people can review a change set"));
      if (!atLeast(role, "editor")) throw forbidden();
      if (row.author_id === principal.id) throw forbidden(t("You cannot review your own change set"));
      await this.assertSeesEverything(
        tx,
        principal,
        space,
        role,
        await this.pagesOf(tx, id),
        t("You cannot review pages you cannot read")
      );
      await tx.query(
        `INSERT INTO pandocs.change_set_reviews (change_set_id, reviewer_id, reviewer_name, verdict, note) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (change_set_id, reviewer_id) DO UPDATE SET reviewer_name = $3, verdict = $4, note = $5, stale = false, created_at = now()`,
        [id, principal.id, principal.displayName, input.verdict, input.note ?? ""]
      );
      await tx.query(`UPDATE pandocs.change_sets SET updated_at = now() WHERE id = $1`, [id]);
      await audit(tx, principal, "space.change_set.review", "space", space.id, {
        changeSet: id,
        title: row.title,
        verdict: input.verdict
      });
      await this.tellAuthor(
        tx,
        principal,
        row,
        input.verdict === "approved" ? t("approved your change set") : t("asked for changes to your change set")
      );
      return { verdict: input.verdict };
    });
  }

  private async assertSeesEverything(
    tx: Queryable,
    principal: Principal,
    space: SpaceRecord,
    role: Parameters<typeof atLeast>[0],
    pages: readonly PageRow[],
    message: string
  ): Promise<void> {
    for (const page of pages) {
      if (!(await this.readsPage(tx, principal, space, page, atLeast(role, "admin")))) throw forbidden(message);
    }
  }

  private async tellAuthor(
    tx: Queryable,
    principal: Principal,
    row: Record<string, unknown>,
    summary: string
  ): Promise<void> {
    const recipient = String(row.on_behalf_of ?? row.author_id);
    if (recipient === principal.id) return;
    await tx.query(
      `INSERT INTO pandocs.notifications (recipient_id, kind, change_set_id, actor_name, summary) VALUES ($1, 'change_set', $2, $3, $4)`,
      [recipient, row.id, principal.displayName, summary]
    );
  }

  /** All of it or none of it: any page that cannot land means nothing changes. */
  async merge(principal: Principal, id: string) {
    const { db } = this.context;
    return db.transaction(async tx => {
      const { row, space, role } = await this.load(tx, principal, id, true);
      if (!atLeast(role, "editor"))
        throw forbidden(
          principal.kind === "agent"
            ? t("Agents cannot merge change sets. Someone with edit access has to.")
            : undefined
        );
      this.assertOpen(row);
      const pages = await this.pagesOf(tx, id);
      const blockers = await this.blockers(tx, row, space, pages);
      if (blockers.length > 0)
        throw new PandocsError(
          409,
          "CHANGE_SET_BLOCKED",
          blockers
            .map(blocker => (blocker.path ? t("{0}: {1}", blocker.path, blocker.message) : blocker.message))
            .join("; "),
          { blockers }
        );
      const message = t("{0}'s change set: {1}", String(row.author_name), String(row.title).slice(0, 80));
      const changed: { path: string; revision?: number; deleted?: boolean }[] = [];
      // Pages come before what goes under them, and go after it.
      const order: readonly PageRow[] = [
        ...pages.filter(page => page.kind === "restore"),
        ...pages.filter(page => page.kind === "edit"),
        ...pages.filter(page => page.kind === "create").sort((a, b) => depth(a.path) - depth(b.path)),
        ...pages.filter(page => page.kind === "delete").sort((a, b) => depth(b.path) - depth(a.path))
      ];
      for (const page of order) {
        if (page.kind === "restore") {
          const plan = await this.planPage(tx, page, pages, space);
          if (plan.problem)
            throw new PandocsError(409, "CHANGE_SET_BLOCKED", t("{0}: {1}", page.path, plan.problem.message), {
              blockers: [plan.problem]
            });
          const restored = await this.tree.restoreIn(tx, principal, page.document_id!);
          changed.push({ path: restored.path, revision: restored.currentRevisionNo });
          continue;
        }
        if (page.kind === "create") {
          const parent = parentOf(page.path);
          await requireSpace(tx, principal, space.slug, "editor");
          const made = await this.documents.createIn(tx, principal, space, {
            title: page.title ?? page.path,
            slug: page.path.split("/").at(-1)!,
            ...(parent ? { parentPath: parent } : {}),
            markdown: page.markdown ?? "",
            message,
            changeSetId: id
          });
          changed.push({ path: made.document.path, revision: made.revision.no });
          continue;
        }
        const { document } = await requireDocument(tx, principal, page.document_id!, "editor", true);
        const plan = await this.planPage(tx, page, pages, space);
        if (plan.problem)
          throw new PandocsError(409, "CHANGE_SET_BLOCKED", t("{0}: {1}", page.path, plan.problem.message), {
            blockers: [plan.problem]
          });
        if (page.kind === "delete") {
          await this.tree.removeIn(tx, principal, document, space);
          changed.push({ path: page.path, deleted: true });
          continue;
        }
        const committed = await this.documents.commit(tx, principal, document, {
          markdown: plan.markdown ?? "",
          message,
          changeSetId: id
        });
        if (page.title && page.title !== document.title) {
          await tx.query(`UPDATE pandocs.documents SET title = $2, updated_at = now() WHERE id = $1`, [
            document.id,
            page.title
          ]);
          await audit(tx, principal, "document.update", "document", document.id, { title: page.title });
        }
        changed.push({ path: page.path, revision: committed.revision.no });
      }
      const { rows } = await tx.query(
        `UPDATE pandocs.change_sets SET status = 'merged', decided_by = $2, decided_name = $3, decided_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, principal.id, principal.displayName]
      );
      await audit(tx, principal, "space.change_set.merge", "space", space.id, {
        changeSet: id,
        title: row.title,
        pages: changed.length
      });
      await this.tellAuthor(tx, principal, row, t("merged your change set"));
      return { changeSet: mapChangeSet(rows[0]!, space.slug), pages: changed };
    });
  }

  async close(principal: Principal, id: string) {
    return this.setStatus(principal, id, "closed");
  }

  async reopen(principal: Principal, id: string) {
    return this.setStatus(principal, id, "open");
  }

  private async setStatus(principal: Principal, id: string, status: "open" | "closed") {
    return this.context.db.transaction(async tx => {
      const { row, role, space } = await this.load(tx, principal, id, true);
      if (!this.ownsOrEdits(principal, row, role)) throw forbidden();
      if (row.status === "merged")
        throw new PandocsError(409, "CHANGE_SET_NOT_OPEN", t("This change set has been merged"));
      if (row.status === status) return mapChangeSet(row, space.slug);
      const { rows } = await tx.query(
        `UPDATE pandocs.change_sets SET status = $2, decided_by = $3, decided_name = $4, decided_at = $5, updated_at = now() WHERE id = $1 RETURNING *`,
        [
          id,
          status,
          status === "closed" ? principal.id : null,
          status === "closed" ? principal.displayName : null,
          status === "closed" ? new Date() : null
        ]
      );
      await audit(
        tx,
        principal,
        status === "closed" ? "space.change_set.close" : "space.change_set.reopen",
        "space",
        space.id,
        { changeSet: id, title: row.title }
      );
      if (status === "closed") await this.tellAuthor(tx, principal, row, t("closed your change set"));
      return mapChangeSet(rows[0]!, space.slug);
    });
  }

  /** Gone for good, with its pages, reviews and notices. Only one that never landed: a merged one is part of its pages' history. */
  async delete(principal: Principal, id: string) {
    return this.context.db.transaction(async tx => {
      const { row, role, space } = await this.load(tx, principal, id, true);
      if (principal.kind !== "user" || principal.guest) throw forbidden(t("Only people can delete a change set"));
      if (!this.mayDelete(principal, row, role))
        throw forbidden(t("Only whoever made a change set, or an administrator of its space, can delete it"));
      if (row.status === "merged")
        throw new PandocsError(
          409,
          "CHANGE_SET_MERGED",
          t("A merged change set is part of its pages' history, so it stays")
        );
      await audit(tx, principal, "space.change_set.delete", "space", space.id, { changeSet: id, title: row.title });
      await tx.query(`DELETE FROM pandocs.change_sets WHERE id = $1`, [id]);
      return { deleted: true };
    });
  }

  /** Waiting for this person: open, not theirs, in a space they can edit, and not already answered since it last changed. */
  async waitingFor(principal: Principal) {
    const { db } = this.context;
    if (principal.kind !== "user" || principal.anonymous || principal.guest) return [];
    const { rows } = await db.query(
      `SELECT c.*, s.slug, (SELECT count(*)::int FROM pandocs.change_set_pages p WHERE p.change_set_id = c.id) AS pages
       FROM pandocs.change_sets c JOIN pandocs.spaces s ON s.id = c.space_id AND s.deleted_at IS NULL
       WHERE c.status = 'open' AND c.author_id <> $1
         AND NOT EXISTS (SELECT 1 FROM pandocs.change_set_reviews r WHERE r.change_set_id = c.id AND r.reviewer_id = $1 AND NOT r.stale)
         AND EXISTS (SELECT 1 FROM pandocs.change_set_pages p WHERE p.change_set_id = c.id)
       ORDER BY c.updated_at DESC LIMIT $2`,
      [principal.id, LISTED]
    );
    const editable = new Map<string, boolean>();
    const waiting = [];
    for (const row of rows) {
      const slug = String(row.slug);
      if (!editable.has(slug))
        editable.set(
          slug,
          await requireSpace(db, principal, slug, "editor").then(
            () => true,
            (error: unknown) => {
              if (error instanceof PandocsError) return false;
              throw error;
            }
          )
        );
      if (editable.get(slug)) waiting.push({ ...mapChangeSet(row, slug), pages: Number(row.pages) });
    }
    return waiting;
  }
}
