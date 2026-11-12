export type BlockAttributes = Record<string, string>;

const ATTRIBUTE = /([.#])([^\s{}.#="'<>`]+)|([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`{}]+)))?/gu;

/** Accepts every form the generic directive syntax allows; `formatAttributes` only ever writes `k="v"`. */
export function parseAttributes(source: string | undefined): BlockAttributes {
  const attrs: BlockAttributes = {};
  const classes: string[] = [];
  for (const match of (source ?? "").matchAll(ATTRIBUTE)) {
    if (match[1] === ".") classes.push(match[2]!);
    else if (match[1] === "#") attrs.id = match[2]!;
    else attrs[match[3]!] = decodeEntities(match[4] ?? match[5] ?? match[6] ?? "");
  }
  if (classes.length > 0) attrs.class = [attrs.class, ...classes].filter(Boolean).join(" ");
  return attrs;
}

export function formatAttributes(attrs: Readonly<Record<string, string | null | undefined>>): string {
  const entries = Object.entries(attrs).filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${encodeEntities(value)}"`).join(" ")}}`;
}

function encodeEntities(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

function decodeEntities(value: string): string {
  return value.replace(/&quot;/gu, '"').replace(/&amp;/gu, "&");
}
