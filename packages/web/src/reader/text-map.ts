/**
 * Maps the reader's DOM onto the server's coordinates: offsets count non-whitespace characters of the
 * visible text. Decoration such as buttons and captions carries `data-pandocs-nontext` and is skipped.
 */
const EXCLUDED =
  "[data-pandocs-nontext], button, svg, style, script, .rp-header-anchor, .rp-codeblock__title, .rp-llms-container, .rp-prompt__header, .katex, .katex-error";
const WHITESPACE = /\s/u;

export interface TextSegment {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

export interface TextMap {
  readonly segments: readonly TextSegment[];
  readonly length: number;
}

function nonWhitespaceLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (!WHITESPACE.test(text.charAt(i))) count += 1;
  return count;
}

export function buildTextMap(root: Element): TextMap {
  const segments: TextSegment[] = [];
  let length = 0;
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const size = nonWhitespaceLength(node.nodeValue ?? "");
      if (size > 0) {
        segments.push({ node: node as Text, start: length, end: length + size });
        length += size;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || (node as Element).matches(EXCLUDED)) return;
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return { segments, length };
}

/** Where a DOM boundary falls in server coordinates; also works for boundaries that sit on elements. */
export function offsetAt(map: TextMap, root: Element, container: Node, offset: number): number {
  const boundary = root.ownerDocument.createRange();
  boundary.setStart(container, offset);
  boundary.collapse(true);
  let count = 0;
  for (const segment of map.segments) {
    if (segment.node === container)
      return segment.start + nonWhitespaceLength((segment.node.nodeValue ?? "").slice(0, offset));
    if (boundary.comparePoint(segment.node, 0) >= 0) break;
    count = segment.end;
  }
  return count;
}

export function rangeFor(map: TextMap, root: Element, start: number, end: number): Range | null {
  if (end <= start) return null;
  const locate = (target: number, edge: "start" | "end"): { node: Text; offset: number } | null => {
    for (const segment of map.segments) {
      const inside =
        edge === "start"
          ? target >= segment.start && target < segment.end
          : target > segment.start && target <= segment.end;
      if (!inside) continue;
      const text = segment.node.nodeValue ?? "";
      let seen = segment.start;
      for (let i = 0; i < text.length; i += 1) {
        if (WHITESPACE.test(text.charAt(i))) continue;
        if (edge === "start" && seen === target) return { node: segment.node, offset: i };
        seen += 1;
        if (edge === "end" && seen === target) return { node: segment.node, offset: i + 1 };
      }
    }
    return null;
  };
  const from = locate(start, "start");
  const to = locate(end, "end");
  if (!from || !to) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

export interface CapturedSelection {
  readonly start: number;
  readonly end: number;
  readonly exact: string;
  readonly rect: DOMRect | null;
}

export function captureSelection(root: Element, selection: Selection | null): CapturedSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const map = buildTextMap(root);
  const start = offsetAt(map, root, range.startContainer, range.startOffset);
  const end = offsetAt(map, root, range.endContainer, range.endOffset);
  if (end <= start) return null;
  const exact = selection.toString().trim();
  if (!exact) return null;
  return {
    start,
    end,
    exact,
    rect: typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null
  };
}
