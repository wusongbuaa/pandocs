import { t } from "@pandocs/i18n";
import {
  blocksInTextRange,
  parseDocument,
  squashWhitespace,
  topLevelBlocks,
  visibleText,
  type Anchor,
  type ParsedDocument
} from "@pandocs/markdown";
import { PandocsError, invalid } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import type { AssistAction } from "../ports.js";
import { audit, requireDocument, type AppContext } from "./context.js";
import { loadRevision } from "./revisions.js";
import type { ThreadService, ThreadView } from "./threads.js";

const MAX_SELECTION = 4000;
const CONTEXT_AROUND = 500;
const MAX_DISCUSSION = 2000;

export interface ThreadSuggestion {
  /** The version the blocks were read from, which a proposal has to name. */
  readonly baseRevision: number;
  readonly firstRef: string;
  readonly lastRef: string;
  /** The Markdown the suggestion replaces, and what the model would put there. */
  readonly source: string;
  readonly text: string;
}

/** Anchor offsets count the text without whitespace. The model needs the spaces back, or English runs together. */
export function sliceVisibleText(visible: string, start: number, end: number): string {
  let from = -1;
  let to = visible.length;
  let counted = 0;
  for (let index = 0; index < visible.length; index += 1) {
    if (/\s/u.test(visible[index]!)) continue;
    if (counted === start) from = index;
    if (counted === end) {
      to = index;
      break;
    }
    counted += 1;
  }
  return from === -1 ? "" : visible.slice(from, to).trim();
}

/** The blocks a discussion is about. A discussion on the whole page is about all of them. */
function blocksOfAnchor(
  parsed: ParsedDocument,
  anchor: Anchor,
  context: AppContext
): { first: string; last: string } | null {
  if (anchor.kind === "block") return { first: anchor.ref, last: anchor.ref };
  if (anchor.kind === "text") return blocksInTextRange(parsed, anchor.start, anchor.end, context.registry);
  const blocks = topLevelBlocks(parsed);
  return blocks[0] ? { first: blocks[0].ref, last: blocks.at(-1)!.ref } : null;
}

/** The latest words decide what a discussion concluded, so a long one loses its start. */
function discussionOf(thread: ThreadView): string {
  const quote = thread.anchor.kind === "text" ? `About this text: ${thread.anchor.exact}\n` : "";
  const comments = thread.comments.map(comment => `${comment.authorName}: ${comment.body}`).join("\n");
  return `${quote}${comments.slice(-(MAX_DISCUSSION - quote.length))}`;
}

export class AssistService {
  constructor(
    private readonly context: AppContext,
    private readonly threads: ThreadService
  ) {}

  /**
   * Reads the selection from the stored version instead of taking text from the browser, so what goes to the
   * model is always something this person may read, and the endpoint cannot be used as a general model.
   */
  async assist(
    principal: Principal,
    documentId: string,
    input: { action: AssistAction; start: number; end: number; revision?: number | undefined }
  ): Promise<{ action: AssistAction; text: string }> {
    const { db, ports } = this.context;
    if (!ports.llm) throw new PandocsError(503, "LLM_UNAVAILABLE", t("AI is not set up here"));
    if (input.end <= input.start) throw invalid("ASSIST_SELECTION_INVALID", t("Nothing usable is selected"));
    if (input.end - input.start > MAX_SELECTION)
      throw invalid("ASSIST_SELECTION_TOO_LONG", t("The selection is too long. Try a smaller one."));
    const { document } = await requireDocument(db, principal, documentId, "viewer");
    const { visibleText } = await loadRevision(db, documentId, input.revision ?? document.currentRevisionNo);
    const content = sliceVisibleText(visibleText, input.start, input.end);
    if (!content) throw invalid("ASSIST_SELECTION_INVALID", t("The selection is outside the document"));
    const context = sliceVisibleText(
      visibleText,
      Math.max(0, input.start - CONTEXT_AROUND),
      input.end + CONTEXT_AROUND
    );
    const text = await ports.llm.assist({ action: input.action, content, context, actor: principal });
    await audit(db, principal, "document.assist", "document", documentId, { action: input.action });
    return { action: input.action, text };
  }

