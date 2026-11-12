import { parseDocument } from "./parse.js";
import type { BlockRegistry } from "./registry.js";
import { topLevelBlocks } from "./structure.js";

const MOST_COMPARISONS = 4_000_000;

/** Keeps untouched blocks byte-identical: only blocks the editor really changed get re-serialized. */
export function spliceBlocks(source: readonly string[], baseline: readonly string[], current: readonly string[]): string[] {
  const result: string[] = [];
  let at = 0;
  for (const [baselineIndex, currentIndex] of matchIndexes(baseline, current)) {
    result.push(...current.slice(at, currentIndex), source[baselineIndex]!);
    at = currentIndex + 1;
  }
  result.push(...current.slice(at));
  return result;
}

export function joinBlocks(blocks: readonly string[]): string {
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

export function sourceBlocks(markdown: string, registry?: BlockRegistry): string[] {
  return parseDocument(markdown, registry).tree.children
    .filter(node => node.position)
    .map(node => markdown.slice(node.position!.start.offset ?? 0, node.position!.end.offset ?? 0));
}

export interface MergeConflict {
  readonly base: readonly string[];
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
}

export type MergeResult =
  | { readonly ok: true; readonly markdown: string }
  /** `keepingOurs` is the merge with our side taken wherever both changed the same place, for whoever would rather have that than nothing. */
  | { readonly ok: false; readonly conflicts: readonly MergeConflict[]; readonly keepingOurs: string };

type Side = "base" | "ours" | "theirs";

/** A version's blocks, and what stands between them as it was written: a heading and the paragraph under it may have no blank line. */
interface Layout {
  readonly blocks: readonly string[];
  readonly gaps: readonly string[];
  readonly tail: string;
}

/** A block of the merge, and where it stands in each version that has it. */
interface Placed {
  readonly text: string;
  readonly at: Readonly<Partial<Record<Side, number | undefined>>>;
}

function layoutOf(markdown: string, registry?: BlockRegistry): Layout {
  const spans = parseDocument(markdown, registry).tree.children
    .filter(node => node.position)
    .map(node => [node.position!.start.offset ?? 0, node.position!.end.offset ?? 0] as const);
  return {
    blocks: spans.map(([start, end]) => markdown.slice(start, end)),
    gaps: spans.slice(1).map(([start], at) => markdown.slice(spans[at]![1], start)),
    tail: spans.length > 0 ? markdown.slice(spans.at(-1)![1]) : ""
  };
}

/**
 * Blocks next to each other in some version are written with what stood between them there, so a merge changes the
 * text only where the edits are; in a repository, an edit to one block stays a change to that block. Blocks that were
 * never neighbours get a blank line.
 */
function joinPlaced(merged: readonly Placed[], layouts: Readonly<Record<Side, Layout>>): string {
  const sides = ["base", "ours", "theirs"] as const;
  const between = (a: Placed, b: Placed) => {
    for (const side of sides) {
      const at = a.at[side];
      if (at !== undefined && b.at[side] === at + 1) return layouts[side].gaps[at]!;
    }
    return "\n\n";
  };
  const after = (last: Placed) => {
    for (const side of sides) if (last.at[side] === layouts[side].blocks.length - 1) return layouts[side].tail;
    return "\n";
  };
  if (merged.length === 0) return "";
  return `${merged.map((block, at) => (at === 0 ? block.text : `${between(merged[at - 1]!, block)}${block.text}`)).join("")}${after(merged.at(-1)!)}`;
}

/** Block-level three-way merge: different blocks merge on their own, the same block changed twice is a conflict. */
export function mergeThreeWay(base: string, ours: string, theirs: string, registry?: BlockRegistry): MergeResult {
  if (ours === theirs || theirs === base) return { ok: true, markdown: ours };
  if (ours === base) return { ok: true, markdown: theirs };
  const layouts: Record<Side, Layout> = { base: layoutOf(base, registry), ours: layoutOf(ours, registry), theirs: layoutOf(theirs, registry) };
  const baseBlocks = layouts.base.blocks;
  const ourMatches = matchIndexes(baseBlocks, layouts.ours.blocks);
  const theirMatches = matchIndexes(baseBlocks, layouts.theirs.blocks);
  const ourHunks = hunksOf(baseBlocks, layouts.ours.blocks, ourMatches);
  const theirHunks = hunksOf(baseBlocks, layouts.theirs.blocks, theirMatches);
  const fromBase = (from: number, to: number): Placed[] => baseBlocks.slice(from, to).map((text, k) => ({ text, at: { base: from + k, ours: ourMatches.get(from + k), theirs: theirMatches.get(from + k) } }));
  const fromSide = (side: "ours" | "theirs", hunk: Hunk): Placed[] => hunk.content.map((text, k) => ({ text, at: { [side]: hunk.from + k } }));
  const applied = (side: "ours" | "theirs", hunks: readonly Hunk[], start: number, end: number): Placed[] => {
    const result: Placed[] = [];
    let at = start;
    for (const hunk of hunks) {
      result.push(...fromBase(at, hunk.start), ...fromSide(side, hunk));
      at = hunk.end;
    }
    result.push(...fromBase(at, end));
    return result;
  };

  const merged: Placed[] = [];
  const conflicts: MergeConflict[] = [];
  let b = 0;
  let o = 0;
  let t = 0;
  while (o < ourHunks.length || t < theirHunks.length) {
    const ours = ourHunks[o];
    const theirs = theirHunks[t];
    let start: number;
    let end: number;
    let content: readonly Placed[];
    if (ours && theirs && overlaps(ours, theirs)) {
      start = Math.min(ours.start, theirs.start);
      end = Math.max(ours.end, theirs.end);
      const ourCluster = [ours];
      const theirCluster = [theirs];
      o += 1;
      t += 1;
      // One side's edit can span several of the other's; they all belong to the same region.
      for (let grew = true; grew;) {
        grew = false;
        if ((ourHunks[o]?.start ?? Infinity) < end) {
          end = Math.max(end, ourHunks[o]!.end);
          ourCluster.push(ourHunks[o++]!);
          grew = true;
        }
        if ((theirHunks[t]?.start ?? Infinity) < end) {
          end = Math.max(end, theirHunks[t]!.end);
          theirCluster.push(theirHunks[t++]!);
          grew = true;
        }
      }
      const ourRegion = applied("ours", ourCluster, start, end);
      const theirRegion = applied("theirs", theirCluster, start, end);
      const texts = (region: readonly Placed[]) => region.map(block => block.text);
      if (!same(texts(ourRegion), texts(theirRegion))) conflicts.push({ base: baseBlocks.slice(start, end), ours: texts(ourRegion), theirs: texts(theirRegion) });
      content = ourRegion;
    } else if (ours && (!theirs || comesFirst(ours, theirs))) {
      ({ start, end } = ours);
      content = fromSide("ours", ours);
      o += 1;
    } else {
      ({ start, end } = theirs!);
      content = fromSide("theirs", theirs!);
      t += 1;
    }
    merged.push(...fromBase(b, start), ...content);
    b = end;
  }
  merged.push(...fromBase(b, baseBlocks.length));
  const markdown = joinPlaced(merged, layouts);
  return conflicts.length > 0 ? { ok: false, conflicts, keepingOurs: markdown } : { ok: true, markdown };
}

/** One edit: the base blocks in `start..end` became `content`, which starts at block `from` of the other version. An insertion has `start === end`. */
interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly content: readonly string[];
  readonly from: number;
}

