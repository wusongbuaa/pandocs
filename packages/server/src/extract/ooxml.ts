import { strToU8, unzipSync, zipSync, type Unzipped } from "fflate";

/**
 * What Word, Excel and PowerPoint keep outside the text the converters read: the order a deck plays in, how a cell
 * shows its number, where a Word list counts from. The parts are machine-written XML in a fixed shape, so they are read
 * by pattern rather than parsed whole.
 */

const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : "");

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
export const unescapeXml = (text: string) => text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (whole, entity: string) => {
  if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
  if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
  return XML_ENTITIES[entity.toLowerCase()] ?? whole;
});

const attribute = (tag: string, name: string): string | undefined => {
  const value = new RegExp(`\\s${name}="([^"]*)"`, "u").exec(tag)?.[1];
  return value === undefined ? undefined : unescapeXml(value);
};

/** A part's relationships by id, each leading to a path inside the package. */
function relationships(files: Unzipped, part: string): Map<string, string> {
  const folder = part.slice(0, part.lastIndexOf("/") + 1);
  const found = new Map<string, string>();
  for (const [tag] of decode(files[`${folder}_rels/${part.slice(folder.length)}.rels`]).matchAll(/<(?:\w+:)?Relationship\b[^>]*>/gu)) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (!id || !target || attribute(tag, "TargetMode") === "External") continue;
    const path: string[] = [];
    for (const step of (target.startsWith("/") ? target : folder + target).split("/")) {
      if (step === "..") path.pop();
      else if (step && step !== ".") path.push(step);
    }
    found.set(id, path.join("/"));
  }
  return found;
}

export const POWERPOINT_PARTS = /^ppt\/(?:slides\/slide\d+\.xml|presentation\.xml|_rels\/presentation\.xml\.rels)$/u;

/**
 * The slides in the order the deck plays them, as presentation.xml lists them. Moving a slide does not rename its file,
 * so the file names give the order the slides were made in. A deck that lists none is read in that order instead.
 */
export function slidesInOrder(files: Unzipped): string[] {
  const slides = Object.keys(files).filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((a, b) => Number(/\d+/u.exec(a)![0]) - Number(/\d+/u.exec(b)![0]));
  const links = relationships(files, "ppt/presentation.xml");
  const listed = [...decode(files["ppt/presentation.xml"]).matchAll(/<p:sldId\b[^>]*>/gu)]
    .map(([tag]) => links.get(attribute(tag, "r:id") ?? ""))
    .filter((name): name is string => name !== undefined && slides.includes(name));
  return listed.length > 0 ? [...new Set(listed)] : slides;
}