  /**
   * The same for words being edited, which are not in any version yet. The browser saves its draft first, and the words
   * have to be in it, so this still only reads what is stored for this person and is not a general model endpoint. In a
   * shared draft, which someone may have typed into a moment ago, the browser says what it holds, and the selection still has to be in that.
   */
  async assistOnDraft(
    principal: Principal,
    documentId: string,
    input: { action: AssistAction; quote: string; lang: string; markdown?: string | undefined }
  ): Promise<{ action: AssistAction; text: string }> {
    const { db, ports, registry } = this.context;
    if (!ports.llm) throw new PandocsError(503, "LLM_UNAVAILABLE", t("AI is not set up here"));
    const needle = squashWhitespace(input.quote);
    if (!needle) throw invalid("ASSIST_SELECTION_INVALID", t("Nothing usable is selected"));
    if (needle.length > MAX_SELECTION)
      throw invalid("ASSIST_SELECTION_TOO_LONG", t("The selection is too long. Try a smaller one."));
    const { document } = await requireDocument(db, principal, documentId, input.lang ? "editor" : "commenter");
    // What the browser says it holds counts only for a shared draft, which is the one thing with words not written down
    // anywhere yet. Without one, this reads what is stored like everything else.
    const { rows: shared } =
      input.markdown !== undefined && !input.lang
        ? await db.query(`SELECT 1 FROM pandocs.live_drafts WHERE document_id = $1`, [documentId])
        : { rows: [] };
    const { rows } = await db.query<{ markdown: string }>(
      `SELECT markdown FROM pandocs.drafts WHERE document_id = $1 AND user_id = $2 AND lang = $3`,
      [documentId, principal.id, input.lang]
    );
    // Before the first change there is no draft, and the editor shows what is published.
    const { rows: translated } =
      input.lang && !rows[0]
        ? await db.query<{ markdown: string }>(
            `SELECT markdown FROM pandocs.document_translations WHERE document_id = $1 AND lang = $2`,
            [documentId, input.lang]
          )
        : { rows: [] };
    const markdown =
      (shared[0] ? input.markdown : undefined) ??
      rows[0]?.markdown ??
      translated[0]?.markdown ??
      (await loadRevision(db, documentId, document.currentRevisionNo)).markdown;
    const visible = visibleText(parseDocument(markdown, registry), registry);
    const start = squashWhitespace(visible).indexOf(needle);
    if (start < 0)
      throw invalid("ASSIST_SELECTION_INVALID", t("The selected text is not in the draft. Try again in a moment."));
    const context = sliceVisibleText(
      visible,
      Math.max(0, start - CONTEXT_AROUND),
      start + needle.length + CONTEXT_AROUND
    );
    const text = await ports.llm.assist({ action: input.action, content: input.quote, context, actor: principal });
    await audit(db, principal, "document.assist", "document", documentId, { action: input.action, draft: true });
    return { action: input.action, text };
  }

  /** Turns what a discussion concluded into replacement text. Nothing is written: a person reads it and submits a proposal. */
  async suggestFromThread(principal: Principal, threadId: string): Promise<ThreadSuggestion> {
    const { db, ports } = this.context;
    if (!ports.llm) throw new PandocsError(503, "LLM_UNAVAILABLE", t("AI is not set up here"));
    const thread = await this.threads.get(principal, threadId);
    const { document } = await requireDocument(db, principal, thread.documentId, "commenter");
    if (thread.status !== "open") throw invalid("THREAD_RESOLVED", t("This discussion is already resolved"));
    if (thread.anchorState === "orphaned")
      throw invalid("THREAD_ANCHOR_LOST", t("What this discussion is about is no longer in the document"));
    const { markdown } = await loadRevision(db, thread.documentId, document.currentRevisionNo);
    const parsed = parseDocument(markdown, this.context.registry);
    const range = blocksOfAnchor(parsed, thread.anchor, this.context);
    const blocks = topLevelBlocks(parsed);
    const first = blocks.find(block => block.ref === range?.first);
    const last = blocks.find(block => block.ref === range?.last);
    if (!first || !last)
      throw invalid("THREAD_ANCHOR_LOST", t("What this discussion is about is no longer in the document"));
    const source = markdown.slice(first.start, last.end);
    if ([...source].length > MAX_SELECTION)
      throw invalid(
        "ASSIST_SELECTION_TOO_LONG",
        t("This text is too long for AI to handle at once. Try discussing a more specific passage.")
      );
    const text = await ports.llm.assist({
      action: "apply_discussion",
      content: source,
      context: discussionOf(thread),
      actor: principal
    });
    await audit(db, principal, "thread.suggest", "thread", threadId);
    return { baseRevision: document.currentRevisionNo, firstRef: first.ref, lastRef: last.ref, source, text };
  }
}