function hunksOf(base: readonly string[], other: readonly string[], matches: ReadonlyMap<number, number>): Hunk[] {
  const hunks: Hunk[] = [];
  let baseAt = 0;
  let otherAt = 0;
  const close = (baseEnd: number, otherEnd: number) => {
    // Rewriting n blocks into n is n separate edits, which lets the other side change one of their neighbours.
    if (baseEnd - baseAt === otherEnd - otherAt) {
      for (let k = 0; k < baseEnd - baseAt; k += 1) hunks.push({ start: baseAt + k, end: baseAt + k + 1, content: [other[otherAt + k]!], from: otherAt + k });
    } else {
      hunks.push({ start: baseAt, end: baseEnd, content: other.slice(otherAt, otherEnd), from: otherAt });
    }
  };
  for (const [baseIndex, otherIndex] of matches) {
    close(baseIndex, otherIndex);
    baseAt = baseIndex + 1;
    otherAt = otherIndex + 1;
  }
  close(base.length, other.length);
  return hunks;
}

/** Edits to neighbouring blocks do not touch each other. Two insertions at one spot do, since their order is a choice. */
function overlaps(a: Hunk, b: Hunk): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  return a.start < b.end && b.start < a.end;
}

/**
 * Of two edits that do not overlap, the one to take first. Starting at the same block, one is an insertion before what the
 * other changes, and it goes first: the other way round, the block it was put before would come back after it.
 */
