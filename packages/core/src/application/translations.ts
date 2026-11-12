import { t } from "@pandocs/i18n";
import { mergeThreeWay, parseDocument, splitFrontMatter, topLevelBlocks, visibleText } from "@pandocs/markdown";
import { PandocsError, invalid, notFound } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import { audit, requireDocument, type AppContext } from "./context.js";
import { loadRevision } from "./revisions.js";
import type { SiteService } from "./site.js";

const MAX_CHUNK = 3000;
const MAX_TRANSLATION_BYTES = 2 * 1024 * 1024;

export interface TranslationMeta {
  readonly lang: string;
  readonly title: string;
  readonly sourceRevision: number;
  /** The source has changed since this was translated. */
  readonly stale: boolean;
  readonly machine: boolean;
  readonly updatedName: string;
  readonly updatedAt: Date;
}

export interface TranslationView extends TranslationMeta {
  readonly markdown: string;
}

function mapMeta(row: Record<string, unknown>, currentRevisionNo: number): TranslationMeta {
  return {
    lang: String(row.lang),
    title: String(row.title),
    sourceRevision: Number(row.source_revision_no),
    stale: Number(row.source_revision_no) < currentRevisionNo,
    machine: Boolean(row.machine),
    updatedName: String(row.updated_name),
    updatedAt: new Date(row.updated_at as string)
  };
}

/**
 * A page in another language is a copy someone keeps up to date, not another version of the page: it has no history
 * and no discussions, and it says so when the source has moved on. Only the source language is what people comment on.
 */
export class TranslationService {
  constructor(private readonly context: AppContext, private readonly site: SiteService) {}

  /** A language this site offers, other than the one its pages are written in. */
  private async targetLabel(lang: string): Promise<string> {
    const site = await this.site.get();
    const locale = site.locales.find(item => item.lang === lang);
    if (!locale || lang === site.defaultLang) throw invalid("LANG_INVALID", t("This site does not have that language turned on"));
    return locale.label;
  }

  async list(principal: Principal, documentId: string): Promise<TranslationMeta[]> {
    const { db } = this.context;
    const { document } = await requireDocument(db, principal, documentId);
    const { rows } = await db.query(`SELECT lang, title, source_revision_no, machine, updated_name, updated_at FROM pandocs.document_translations WHERE document_id = $1 ORDER BY lang`, [documentId]);
    return rows.map(row => mapMeta(row, document.currentRevisionNo));
  }

  async get(principal: Principal, documentId: string, lang: string): Promise<TranslationView> {
    const { db } = this.context;
    const { document } = await requireDocument(db, principal, documentId);
    const { rows } = await db.query(`SELECT * FROM pandocs.document_translations WHERE document_id = $1 AND lang = $2`, [documentId, lang]);
    if (!rows[0]) throw notFound(t("Translation"));
    return { ...mapMeta(rows[0], document.currentRevisionNo), markdown: String(rows[0].markdown) };
  }

