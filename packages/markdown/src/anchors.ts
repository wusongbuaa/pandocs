import { t } from "@pandocs/i18n";
import approxSearch from "approx-string-match";
import { squashWhitespace } from "./visible-text.js";

const CONTEXT_LENGTH = 32;

export interface TextAnchor {
  readonly kind: "text";
  /** What the author selected, whitespace intact, for display when the anchor is lost. */
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly start: number;
  readonly end: number;
  /** The quote was there more than once when the anchor was made, so finding it once later is not enough to be sure. */
  readonly repeated?: boolean;
}

export interface BlockAnchor {
  readonly kind: "block";
  readonly ref: string;
  readonly type: string;
  readonly hash: string;
  readonly preview: string;
}

export interface DocumentAnchor {
  readonly kind: "document";
}

export type Anchor = TextAnchor | BlockAnchor | DocumentAnchor;
export type AnchorState = "exact" | "fuzzy" | "orphaned";

export class AnchorError extends Error {
  constructor(
    readonly code: "ANCHOR_NOT_FOUND" | "ANCHOR_AMBIGUOUS" | "ANCHOR_INVALID",
    message: string
  ) {
    super(message);
    this.name = "AnchorError";
  }
}

/**
 * Where a slice can start or end without cutting a character in two. An emoji is two units of a string, and half of one
 * is not text: the database refuses it, and so it refused the comment, or the page it was on.
 */
function whole(text: string, at: number, towardsStart: boolean): number {
  const splits =
    at > 0 && at < text.length && /[\uDC00-\uDFFF]/u.test(text[at]!) && /[\uD800-\uDBFF]/u.test(text[at - 1]!);
  return splits ? at + (towardsStart ? -1 : 1) : at;
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1 && count < 2; at = text.indexOf(needle, at + 1)) count += 1;
  return count;
}

export function anchorFromRange(squashed: string, start: number, end: number, exact?: string): TextAnchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > squashed.length) {
    throw new AnchorError("ANCHOR_INVALID", t("The selection is outside the document"));
  }
  const from = whole(squashed, start, true);
  const to = whole(squashed, end, false);
  const quote = exact ?? squashed.slice(from, to);
  const needle = squashWhitespace(quote);
  return {
    kind: "text",
    exact: quote,
    prefix: squashed.slice(whole(squashed, Math.max(0, from - CONTEXT_LENGTH), true), from),
    suffix: squashed.slice(to, whole(squashed, Math.min(squashed.length, to + CONTEXT_LENGTH), false)),
    start: from,
    end: to,
    ...(needle && occurrences(squashed, needle) > 1 ? { repeated: true } : {})
  };
}

/** For callers without a browser selection: CLI and MCP pass the text they mean. */
export function anchorFromQuote(squashed: string, quote: string, occurrence?: number): TextAnchor {
  const needle = squashWhitespace(quote);
  if (!needle) throw new AnchorError("ANCHOR_INVALID", t("A quote cannot be empty"));
  const hits: number[] = [];
  for (let at = squashed.indexOf(needle); at !== -1; at = squashed.indexOf(needle, at + 1)) hits.push(at);
  if (hits.length === 0) throw new AnchorError("ANCHOR_NOT_FOUND", t("This quote is not in the document"));
  if (occurrence === undefined && hits.length > 1) {
    throw new AnchorError(
      "ANCHOR_AMBIGUOUS",
      t("This quote appears {0} times. Use occurrence to pick one, or make it more specific.", hits.length)
    );
  }
  const start = hits[(occurrence ?? 1) - 1];
  if (start === undefined)
    throw new AnchorError("ANCHOR_NOT_FOUND", t("This quote only appears {0} {0|time|times}", hits.length));
  return anchorFromRange(squashed, start, start + needle.length, quote);
}

export interface RelocatedText {
  readonly state: AnchorState;
  readonly anchor: TextAnchor;
}

/**
 * A wrong highlight is worse than a lost one, so a fuzzy hit has to clear two bars: the quote stays
 * recognisable, and the surrounding text backs it up. Scoring follows Hypothesis' match-quote.
 */