function comesFirst(a: Hunk, b: Hunk): boolean {
  return a.start < b.start || (a.start === b.start && a.end <= b.end);
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Which entries of two lists stay the same, in order. Most changes leave long runs alone at both ends, and those need no
 * comparing of everything with everything. A middle too long to compare counts as all changed, which only costs precision.
 */
function matchIndexes(a: readonly string[], b: readonly string[]): Map<number, number> {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const matches = new Map<number, number>();
  for (let k = 0; k < head; k += 1) matches.set(k, k);
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  if (middleA.length * middleB.length <= MOST_COMPARISONS) {
    const table = lcsTable(middleA, middleB);
    let i = 0;
    let j = 0;
    while (i < middleA.length && j < middleB.length) {
      if (middleA[i] === middleB[j]) {
        matches.set(head + i, head + j);
        i += 1;
        j += 1;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }
  for (let k = tail; k > 0; k -= 1) matches.set(a.length - k, b.length - k);
  return matches;
}

function lcsTable(a: readonly string[], b: readonly string[]): Int32Array[] {
  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

const FRONT_MATTER = /^(\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/u;

/** The editor never sees YAML front matter; it goes back byte for byte on save. */
export function splitFrontMatter(markdown: string): { frontMatter: string; body: string } {
  const match = FRONT_MATTER.exec(markdown);
  return match ? { frontMatter: match[1]!, body: markdown.slice(match[1]!.length).replace(/^\n+/u, "") } : { frontMatter: "", body: markdown };
}

export function joinFrontMatter(frontMatter: string, body: string): string {
  if (!frontMatter) return body;
  return `${frontMatter.endsWith("\n") ? frontMatter : `${frontMatter}\n`}\n${body}`;
}

/** Uses the server's block numbering, whichever parser produced the new text. */
export function opsBetweenMarkdown(base: string, next: string, registry?: BlockRegistry) {
  const slices = (markdown: string) => topLevelBlocks(parseDocument(markdown, registry)).map(block => markdown.slice(block.start, block.end));
  return opsBetweenBlocks(slices(base), slices(next));
}

/** Block-level edit script between two versions, so a proposal can be accepted region by region. */
export function opsBetweenBlocks(base: readonly string[], next: readonly string[]) {
  type Op =
    | { op: "block_replace"; ref: string; end?: string; content: string }
    | { op: "block_insert_after"; ref: string; content: string }
    | { op: "block_delete"; ref: string; end?: string };
  const matches = matchIndexes(base, next);
  const ops: Op[] = [];
  const refOf = (index: number) => `b${index + 1}`;
  let b = 0;
  let n = 0;
  const flush = (bEnd: number, nEnd: number) => {
    const added = next.slice(n, nEnd);
    const removedCount = bEnd - b;
    if (removedCount > 0 && added.length > 0) {
      ops.push({ op: "block_replace", ref: refOf(b), ...(removedCount > 1 ? { end: refOf(bEnd - 1) } : {}), content: added.join("\n\n") });
    } else if (removedCount > 0) {
      ops.push({ op: "block_delete", ref: refOf(b), ...(removedCount > 1 ? { end: refOf(bEnd - 1) } : {}) });
    } else if (added.length > 0) {
      ops.push({ op: "block_insert_after", ref: b === 0 ? "start" : refOf(b - 1), content: added.join("\n\n") });
    }
  };
  for (let k = 0; k < base.length; k += 1) {
    const at = matches.get(k);
    if (at === undefined) continue;
    flush(k, at);
    b = k + 1;
    n = at + 1;
  }
  flush(base.length, next.length);
  return ops;
}