/** Excel's own formats, by number, that show a time of day or a percentage. Its own date formats the sheet reader knows. */
const BUILT_IN_FORMATS: Readonly<Record<string, string>> = { 9: "0%", 10: "0.00%", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0" };

/** A format's section for positive numbers, without its colour, locale or condition, which show nothing. */
const positiveSection = (format: string) => (/^(?:"[^"]*"|\\.|[^;])*/u.exec(format)?.[0] ?? "").replace(/\[(?![hms]+\])[^\]]*\]/giu, "");
/** The same with quoted text and escaped characters gone, to see what the format does with the number. */
const withoutLiterals = (section: string) => section.replace(/"[^"]*"|\\.|[_*]./gu, "");

const isPercentage = (section: string) => withoutLiterals(section).includes("%");
/** In a format that has no day or year, m is minutes. */
const isTimeOfDay = (section: string) => {
  const code = withoutLiterals(section);
  return /[hs]/iu.test(code) && !/[dy]/iu.test(code);
};

/**
 * The text a number shows as through a format that makes it a time of day or a percentage: 0.375 is 09:00 or 37.5%.
 * Anything else, `undefined`; the sheet reader already shows dates as dates, and other numbers stay as they are.
 */
export function shownNumber(value: number, format: string): string | undefined {
  const section = positiveSection(format);
  if (isPercentage(section)) {
    const decimals = /\.(0+)/u.exec(withoutLiterals(section))?.[1]?.length ?? 0;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  if (!isTimeOfDay(section) || value < 0) return undefined;
  const decimals = /s+\.(0+)/iu.exec(section)?.[1]?.length ?? 0;
  const ticks = Math.round(value * 86400 * 10 ** decimals);
  const seconds = Math.floor(ticks / 10 ** decimals);
  // Chinese formats write AM/PM as 上午/下午.
  const twelveHour = /AM\/PM|A\/P|\u4e0a\u5348\/\u4e0b\u5348/iu.test(withoutLiterals(section));
  const hour = Math.floor(seconds / 3600) % 24;
  const pad = (number: number, token: string) => String(number).padStart(token.length, "0");
  return section.replace(/"([^"]*)"|\\(.)|[_*].|\[(h+|m+|s+)\]|AM\/PM|A\/P|\u4e0a\u5348\/\u4e0b\u5348|h+|m+|s+|\.0+/giu, (token, quoted?: string, escaped?: string, elapsed?: string) => {
    if (quoted !== undefined) return quoted;
    if (escaped !== undefined) return escaped;
    if (elapsed) return pad(Math.floor(seconds / { h: 3600, m: 60, s: 1 }[elapsed[0]!.toLowerCase() as "h" | "m" | "s"]), elapsed);
    if (/^[_*]/u.test(token)) return "";
    if (token === "\u4e0a\u5348/\u4e0b\u5348") return hour < 12 ? "\u4e0a\u5348" : "\u4e0b\u5348";
    if (/^A/iu.test(token)) return (hour < 12 ? "AM" : "PM").slice(0, token.length === 3 ? 1 : 2);
    if (/^h/iu.test(token)) return pad(twelveHour ? hour % 12 || 12 : hour, token);
    if (/^m/iu.test(token)) return pad(Math.floor(seconds / 60) % 60, token);
    if (/^s/iu.test(token)) return pad(seconds % 60, token);
    return `.${String(ticks % 10 ** decimals).padStart(decimals, "0")}`;
  });
}

const SPREADSHEET_HEAD = /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml)$/u;

export interface ShownCell {
  readonly row: number;
  readonly column: number;
  readonly text: string;
}

const columnNumber = (letters: string) => [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);

/**
 * By sheet name, the cells whose numbers their format shows as a time of day or a percentage, at their row and column
 * from 0, with the text they show. The sheet reader gives such a cell as a bare fraction, or as a date in 1899.
 */
export function shownNumbers(bytes: Uint8Array): Map<string, ShownCell[]> {
  const shown = new Map<string, ShownCell[]>();
  const head = unzipSync(bytes, { filter: file => SPREADSHEET_HEAD.test(file.name) });
  const styles = decode(head["xl/styles.xml"]);
  const formats = new Map<string, string>(Object.entries(BUILT_IN_FORMATS));
  for (const [tag] of styles.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/gu)) {
    const id = attribute(tag, "numFmtId");
    const code = attribute(tag, "formatCode");
    if (id !== undefined && code !== undefined) formats.set(id, code);
  }
  // A cell names its style by its place in this list.
  const cellFormats = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/u.exec(styles)?.[1] ?? "";
  const styleFormats = new Map<string, string>();
  [...cellFormats.matchAll(/<(?:\w+:)?xf\b[^>]*>/gu)].forEach(([tag], index) => {
    const format = formats.get(attribute(tag, "numFmtId") ?? "");
    if (format !== undefined && (isPercentage(positiveSection(format)) || isTimeOfDay(positiveSection(format)))) styleFormats.set(String(index), format);
  });
  if (styleFormats.size === 0) return shown;
  const links = relationships(head, "xl/workbook.xml");
  const sheets = [...decode(head["xl/workbook.xml"]).matchAll(/<(?:\w+:)?sheet\b[^>]*>/gu)].flatMap(([tag]) => {
    const name = attribute(tag, "name");
    const path = links.get(attribute(tag, "r:id") ?? "");
    return name !== undefined && path !== undefined ? [{ name, path }] : [];
  });
  const parts = unzipSync(bytes, { filter: file => sheets.some(sheet => sheet.path === file.name) });
  for (const { name, path } of sheets) {
    const cells: ShownCell[] = [];
    for (const [, attributes = "", content = ""] of decode(parts[path]).matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/gu)) {
      const format = styleFormats.get(attribute(attributes, "s") ?? "");
      const type = attribute(attributes, "t") ?? "n";
      const place = /^([A-Z]+)(\d+)$/u.exec(attribute(attributes, "r") ?? "");
      const value = Number(/<(?:\w+:)?v>([^<]*)</u.exec(content)?.[1] ?? Number.NaN);
      if (format === undefined || type !== "n" || !place || !Number.isFinite(value)) continue;
      const text = shownNumber(value, format);
      if (text !== undefined) cells.push({ row: Number(place[2]) - 1, column: columnNumber(place[1]!) - 1, text });
    }
    shown.set(name, cells);
  }
  return shown;
}

