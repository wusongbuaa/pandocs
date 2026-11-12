import type { Nodes } from "mdast";

/**
 * How deep a page's tree may go. Real pages stay far below it. Past it, walking the tree runs out of stack on some threads
 * and not on others, so one reader of a page would see it and another fail.
 */
export const MOST_TREE_DEPTH = 256;

/**
 * How deep each kind of nesting may go before parsing starts. Parsing nested containers and emphasis takes time in
 * proportion to the square of the depth, so a page a few kilobytes long could otherwise hold a server up for seconds.
 * Lists nested by indenting cost more room per level, and past this many levels the tree is too deep anyway.
 */
const MOST_MARKERS_ON_A_LINE = 32;
const MOST_LIST_LEVELS = MOST_TREE_DEPTH / 2;
const MOST_OPEN_CONTAINERS = 16;
const MOST_NESTED_DELIMITERS = 128;

const OPENS_CONTAINER = /^:{3,}[ \t]*[a-zA-Z]/u;
const CLOSES_CONTAINER = /^:{3,}[ \t]*$/u;
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/u;
const SPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;

/**
 * Whether a page nests deeper than anyone writes, decided from its text in one pass, before any parsing: quotes and lists,
 * started on one line or indented level by level, `:::` containers left open inside each other, and emphasis or
 * strikethrough inside each other.
 */
export function nestsTooDeeply(markdown: string): boolean {
  let open = 0;
  let paragraph: string[] = [];
  for (const line of markdown.split(/\r\n|\r|\n/u)) {
    let at = 0;
    let markers = 0;
    // All of it, also after a `>`: a list indented inside a quote nests as deeply as one that is not.
    let indent = 0;
    for (;;) {
      for (; line[at] === " " || line[at] === "\t"; at += 1) indent += line[at] === "\t" ? 4 : 1;
      if (line[at] === ">") {
        at += 1;
      } else {
        const marker = LIST_MARKER.exec(line.slice(at, at + 11));
        if (!marker) break;
        at += marker[0].length;
      }
      markers += 1;
      if (markers > MOST_MARKERS_ON_A_LINE) return true;
    }
    // Each level of a list indents by two columns at least.
    if (markers > 0 && Math.floor(indent / 2) + markers > MOST_LIST_LEVELS) return true;
    const rest = line.slice(at);
    if (OPENS_CONTAINER.test(rest)) open += 1;
    else if (CLOSES_CONTAINER.test(rest)) open = Math.max(0, open - 1);
    if (open > MOST_OPEN_CONTAINERS) return true;
    if (rest.trim() === "") {
      if (nestedDelimiters(paragraph.join("\n")) > MOST_NESTED_DELIMITERS) return true;
      paragraph = [];
    } else {
      paragraph.push(rest);
    }
  }
  return nestedDelimiters(paragraph.join("\n")) > MOST_NESTED_DELIMITERS;
}

/**
 * How deep emphasis and strikethrough delimiters that pair up sit inside each other, counted in characters: `**` inside
 * `*` is three. Runs pair the way CommonMark pairs them, closest first; one that can both open and close closes if it can.
 * Ones that never pair, such as the stars of pointers in code, count for nothing.
 */
function nestedDelimiters(text: string): number {
  const runs: { readonly length: number; readonly opens: boolean; readonly closes: boolean }[] = [];
  for (let at = 0; at < text.length;) {
    const char = text[at]!;
    if (char !== "*" && char !== "_" && char !== "~") {
      at += 1;
      continue;
    }
    let end = at;
    while (text[end] === char) end += 1;
    const before = at === 0 ? " " : text[at - 1]!;
    const after = end === text.length ? " " : text[end]!;
    const left = !SPACE.test(after) && (!PUNCTUATION.test(after) || SPACE.test(before) || PUNCTUATION.test(before));
    const right = !SPACE.test(before) && (!PUNCTUATION.test(before) || SPACE.test(after) || PUNCTUATION.test(after));
    // An underscore inside a word neither opens nor closes.
    const opens = char === "_" ? left && (!right || PUNCTUATION.test(before)) : left;
    const closes = char === "_" ? right && (!left || PUNCTUATION.test(after)) : right;
    if (opens || closes) runs.push({ length: end - at, opens, closes });
    at = end;
  }
  const opened = runs.map(() => 0);
  const closed = runs.map(() => 0);
  const stack: { index: number; left: number }[] = [];
  for (const [index, run] of runs.entries()) {
    let left = run.length;
    if (run.closes) {
      while (left > 0 && stack.length > 0) {
        const top = stack.at(-1)!;
        const taken = Math.min(left, top.left);
        opened[top.index]! += taken;
        closed[index]! += taken;
        top.left -= taken;
        left -= taken;
        if (top.left === 0) stack.pop();
      }
    }
    if (left > 0 && run.opens) stack.push({ index, left });
  }
  let depth = 0;
  let most = 0;
  for (const index of runs.keys()) {
    depth -= closed[index]!;
    depth += opened[index]!;
    most = Math.max(most, depth);
  }
  return most;
}

/** Without recursion, which is the point. */
export function treeDepth(root: Nodes): number {
  let most = 0;
  const pending: [Nodes, number][] = [[root, 0]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [node, depth] = next;
    if (depth > most) most = depth;
    if ("children" in node) for (const child of node.children) pending.push([child as Nodes, depth + 1]);
  }
  return most;
}

/** What running out of stack looks like, which is not always a `RangeError`: a regular expression compiled then fails to. */
export function outOfStack(error: unknown): boolean {
  return error instanceof Error && /call stack/iu.test(error.message);
}
