import { t } from "@pandocs/i18n";
import { z } from "zod";
import { parseDocument } from "./parse.js";
import type { BlockRegistry } from "./registry.js";
import { topLevelBlocks, type SourceBlock } from "./structure.js";

const blockRef = z.string().regex(/^b[1-9]\d*$/u, { error: () => t("A block reference looks like b1") });

export const editOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("str_replace"),
      pattern: z.string().min(1),
      content: z.string(),
      all: z.boolean().optional()
    })
    .strict(),
  z.object({ op: z.literal("block_replace"), ref: blockRef, end: blockRef.optional(), content: z.string() }).strict(),
  z
    .object({
      op: z.literal("block_insert_after"),
      ref: z.union([blockRef, z.literal("start"), z.literal("end")]),
      content: z.string().min(1)
    })
    .strict(),
  z.object({ op: z.literal("block_delete"), ref: blockRef, end: blockRef.optional() }).strict(),
  z
    .object({ op: z.literal("block_move_after"), ref: blockRef, after: z.union([blockRef, z.literal("start")]) })
    .strict()
]);
export type EditOp = z.infer<typeof editOpSchema>;

export class EditOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly opIndex: number
  ) {
    super(message);
    this.name = "EditOpError";
  }
}

interface Splice {
  readonly start: number;
  readonly end: number;
  readonly insert: string;
  readonly opIndex: number;
}

/**
 * All refs address the same base revision, so ops turn into offset splices against that base and
 * apply back to front. The caller's `expectedRevision` is what keeps the refs honest.
 */
export function applyEditOps(markdown: string, ops: readonly EditOp[], registry?: BlockRegistry): string {
  const blocks = topLevelBlocks(parseDocument(markdown, registry));
  const splices = ops.flatMap((op, index) => toSplices(markdown, blocks, op, index));
  const ordered = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.start < ordered[i - 1]!.end) {
      throw new EditOpError(
        "OPS_OVERLAP",
        t("Several operations change the same content. Merge them into one."),
        ordered[i]!.opIndex
      );
    }
  }
  let result = markdown;
  for (const splice of [...ordered].reverse()) {
    result = result.slice(0, splice.start) + splice.insert + result.slice(splice.end);
  }
  return `${result.replace(/\n{3,}$/u, "\n").trimEnd()}\n`;
}

function toSplices(markdown: string, blocks: readonly SourceBlock[], op: EditOp, opIndex: number): Splice[] {
  const find = (ref: string): SourceBlock => {
    const block = blocks.find(item => item.ref === ref);
    if (!block)
      throw new EditOpError("BLOCK_NOT_FOUND", t("Block {0} not found. Read the latest version again.", ref), opIndex);
    return block;
  };
  const range = (ref: string, end: string | undefined): [SourceBlock, SourceBlock] => {
    const first = find(ref);
    const last = end ? find(end) : first;
    if (last.start < first.start)
      throw new EditOpError("RANGE_INVALID", t("The end block comes before the start block"), opIndex);
    return [first, last];
  };
  switch (op.op) {
    case "str_replace": {
      const matches: number[] = [];
      for (let at = markdown.indexOf(op.pattern); at !== -1; at = markdown.indexOf(op.pattern, at + op.pattern.length))
        matches.push(at);
      if (matches.length === 0)
        throw new EditOpError(
          "PATTERN_NOT_FOUND",
          t("Text to replace not found: {0}", op.pattern.slice(0, 40)),
          opIndex
        );
      if (matches.length > 1 && !op.all) {
        throw new EditOpError(
          "PATTERN_AMBIGUOUS",
          t("The text to replace appears {0} times. Make it more specific, or set all.", matches.length),
          opIndex
        );
      }
      return matches.map(start => ({ start, end: start + op.pattern.length, insert: op.content, opIndex }));
    }
    case "block_replace": {
      const [first, last] = range(op.ref, op.end);
      return [{ start: first.start, end: last.end, insert: op.content.trim(), opIndex }];
    }
    case "block_insert_after":
      return [
        insertion(
          markdown,
          blocks,
          op.ref === "start" || op.ref === "end" ? op.ref : find(op.ref),
          op.content.trim(),
          opIndex
        )
      ];
    case "block_delete": {
      const [first, last] = range(op.ref, op.end);
      return [removal(markdown, blocks, first, last, opIndex)];
    }
    case "block_move_after": {
      const source = find(op.ref);
      const target = op.after === "start" ? "start" : find(op.after);
      if (target === source) throw new EditOpError("RANGE_INVALID", t("A block cannot move after itself"), opIndex);
      const content = markdown.slice(source.start, source.end);
      return [
        removal(markdown, blocks, source, source, opIndex),
        insertion(markdown, blocks, target, content, opIndex)
      ];
    }
  }
}

function insertion(
  markdown: string,
  blocks: readonly SourceBlock[],
  at: SourceBlock | "start" | "end",
  content: string,
  opIndex: number
): Splice {
  if (at === "start") {
    const first = blocks[0];
    return first
      ? { start: first.start, end: first.start, insert: `${content}\n\n`, opIndex }
      : { start: markdown.length, end: markdown.length, insert: content, opIndex };
  }
  const offset = at === "end" ? (blocks.at(-1)?.end ?? markdown.length) : at.end;
  return { start: offset, end: offset, insert: offset === 0 ? content : `\n\n${content}`, opIndex };
}

function removal(
  markdown: string,
  blocks: readonly SourceBlock[],
  first: SourceBlock,
  last: SourceBlock,
  opIndex: number
): Splice {
  const next = blocks[blocks.indexOf(last) + 1];
  if (next) return { start: first.start, end: next.start, insert: "", opIndex };
  const previous = blocks[blocks.indexOf(first) - 1];
  return { start: previous ? previous.end : first.start, end: markdown.length, insert: "", opIndex };
}