/** Put in front of a numbered Word paragraph's text, holding the number Word shows for it, and taken out with the HTML. */
const listNumber = (value: number) => `\uE000${value}\uE001`;
/** The number given to the paragraph a text starts with, if it was given one. */
export const givenNumber = (text: string): number | undefined => {
  const found = /^\s*\uE000(\d+)\uE001/u.exec(text)?.[1];
  return found === undefined ? undefined : Number(found);
};
export const withoutGivenNumbers = (text: string) => text.replace(/\uE000\d+\uE001/gu, "");

interface ListLevel {
  readonly start: number;
  readonly bullet: boolean;
}

function readNumbering(xml: string) {
  const definitions = new Map<string, Map<number, ListLevel>>();
  for (const [, id = "", content = ""] of xml.matchAll(/<w:abstractNum\b[^>]*?w:abstractNumId="([^"]*)"[^>]*>([\s\S]*?)<\/w:abstractNum>/gu)) {
    const levels = new Map<number, ListLevel>();
    for (const [, level = "", definition = ""] of content.matchAll(/<w:lvl\b[^>]*?w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/gu)) {
      levels.set(Number(level), { start: Number(/<w:start w:val="(\d+)"/u.exec(definition)?.[1] ?? 1), bullet: /<w:numFmt w:val="bullet"/u.test(definition) });
    }
    definitions.set(id, levels);
  }
  // A list in the text names one of these, which names its definition and may restart some of its levels.
  const lists = new Map<string, { definition: string; restarts: Map<number, number> }>();
  for (const [, id = "", content = ""] of xml.matchAll(/<w:num\b[^>]*?w:numId="([^"]*)"[^>]*>([\s\S]*?)<\/w:num>/gu)) {
    const definition = /<w:abstractNumId w:val="([^"]*)"/u.exec(content)?.[1];
    if (definition === undefined) continue;
    const restarts = new Map<number, number>();
    for (const [, level = "", override = ""] of content.matchAll(/<w:lvlOverride\b[^>]*?w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/gu)) {
      const start = /<w:startOverride w:val="(\d+)"/u.exec(override)?.[1];
      if (start !== undefined) restarts.set(Number(level), Number(start));
    }
    lists.set(id, { definition, restarts });
  }
  return { definitions, lists };
}

/** Paragraph styles that number what has them, such as List Number. */
function numberedStyles(xml: string): Map<string, { list: string; level: number }> {
  const found = new Map<string, { list: string; level: number }>();
  for (const [, id = "", content = ""] of xml.matchAll(/<w:style\b[^>]*?w:styleId="([^"]*)"[^>]*>([\s\S]*?)<\/w:style>/gu)) {
    const list = /<w:numId w:val="(\d+)"/u.exec(content)?.[1];
    if (list !== undefined) found.set(id, { list, level: Number(/<w:ilvl w:val="(\d+)"/u.exec(content)?.[1] ?? 0) });
  }
  return found;
}