  /**
   * `base` is the translation as the writer started from it. When someone has saved it since, what each changed is merged,
   * as for a page; a change to the same place is refused rather than quietly undoing theirs. Without it, this replaces.
   */
  async save(principal: Principal, documentId: string, lang: string, input: { title: string; markdown: string; sourceRevision: number; machine?: boolean | undefined; base?: { updatedAt: string; markdown: string; title?: string | undefined } | undefined }): Promise<TranslationMeta> {
    const { db, registry } = this.context;
    await this.targetLabel(lang);
    if (Buffer.byteLength(input.markdown, "utf8") > MAX_TRANSLATION_BYTES) throw invalid("DOCUMENT_TOO_LARGE", t("The document is larger than 2 MiB"));
    return db.transaction(async tx => {
      const { document } = await requireDocument(tx, principal, documentId, "editor", true);
      if (input.sourceRevision > document.currentRevisionNo) throw invalid("REVISION_INVALID", t("The original has no such version"));
      let { markdown, title } = input;
      if (input.base) {
        const { rows: saved } = await tx.query<{ markdown: string; title: string; updated_at: Date }>(`SELECT markdown, title, updated_at FROM pandocs.document_translations WHERE document_id = $1 AND lang = $2 FOR UPDATE`, [documentId, lang]);
        const current = saved[0];
        if (current && new Date(current.updated_at).getTime() !== Date.parse(input.base.updatedAt)) {
          const merged = mergeThreeWay(input.base.markdown, markdown, current.markdown, registry);
          if (!merged.ok) throw new PandocsError(409, "MERGE_CONFLICT", t("Someone changed the same text, so this needs merging by hand"), { conflicts: merged.conflicts });
          markdown = merged.markdown;
          if (input.base.title !== undefined && title === input.base.title) title = current.title;
        }
      }
      if (Buffer.byteLength(markdown, "utf8") > MAX_TRANSLATION_BYTES) throw invalid("DOCUMENT_TOO_LARGE", t("The document is larger than 2 MiB"));
      const parsed = parseDocument(markdown, registry);
      const tooDeep = parsed.diagnostics.find(item => item.code === "DOCUMENT_TOO_DEEP");
      if (tooDeep) throw invalid("DOCUMENT_TOO_DEEP", tooDeep.message);
      const text = visibleText(parsed, registry);
      const { rows } = await tx.query(
        `INSERT INTO pandocs.document_translations (document_id, lang, title, markdown, visible_text, source_revision_no, machine, updated_by, updated_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (document_id, lang) DO UPDATE SET title = EXCLUDED.title, markdown = EXCLUDED.markdown, visible_text = EXCLUDED.visible_text,
           source_revision_no = EXCLUDED.source_revision_no, machine = EXCLUDED.machine, updated_by = EXCLUDED.updated_by, updated_name = EXCLUDED.updated_name, updated_at = now()
         RETURNING *`,
        [documentId, lang, title, markdown, text, input.sourceRevision, input.machine ?? false, principal.id, principal.displayName]
      );
      await audit(tx, principal, "document.translate", "document", documentId, { lang, sourceRevision: input.sourceRevision, machine: input.machine ?? false });
      return mapMeta(rows[0]!, document.currentRevisionNo);
    });
  }

  async remove(principal: Principal, documentId: string, lang: string): Promise<void> {
    await this.context.db.transaction(async tx => {
      await requireDocument(tx, principal, documentId, "editor", true);
      await tx.query(`DELETE FROM pandocs.document_translations WHERE document_id = $1 AND lang = $2`, [documentId, lang]);
      await audit(tx, principal, "document.translation.delete", "document", documentId, { lang });
    });
  }

  /**
   * One bounded model call for one run of blocks. The browser goes through a page a few blocks at a time, so a long
   * page does not hang on one request and a failure part way loses nothing. The text always comes from the stored
   * version, for the same reason as selection assist.
   */
  async generate(principal: Principal, documentId: string, lang: string, input: { from: string; to: string } | { title: true }): Promise<{ text: string }> {
    const { db, ports, registry } = this.context;
    if (!ports.llm) throw new PandocsError(503, "LLM_UNAVAILABLE", t("AI is not set up here"));
    const target = await this.targetLabel(lang);
    const { document } = await requireDocument(db, principal, documentId, "editor");
    let content = document.title;
    if (!("title" in input)) {
      const { markdown } = await loadRevision(db, documentId, document.currentRevisionNo);
      const blocks = topLevelBlocks(parseDocument(markdown, registry));
      const first = blocks.find(block => block.ref === input.from);
      const last = blocks.find(block => block.ref === input.to);
      if (!first || !last || last.end < first.start) throw invalid("BLOCK_NOT_FOUND", t("Found nothing to translate"));
      content = markdown.slice(first.start, last.end);
      if ([...content].length > MAX_CHUNK) throw invalid("TRANSLATION_CHUNK_TOO_LONG", t("This passage is too long to translate at once"));
    }
    return { text: await ports.llm.assist({ action: "translate", content, context: "", target, actor: principal }) };
  }

  /** What the search index reads instead of the source, for the pages translated into this language. */
  async forIndex(documentIds: readonly string[], lang: string): Promise<Map<string, { title: string; markdown: string; visibleText: string }>> {
    // Pages are written in the site's language; a translation into it is left from before the site changed its language.
    if (lang === (await this.site.get()).defaultLang) return new Map();
    const { rows } = await this.context.db.query<{ document_id: string; title: string; markdown: string; visible_text: string }>(
      `SELECT document_id, title, markdown, visible_text FROM pandocs.document_translations WHERE lang = $1 AND document_id = ANY($2::uuid[])`,
      [lang, documentIds]
    );
    return new Map(rows.map(row => [row.document_id, { title: row.title, markdown: splitFrontMatter(row.markdown).body, visibleText: row.visible_text }]));
  }
}
