import domino from "@mixmark-io/domino";
import { t } from "@pandocs/i18n";
import { createSlugger, outlineOf, parseDocument } from "@pandocs/markdown";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { givenNumber, withoutGivenNumbers } from "./ooxml.js";

const { createDocument } = domino as unknown as { createDocument(html: string): Document };

/** The DOM on the server side has lists that cannot be spread. */
const listOf = <T>(list: ArrayLike<unknown>): T[] => Array.from({ length: list.length }, (_, at) => list[at] as T);

const BYTE_ORDER_MARKS: readonly (readonly [string, readonly number[]])[] = [
  ["utf-8", [0xef, 0xbb, 0xbf]],
  ["utf-16le", [0xff, 0xfe]],
  ["utf-16be", [0xfe, 0xff]]
];

/**
 * The encoding an HTML page declares in its first bytes, if the decoder knows it. A page whose declaration could be
 * read this way is not in UTF-16 whatever it says, which is why browsers take that as UTF-8.
 */
export function declaredEncoding(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const label = /<meta\b[^>]*?charset\s*=\s*["']?([\w.:-]+)/iu.exec(head)?.[1];
  try {
    const encoding = label ? new TextDecoder(label).encoding : undefined;
    return encoding?.startsWith("utf-16") ? "utf-8" : encoding;
  } catch {
    return undefined;
  }
}

/** UTF-16 without its mark: text has no zero bytes, and in UTF-16 every other byte of Latin text is one. */
function sixteenBits(bytes: Uint8Array): string | undefined {
  let even = 0;
  let odd = 0;
  for (let at = 0; at < Math.min(bytes.length, 4096); at += 1) {
    if (bytes[at] !== 0) continue;
    if (at % 2 === 0) even += 1;
    else odd += 1;
  }
  if (odd > 4 * even) return "utf-16le";
  if (even > 4 * odd) return "utf-16be";
  return undefined;
}

/**
 * Text files do not say how they are encoded. A byte order mark settles it, as does what a page declares; otherwise
 * UTF-8 is what anything recent writes, and GB18030 is what Excel and Notepad on a Chinese Windows still save in. Text
 * that is none of these is read as UTF-8 with what does not fit replaced. A guess is said in a warning. Text can hold
 * no zero characters, which the database refuses, so any left are dropped.
 */
export function decodeText(bytes: Uint8Array, warnings: string[], declared?: string): string {
  const read = (encoding: string, options?: TextDecoderOptions) =>
    new TextDecoder(encoding, options).decode(bytes).replaceAll("\0", "");
  const guessed = (encoding: string, name: string) => {
    const text = read(encoding, { fatal: true });
    warnings.push(
      t(
        "The file does not say how its text is encoded, so it was read as {0}. If the text looks wrong, save the file as UTF-8 and import it again.",
        name
      )
    );
    return text;
  };
  const marked = BYTE_ORDER_MARKS.find(([, mark]) => mark.every((byte, at) => bytes[at] === byte));
  // The decoder drops the mark itself.
  if (marked) return read(marked[0]);
  if (declared && declared !== "utf-8") return read(declared);
  const wide = sixteenBits(bytes);
  try {
    return wide ? guessed(wide, "UTF-16") : read("utf-8", { fatal: true });
  } catch {}
  try {
    return guessed("gb18030", "GB18030");
  } catch {}
  warnings.push(t("Some of the text could not be read and shows as �. Save the file as UTF-8 and import it again."));
  return read("utf-8");
}

/** The conversion all HTML gets here, for those who have more rules of their own to add. */
export function createHtmlConverter(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*"
  });
  service.use(gfm);
  service.remove([
    "script",
    "style",
    "noscript",
    "iframe",
    "object",
    "embed",
    "head",
    "title",
    "meta",
    "link"
  ] as never);
  // Word's tables have no header row, and the plugin leaves those as raw HTML. Markdown tables have to have one, so the first row takes that place.
  service.addRule("anyTable", {
    filter: "table",
    replacement(_content, node) {
      const rows = listOf<HTMLTableRowElement>((node as unknown as HTMLTableElement).querySelectorAll("tr")).map(row =>
        listOf<Element>(row.children).flatMap(cell => {
          const text = service
            .turndown((cell as HTMLElement).innerHTML)
            .replaceAll("|", "\\|")
            .replace(/\s*\n+\s*/gu, "<br>");
          const span = Number(cell.getAttribute("colspan") ?? 1);
          return [text, ...Array.from({ length: Math.max(0, span - 1) }, () => "")];
        })
      );
      const width = Math.max(0, ...rows.map(row => row.length));
      if (width === 0) return "";
      const line = (row: readonly string[]) =>
        `| ${Array.from({ length: width }, (_, at) => row[at] ?? "").join(" | ")} |`;
      return `\n\n${[line(rows[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n")}\n\n`;
    }
  });
  return service;
}

const HEADING = /^H[1-6]$/u;
const HEADING_MARKS = /\uE002\d+\uE003[ \t]*/gu;