const WORD_LISTS = /^word\/(?:document|numbering|styles)\.xml$/u;

/** What a paragraph says about its numbering before its text starts, and where that is. */
interface Paragraph {
  style?: string;
  list?: string;
  level?: number;
  textAt?: number;
}

/**
 * Word numbers a list on from where it left off, and from where its definition says to start, while HTML numbers each
 * list from 1: a list that goes on after a note starts over, and one that starts at 5 starts at 1. Each numbered
 * paragraph's text is given the number Word shows for it, for the HTML to pick up. Lists that share a definition count
 * together, as in Word, until one of them restarts it.
 */
export function markListNumbers(bytes: Uint8Array): Uint8Array {
  const parts = unzipSync(bytes, { filter: file => WORD_LISTS.test(file.name) });
  if (!parts["word/document.xml"] || !parts["word/numbering.xml"]) return bytes;
  const { definitions, lists } = readNumbering(decode(parts["word/numbering.xml"]));
  const styles = numberedStyles(decode(parts["word/styles.xml"]));
  const xml = decode(parts["word/document.xml"]);
  const counts = new Map<string, (number | undefined)[]>();
  const begun = new Set<string>();
  const marks: { at: number; text: string }[] = [];
  const number = (paragraph: Paragraph) => {
    const styled = paragraph.list === undefined ? styles.get(paragraph.style ?? "") : undefined;
    const id = paragraph.list ?? styled?.list ?? "";
    const list = lists.get(id);
    const at = paragraph.level ?? styled?.level ?? 0;
    const level = definitions.get(list?.definition ?? "")?.get(at);
    if (!list || !level) return;
    const count = counts.get(list.definition) ?? [];
    counts.set(list.definition, count);
    if (!begun.has(`${id} ${at}`)) {
      begun.add(`${id} ${at}`);
      const restart = list.restarts.get(at);
      if (restart !== undefined) count[at] = restart - 1;
    }
    count[at] = (count[at] ?? level.start - 1) + 1;
    // A deeper level starts again under each item above it.
    count.length = at + 1;
    if (!level.bullet && paragraph.textAt !== undefined) marks.push({ at: paragraph.textAt, text: listNumber(count[at]!) });
  };
  // Paragraphs only nest inside text boxes. What a tracked change replaced says nothing about the paragraph now.
  const open: Paragraph[] = [];
  for (const match of xml.matchAll(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>|<w:p(?:\s[^>]*)?>|<\/w:p>|<w:pStyle w:val="([^"]*)"|<w:ilvl w:val="(\d+)"|<w:numId w:val="(\d+)"|<w:t(?:\s[^>]*)?>/gu)) {
    const [tag, style, level, list] = match;
    const paragraph = open.at(-1);
    if (tag === "</w:p>") {
      if (paragraph) number(open.pop()!);
    } else if (/^<w:p[\s>]/u.test(tag)) {
      if (!tag.endsWith("/>")) open.push({});
    } else if (!paragraph || paragraph.textAt !== undefined || tag.startsWith("<w:pPrChange")) continue;
    else if (style !== undefined) paragraph.style ??= style;
    else if (level !== undefined) paragraph.level ??= Number(level);
    else if (list !== undefined) paragraph.list ??= list;
    else paragraph.textAt = match.index + tag.length;
  }
  if (marks.length === 0) return bytes;
  const pieces: string[] = [];
  let from = 0;
  for (const mark of marks.sort((a, b) => a.at - b.at)) {
    pieces.push(xml.slice(from, mark.at), mark.text);
    from = mark.at;
  }
  pieces.push(xml.slice(from));
  // Stored, not compressed again: this copy only goes to the converter.
  return zipSync({ ...unzipSync(bytes), "word/document.xml": strToU8(pieces.join("")) }, { level: 0 });
}
