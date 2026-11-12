import type { Nodes, Root } from "mdast";

const CONTENT = "[A-Za-z0-9+\\-=()]{1,16}";

/**
 * `x^2^` and `H~2~O`. Letters and digits only, because `~` also writes ranges in Chinese text: `1~3 天，5~7 天`
 * and `北京~上海~广州` must stay as they are. `10~20~30` is a range too, so a digit before `~` rules it out.
 */
const MARKS = new RegExp(`\\^(${CONTENT})\\^|(?<![0-9~])~(${CONTENT})~(?!~)`, "gu");

/** The same two forms for parsers that read from the current position. */
export const SUPERSCRIPT_AT_START = new RegExp(`^\\^(${CONTENT})\\^`, "u");
export const SUBSCRIPT_AT_START = new RegExp(`^~(${CONTENT})~(?!~)`, "u");

const CHARACTER_REFERENCE = /^&(?:#(\d{1,7})|#x([\da-f]{1,6})|[a-z][a-z\d]{0,31});/iu;

/**
 * Where a text node's value has a character written as `\^` or as a character reference. Those are text, as the editor
 * reads them, so they never mark anything. The parser has already turned them into the plain character, so they are
 * found by walking the node's source alongside its value.
 */
function writtenAsText(value: string, source: string): Set<number> {
  const found = new Set<number>();
  if (source === value) return found;
  let at = 0;
  for (let index = 0; index < value.length && at < source.length;) {
    if (source[at] === "\\" && source[at + 1] === value[index] && /[!-/:-@[-`{-~]/u.test(value[index]!)) {
      found.add(index);
      at += 2;
      index += 1;
      continue;
    }
    const reference = source[at] === "&" ? CHARACTER_REFERENCE.exec(source.slice(at, at + 40)) : null;
    if (reference && !value.startsWith(reference[0], index)) {
      const code = reference[1] ?? reference[2];
      found.add(index);
      at += reference[0].length;
      index += code === undefined ? 1 : String.fromCodePoint(Math.min(Number.parseInt(code, reference[1] ? 10 : 16), 0x10ffff)).length;
      continue;
    }
    if (source[at] === value[index]) index += 1;
    at += 1;
  }
  return found;
}

function split(value: string, asText: ReadonlySet<number>): Nodes[] | null {
  const parts: Nodes[] = [];
  let at = 0;
  const marks = new RegExp(MARKS);
  for (let match = marks.exec(value); match; match = marks.exec(value)) {
    if (asText.has(match.index) || asText.has(match.index + match[0].length - 1)) {
      marks.lastIndex = match.index + 1;
      continue;
    }
    if (match.index > at) parts.push({ type: "text", value: value.slice(at, match.index) });
    const superscript = match[1] !== undefined;
    parts.push({
      type: superscript ? "superscript" : "subscript",
      data: { hName: superscript ? "sup" : "sub" },
      children: [{ type: "text", value: superscript ? match[1]! : match[2]! }]
    } as unknown as Nodes);
    at = match.index + match[0].length;
  }
  if (parts.length === 0) return null;
  if (at < value.length) parts.push({ type: "text", value: value.slice(at) });
  return parts;
}

/** Runs in the shared dialect pass, so the markers are gone from the text both the server and the reader count. */
export function applySuperSub(node: Root | Nodes, source = ""): void {
  if (!("children" in node)) return;
  const children: Nodes[] = [];
  let changed = false;
  for (const child of node.children as Nodes[]) {
    const written = child.position ? source.slice(child.position.start.offset, child.position.end.offset) : "";
    const parts = child.type === "text" ? split(child.value, written ? writtenAsText(child.value, written) : new Set()) : null;
    if (parts) {
      children.push(...parts);
      changed = true;
    } else {
      applySuperSub(child, source);
      children.push(child);
    }
  }
  if (changed) (node as { children: Nodes[] }).children = children;
}