/** The heading an element in a page stands for: itself, one it is inside or wraps, or one it is an empty mark just before. */
function headingFor(element: Element | undefined): Element | undefined {
  for (let at: Element | null | undefined = element; at; at = at.parentElement) if (HEADING.test(at.tagName)) return at;
  for (let at = element?.firstElementChild; at; at = at.firstElementChild) if (HEADING.test(at.tagName)) return at;
  for (let at: Element | null | undefined = element; at && !at.textContent?.trim(); at = at.parentElement) {
    const next = at.nextElementSibling;
    if (next) return HEADING.test(next.tagName) ? next : undefined;
  }
  return undefined;
}

function fragment(href: string): string {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

function forgetGivenNumbers(node: Node): void {
  if (node.nodeType === 3) node.nodeValue = withoutGivenNumbers(node.nodeValue ?? "");
  else for (const child of listOf<Node>(node.childNodes)) forgetGivenNumbers(child);
}

/**
 * HTML as Markdown. A link within the page leads to an id, and Markdown has none: a heading is reached by the slug its
 * text gives. So a link to a heading, or to a mark that stands for one, as Word's bookmarks do, is pointed at that
 * slug; any other is left as it was. A list Word numbered starts at the number Word gave it.
 */
export function htmlToMarkdown(html: string): string {
  const document = createDocument(html);
  if (html.includes("\uE000")) {
    for (const list of listOf<Element>(document.getElementsByTagName("ol"))) {
      const start = givenNumber(
        listOf<Element>(list.children).find(child => child.tagName === "LI")?.textContent ?? ""
      );
      if (start !== undefined && start !== 1) list.setAttribute("start", String(start));
    }
    forgetGivenNumbers(document.body);
  }
  const targets = new Map<string, Element>();
  for (const element of listOf<Element>(document.querySelectorAll("[id], a[name]"))) {
    for (const name of [element.getAttribute("id"), element.tagName === "A" ? element.getAttribute("name") : null]) {
      if (name && !targets.has(name)) targets.set(name, element);
    }
  }
  const headings = new Map<Element, number>();
  const links: { heading: number; href: string }[] = [];
  for (const link of listOf<Element>(document.querySelectorAll("a[href^='#']"))) {
    const href = link.getAttribute("href")!;
    const heading = headingFor(targets.get(fragment(href)));
    if (!heading?.textContent?.trim()) continue;
    if (!headings.has(heading)) {
      headings.set(heading, headings.size);
      heading.insertBefore(document.createTextNode(`\uE002${headings.size - 1}\uE003`), heading.firstChild);
    }
    link.setAttribute("href", `#\uE004${links.length}\uE005`);
    links.push({ heading: headings.get(heading)!, href });
  }
  const markdown = createHtmlConverter().turndown(document.body);
  if (links.length === 0) return markdown;
  // Slugs as the page will give them, the same text twice getting a number.
  const slug = createSlugger();
  const slugs = new Map<number, string>();
  for (const entry of outlineOf(parseDocument(markdown))) {
    const given = slug(entry.text.replace(HEADING_MARKS, "").trim());
    const mark = /\uE002(\d+)\uE003/u.exec(entry.text)?.[1];
    if (mark !== undefined) slugs.set(Number(mark), given);
  }
  // A heading Markdown cannot hold as one, such as in a table, keeps the link as it was.
  return markdown
    .replace(/\uE004(\d+)\uE005/gu, (_, at: string) => {
      const link = links[Number(at)]!;
      return slugs.get(link.heading) ?? link.href.slice(1).replace(/([()])/gu, "\\$1");
    })
    .replace(HEADING_MARKS, "");
}

/**
 * What would mean something in Markdown or HTML, where a cell holds it as text: a status in angle brackets, a code with
 * asterisks, an example link. Escaped, a cell shows what it holds. A colon only starts something before a name, and an
 * ampersand before an entity, so a time of day or "R&D" is left as written.
 */
const MARKUP = /[\\`*_[\]<>~^$|]|:(?=[a-z])|&(?=#?[\da-z]+;)/giu;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    value instanceof Date
      ? value
          .toISOString()
          .replace(/T00:00:00\.000Z$/u, "")
          .replace("T", " ")
          .replace(/\.000Z$/u, "")
      : String(value);
  return text.trim().replace(MARKUP, "\\$&").replace(/\r?\n/gu, "<br>");
}

/** A table has to have one header row, so a sheet's first row takes that place. */
export function toTable(rows: readonly (readonly unknown[])[]): string {
  const filled = rows.filter(row =>
    row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== "")
  );
  if (filled.length === 0) return "";
  const width = Math.max(...filled.map(row => row.length));
  const line = (row: readonly unknown[]) =>
    `| ${Array.from({ length: width }, (_, at) => cellText(row[at])).join(" | ")} |`;
  return [
    line(filled[0]!),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...filled.slice(1).map(line)
  ].join("\n");
}

export function parseDelimited(text: string): string[][] {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  const delimiter = [",", "\t", ";"]
    .map(item => ({ item, count: firstLine.split(item).length }))
    .sort((a, b) => b.count - a.count)[0]!.item;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at]!;
    if (quoted) {
      if (character === '"' && text[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[at + 1] === "\n") at += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
