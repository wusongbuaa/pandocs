import { diffChars } from "diff";
import type { Element, Root, RootContent } from "hast";

export type DiffRow =
  | { readonly kind: "same"; readonly text: string }
  | { readonly kind: "added"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string }
  | { readonly kind: "changed"; readonly before: string; readonly after: string };

/** Longest common subsequence over whole blocks: a document is a list of them, and few change at a time. */
export function diffBlocks(before: readonly string[], after: readonly string[]): DiffRow[] {
  const lengths = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        before[i] === after[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({ kind: "same", text: before[i]! });
      i += 1;
      j += 1;
    } else if (j >= after.length || (i < before.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      rows.push({ kind: "removed", text: before[i]! });
      i += 1;
    } else {
      rows.push({ kind: "added", text: after[j]! });
      j += 1;
    }
  }
  return pairChanges(rows);
}

/** A block removed right before one was added is usually the same block rewritten. */
function pairChanges(rows: readonly DiffRow[]): DiffRow[] {
  const paired: DiffRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const next = rows[index + 1];
    if (row.kind === "removed" && next?.kind === "added") {
      paired.push({ kind: "changed", before: row.text, after: next.text });
      index += 1;
    } else {
      paired.push(row);
    }
  }
  return paired;
}

export type CollapsedRow = DiffRow | { readonly kind: "collapsed"; readonly count: number };

/** Long runs of untouched blocks fold away, keeping one on each side of a change for context. */
export function collapseUnchanged(rows: readonly DiffRow[], context = 1): CollapsedRow[] {
  const keep = rows.map(row => row.kind !== "same");
  const near = rows.map((_, index) => keep.slice(Math.max(0, index - context), index + context + 1).some(Boolean));
  const out: CollapsedRow[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (near[index]) {
      if (hidden > 0) out.push({ kind: "collapsed", count: hidden });
      hidden = 0;
      out.push(row);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) out.push({ kind: "collapsed", count: hidden });
  return out;
}

export function textOfHast(node: Root | RootContent): string {
  if (node.type === "text") return node.value;
  return "children" in node ? (node.children as RootContent[]).map(textOfHast).join("") : "";
}

/** Wraps the given character ranges of the rendered text in `<mark>`, across however many text nodes they span. */
export function markRanges(tree: Root, ranges: readonly (readonly [number, number])[], className: string): void {
  let offset = 0;
  const walk = (parent: Root | Element) => {
    const next: RootContent[] = [];
    for (const child of parent.children as RootContent[]) {
      if (child.type !== "text") {
        if (child.type === "element") {
          // The heading's `#` and other decoration are not part of what changed.
          if (![child.properties?.class, child.properties?.className].flat().includes("rp-header-anchor")) walk(child);
        }
        next.push(child);
        continue;
      }
      const start = offset;
      const end = offset + child.value.length;
      offset = end;
      let at = start;
      for (const [from, to] of ranges) {
        if (to <= at || from >= end) continue;
        const left = Math.max(from, at);
        const right = Math.min(to, end);
        if (left > at) next.push({ type: "text", value: child.value.slice(at - start, left - start) });
        next.push({
          type: "element",
          tagName: "mark",
          properties: { className: [className] },
          children: [{ type: "text", value: child.value.slice(left - start, right - start) }]
        });
        at = right;
      }
      if (at < end) next.push({ type: "text", value: child.value.slice(at - start) });
    }
    parent.children = next as typeof parent.children;
  };
  walk(tree);
}

/** Only worth marking words when most of the block survived; otherwise it reads as noise, and the whole block is the change. */
export function wordChanges(
  before: string,
  after: string
): { removed: [number, number][]; added: [number, number][] } | null {
  const parts = diffChars(before, after);
  const kept = parts.filter(part => !part.added && !part.removed).reduce((sum, part) => sum + part.value.length, 0);
  if (kept < Math.max(before.length, after.length) * 0.4) return null;
  const removed: [number, number][] = [];
  const added: [number, number][] = [];
  let inBefore = 0;
  let inAfter = 0;
  for (const part of parts) {
    if (part.added) {
      added.push([inAfter, inAfter + part.value.length]);
      inAfter += part.value.length;
    } else if (part.removed) {
      removed.push([inBefore, inBefore + part.value.length]);
      inBefore += part.value.length;
    } else {
      inBefore += part.value.length;
      inAfter += part.value.length;
    }
  }
  return { removed, added };
}