export function relocateTextAnchor(anchor: TextAnchor, squashed: string): RelocatedText {
  const needle = squashWhitespace(anchor.exact);
  if (!needle) return { state: "orphaned", anchor };
  const exact = bestExact(squashed, needle, anchor);
  if (exact !== undefined) {
    return { state: "exact", anchor: anchorFromRange(squashed, exact, exact + needle.length, anchor.exact) };
  }
  const maxErrors = Math.min(256, Math.floor(needle.length * 0.35));
  if (maxErrors === 0) return { state: "orphaned", anchor };
  let best: { start: number; end: number; total: number; quote: number; context: number } | undefined;
  for (const match of approxSearch(squashed, needle, maxErrors)) {
    const quote = 1 - match.errors / needle.length;
    const prefix = similarity(
      squashed.slice(Math.max(0, match.start - anchor.prefix.length), match.start),
      anchor.prefix
    );
    const suffix = similarity(squashed.slice(match.end, match.end + anchor.suffix.length), anchor.suffix);
    const position = 1 - Math.abs(match.start - anchor.start) / Math.max(squashed.length, 1);
    const total = (50 * quote + 20 * prefix + 20 * suffix + 2 * position) / 92;
    if (!best || total > best.total)
      best = { start: match.start, end: match.end, total, quote, context: Math.max(prefix, suffix) };
  }
  if (!best || best.quote < 0.7 || best.context < 0.5) return { state: "orphaned", anchor };
  return { state: "fuzzy", anchor: anchorFromRange(squashed, best.start, best.end, anchor.exact) };
}

function bestExact(squashed: string, needle: string, anchor: TextAnchor): number | undefined {
  const hits: number[] = [];
  for (let at = squashed.indexOf(needle); at !== -1; at = squashed.indexOf(needle, at + 1)) hits.push(at);
  if (hits.length === 0) return undefined;
  const contextAt = (at: number) => ({
    prefix: similarity(squashed.slice(Math.max(0, at - anchor.prefix.length), at), anchor.prefix),
    suffix: similarity(squashed.slice(at + needle.length, at + needle.length + anchor.suffix.length), anchor.suffix)
  });
  if (hits.length === 1) {
    // Where the quote was there more than once, the copy left may be another one than the copy that was commented on,
    // when that one was rewritten. Only what is around it can say, as it does for a light edit.
    if (!anchor.repeated) return hits[0];
    const { prefix, suffix } = contextAt(hits[0]!);
    return Math.max(prefix, suffix) >= 0.5 ? hits[0] : undefined;
  }
  const scored = hits
    .map(at => {
      const { prefix, suffix } = contextAt(at);
      return { at, score: prefix + suffix - Math.abs(at - anchor.start) / Math.max(squashed.length, 1) };
    })
    .sort((a, b) => b.score - a.score);
  // Repeated phrases with no context to tell them apart: refuse to guess.
  return scored[0]!.score - scored[1]!.score > 0.05 ? scored[0]!.at : undefined;
}

function similarity(actual: string, expected: string): number {
  if (expected.length === 0) return 1;
  if (actual.length === 0) return 0;
  const matches = approxSearch(actual, expected, Math.min(256, expected.length));
  if (matches.length === 0) return 0;
  return 1 - Math.min(...matches.map(match => match.errors)) / expected.length;
}

export function hashText(text: string): string {
  // Only compares a block across revisions; not a security boundary.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface AnchorableBlock {
  readonly ref: string;
  readonly type: string;
  readonly markdown: string;
  readonly preview: string;
}

export function anchorFromBlock(block: AnchorableBlock): BlockAnchor {
  return { kind: "block", ref: block.ref, type: block.type, hash: hashText(block.markdown), preview: block.preview };
}

export function relocateBlockAnchor(
  anchor: BlockAnchor,
  blocks: readonly AnchorableBlock[]
): { state: AnchorState; anchor: BlockAnchor } {
  const same = blocks.filter(block => hashText(block.markdown) === anchor.hash);
  const exact = same.find(block => block.ref === anchor.ref) ?? (same.length === 1 ? same[0] : undefined);
  if (exact) return { state: "exact", anchor: { ...anchor, ref: exact.ref } };
  const inPlace = blocks.find(block => block.ref === anchor.ref && block.type === anchor.type);
  if (inPlace) return { state: "fuzzy", anchor: { ...anchorFromBlock(inPlace) } };
  return { state: "orphaned", anchor };
}
