import { createHash } from "node:crypto";
import { t } from "@pandocs/i18n";
import { z } from "zod";
import { notFound, PandocsError, revisionConflict } from "../domain/errors.js";
import type { Principal, SpaceRecord } from "../domain/types.js";
import type { Queryable } from "../infrastructure/db.js";
import { assertMemorySpace, requireDocument, requireSpace, type AppContext } from "./context.js";
import {
  documentLabels,
  HOME_DOCUMENT_PATH,
  MAX_MARKDOWN_BYTES,
  slugFromTitle,
  type DocumentService
} from "./documents.js";
import { loadRevision } from "./revisions.js";

export const recallInput = z
  .object({
    space: z.string().min(1),
    query: z.string().trim().min(1).optional(),
    labels: documentLabels.optional(),
    limit: z.number().int().min(1).max(100).default(10)
  })
  .strict()
  .refine(input => input.query || input.labels?.length, { error: "Give a query or labels" });

export const rememberInput = z
  .object({
    space: z.string().min(1),
    topic: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("A short topic title, used to address one canonical page in this space"),
    doc: z.string().uuid().optional().describe("Exact page ID from recall or a previous save"),
    content: z.string().min(1).max(MAX_MARKDOWN_BYTES),
    labels: documentLabels.default([]),
    mode: z.enum(["append", "replace"]).default("append"),
    expectedRevision: z.number().int().positive().optional(),
    requestId: z.string().uuid().describe("A unique ID for this write; reuse it when retrying the same request")
  })
  .strict()
  .refine(input => Boolean(input.doc) !== Boolean(input.topic), { error: "Give either doc or topic" })
  .refine(input => input.mode !== "replace" || (input.doc && input.expectedRevision), {
    error: "Replacing requires a page ID and its expectedRevision"
  });

type RememberInput = z.output<typeof rememberInput>;

interface SavedMemory {
  id: string;
  path: string;
  url: string;
  revision: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function appendMarkdown(previous: string, addition: string): string {
  if (!previous || previous.endsWith("\n\n")) return previous + addition;
  return previous + (previous.endsWith("\n") ? "\n" : "\n\n") + addition;
}

export class MemoryService {
  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService
  ) {}

  private pageUrl(space: string, path: string): string {
    const encoded = path === HOME_DOCUMENT_PATH ? "" : path.split("/").map(encodeURIComponent).join("/");
    return `${this.context.ports.siteUrl ?? ""}/${encodeURIComponent(space)}/${encoded}`;
  }

  async recall(principal: Principal, input: z.output<typeof recallInput>) {
    return this.context.db.transaction(async tx => {
      // Search hits, snippets, permissions and their revision numbers must describe the same snapshot.
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const { space } = await requireSpace(tx, principal, input.space);
      assertMemorySpace(principal, space);
      const hits = await this.documents.search(principal, { ...input, query: input.query ?? "" }, tx);
      return hits.map(({ id, title, path, revision, snippet }) => ({
        id,
        title,
        path,
        url: this.pageUrl(space.slug, path),
        revision,
        snippet
      }));
    });
  }

  async remember(principal: Principal, input: RememberInput): Promise<SavedMemory> {
    return this.context.db.transaction(async tx => {
      const { space } = await requireSpace(tx, principal, input.space, "memory-write");
      // OAuth access tokens rotate. Scope a logical request to its owner and project across reconnects.
      const caller = `memory:${space.id}:${principal.kind}:${principal.onBehalfOf?.id ?? principal.id}`;
      const hash = digest(
        JSON.stringify([
          input.doc ?? null,
          input.topic ?? null,
          input.content,
          input.mode,
          input.expectedRevision ?? null,
          [...input.labels].sort()
        ])
      );
      const { rowCount } = await tx.query(
        `INSERT INTO pandocs.idempotency_keys (principal_id, key, request_hash, status, response)
         VALUES ($1,$2,$3,0,'null') ON CONFLICT (principal_id,key) DO NOTHING`,
        [caller, input.requestId, hash]
      );
      if (rowCount === 0) {
        const {
          rows: [receipt]
        } = await tx.query<{ request_hash: string; response: SavedMemory }>(
          `SELECT request_hash, response FROM pandocs.idempotency_keys WHERE principal_id=$1 AND key=$2 FOR SHARE`,
          [caller, input.requestId]
        );
        if (!receipt || receipt.request_hash !== hash)
          throw new PandocsError(409, "IDEMPOTENCY_KEY_REUSED", t("This Idempotency-Key was used for another request"));
        await requireDocument(tx, principal, receipt.response.id, "content", false, space.id);
        return receipt.response;
      }

      const saved = await this.save(tx, principal, space, input);
      const { id, path } = saved.document;
      if (input.labels.length) await this.documents.setLabelsIn(tx, principal, id, input.labels, true);
      const result = { id, path, url: this.pageUrl(space.slug, path), revision: saved.revision.no };
      // A committed revision, its labels and its receipt survive or roll back together.
      await tx.query(`UPDATE pandocs.idempotency_keys SET status=200, response=$3 WHERE principal_id=$1 AND key=$2`, [
        caller,
        input.requestId,
        JSON.stringify(result)
      ]);
      return result;
    });
  }

  private async save(tx: Queryable, principal: Principal, space: SpaceRecord, input: RememberInput) {
    let id = input.doc;
    if (input.topic) {
      const key = input.topic.normalize("NFC").toLowerCase();
      // A short readable prefix also fits the path's byte limit for non-Latin topics. Hash the full topic.
      const prefix = slugFromTitle("memory " + [...key].slice(0, 32).join(""));
      const path = `${prefix}-${digest(key).slice(0, 20)}`;
      // There is no document row to lock on first use. Concurrent first appends to the same topic share this lock.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${space.id}/${path}`]);
      const {
        rows: [topic]
      } = await tx.query<{ id: string | null }>(
        `SELECT COALESCE(
           (SELECT id FROM pandocs.documents WHERE space_id=$1 AND lower(path)=lower($2) AND deleted_at IS NULL),
           (SELECT document_id FROM pandocs.document_redirects WHERE space_id=$1 AND old_path=$2)
         ) AS id`,
        [space.id, path]
      );
      if (!topic?.id) {
        if (input.expectedRevision !== undefined) throw notFound(t("Document"));
        return this.documents.createIn(tx, principal, space, {
          title: input.topic,
          slug: path,
          markdown: input.content
        });
      }
      id = topic.id;
    }
    const { document } = await requireDocument(tx, principal, id!, "content", true, space.id);
    if (input.expectedRevision !== undefined && input.expectedRevision !== document.currentRevisionNo)
      throw revisionConflict(document.currentRevisionNo);
    let markdown = input.content;
    if (input.mode === "append") {
      const current = await loadRevision(tx, document.id, document.currentRevisionNo);
      markdown = appendMarkdown(current.markdown, markdown);
    }
    return this.documents.commit(tx, principal, document, { markdown });
  }
}
