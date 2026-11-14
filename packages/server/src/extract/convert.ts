import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "@pandocs/i18n";
import { unzipSync } from "fflate";
import mammoth from "mammoth";
import readXlsxFile from "read-excel-file/node";
import { extractText, getDocumentProxy } from "unpdf";
import { markListNumbers, POWERPOINT_PARTS, shownNumbers, slidesInOrder, unescapeXml } from "./ooxml.js";
import { declaredEncoding, decodeText, htmlToMarkdown, parseDelimited, toTable } from "./text.js";

export interface ExtractInput {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

export interface ExtractedFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
}

export interface Extracted {
  readonly markdown: string;
  readonly title?: string | undefined;
  readonly warnings: readonly string[];
  /** Images found inside the file, already referred to from `markdown` as `assets/<sha256>.<ext>`. */
  readonly files: readonly ExtractedFile[];
  /** A PDF with next to no text, most likely pictures of pages, which a service that reads pictures may do better with. */
  readonly scanned?: boolean;
}

/** Input that will never convert, as opposed to a failure worth trying again. */
export class UnconvertibleError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "UnconvertibleError";
  }
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const OLD_OFFICE = new Set(["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);

const MAX_ROWS = 5000;
/** A small zip can unpack to something enormous. Refused before anything unpacks it. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

function refuseZipBomb(bytes: Uint8Array): void {
  let total = 0;
  try {
    unzipSync(bytes, {
      filter(file) {
        total += file.originalSize;
        return false;
      }
    });
  } catch {
    throw new UnconvertibleError("FILE_DAMAGED", t("The file is damaged, or not the format it appears to be"));
  }
  if (total > MAX_UNPACKED_BYTES)
    throw new UnconvertibleError("FILE_TOO_LARGE", t("The file is too large once unpacked"));
}

function limitRows<T>(rows: readonly T[], warnings: string[], where: string): readonly T[] {
  if (rows.length <= MAX_ROWS) return rows;
  warnings.push(
    t(
      "{0} has {1} rows, and only the first {2} were converted. See the original file for all of them.",
      where,
      rows.length,
      MAX_ROWS
    )
  );
  return rows.slice(0, MAX_ROWS);
}

async function fromDocx(bytes: Uint8Array): Promise<Extracted> {
  refuseZipBomb(bytes);
  const files: ExtractedFile[] = [];
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(markListNumbers(bytes)) },
    {
      convertImage: mammoth.images.imgElement(async image => {
        const content = await image.readAsBuffer();
        const sha256 = createHash("sha256").update(content).digest("hex");
        const extension =
          image.contentType
            .split("/")[1]
            ?.replace("jpeg", "jpg")
            .replace(/[^a-z0-9].*$/u, "") ?? "bin";
        files.push({ bytes: new Uint8Array(content), filename: `${sha256}.${extension}` });
        return { src: `assets/${sha256}.${extension}` };
      })
    }
  );
  const warnings = result.messages.filter(message => message.type === "error").map(message => message.message);
  return { markdown: htmlToMarkdown(result.value), warnings, files };
}

async function fromXlsx(bytes: Uint8Array): Promise<Extracted> {
  refuseZipBomb(bytes);
  const buffer = Buffer.from(bytes);
  const sheets = await readXlsxFile(buffer);
  const shown = shownNumbers(bytes);
  const warnings: string[] = [];
  const parts: string[] = [];
  for (const { sheet: name, data: rows } of sheets) {
    for (const cell of shown.get(name) ?? []) {
      const row = rows[cell.row];
      if (row && cell.column < row.length) row[cell.column] = cell.text;
    }
    const table = toTable(limitRows(rows, warnings, t('Sheet "{0}"', name)));
    if (table) parts.push(sheets.length > 1 ? `## ${name}\n\n${table}` : table);
  }
  return { markdown: parts.join("\n\n"), warnings, files: [] };
}

function fromPptx(bytes: Uint8Array): Extracted {
  refuseZipBomb(bytes);
  const files = unzipSync(bytes, { filter: file => POWERPOINT_PARTS.test(file.name) });
  const parts = slidesInOrder(files).map((name, index) => {
    const xml = new TextDecoder().decode(files[name]);
    const lines = [...xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/gu)]
      .map(paragraph =>
        [...paragraph[0].matchAll(/<a:t>([^<]*)<\/a:t>/gu)]
          .map(run => unescapeXml(run[1]!))
          .join("")
          .trim()
      )
      .filter(Boolean);
    const [title, ...rest] = lines;
    return [`## ${title ?? t("Page {0}", index + 1)}`, ...rest.map(line => `- ${line}`)].join("\n\n");
  });
  return { markdown: parts.join("\n\n"), warnings: [], files: [] };
}

/**
 * What pdf.js reads besides the PDF: the character maps for fonts a PDF names without carrying them, which is how most
 * Chinese PDFs are written, and the standard fonts. The build puts them beside the server; run from source, they are
 * in the package. Without them, such a PDF reads as having no text.
 */
let pdfResources: { cMapUrl: string; cMapPacked: true; standardFontDataUrl: string } | undefined;
function pdfResourcesAt() {
  if (pdfResources) return pdfResources;
  const built = fileURLToPath(new URL("./pdf/", import.meta.url));
  const folder = existsSync(built)
    ? built
    : `${dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))}/`;
  return (pdfResources = {
    cMapUrl: `${folder}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${folder}standard_fonts/`
  });
}

async function fromPdf(bytes: Uint8Array): Promise<Extracted> {
  let text: string[];
  try {
    const document = await getDocumentProxy(new Uint8Array(bytes), pdfResourcesAt());
    ({ text } = await extractText(document, { mergePages: false }));
  } catch {
    throw new UnconvertibleError("FILE_DAMAGED", t("The PDF is damaged or has a password"));
  }
  const pages = text.map(page => page.replace(/[ \t]+/gu, " ").trim());
  if (pages.join("").length < 20) {
    return {
      markdown: "",
      warnings: [
        t(
          "This PDF has almost no text, so it may be a scan. To recognize its text, set up an external conversion service."
        )
      ],
      files: [],
      scanned: true
    };
  }
  const single = pages.length === 1;
  return {
    markdown: pages
      .flatMap((page, index) => (page ? [single ? page : t("## Page {0}\n\n{1}", index + 1, page)] : []))
      .join("\n\n"),
    warnings: [],
    files: []
  };
}

/** Turns a file into Markdown. What a file looks like is lost and its text kept, so the original stays attached to the page. */
export async function extractToMarkdown(input: ExtractInput): Promise<Extracted> {
  const { bytes, contentType } = input;
  if (contentType === "text/html") {
    const warnings: string[] = [];
    const html = decodeText(bytes, warnings, declaredEncoding(bytes));
    const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(html)?.[1]?.trim();
    return { markdown: htmlToMarkdown(html), ...(title ? { title } : {}), warnings, files: [] };
  }
  if (contentType === "text/csv") {
    const warnings: string[] = [];
    const rows = limitRows(parseDelimited(decodeText(bytes, warnings)), warnings, t("Table"));
    return { markdown: toTable(rows), warnings, files: [] };
  }
  if (contentType === DOCX) return fromDocx(bytes);
  if (contentType === XLSX) return fromXlsx(bytes);
  if (contentType === PPTX) return fromPptx(bytes);
  if (contentType === "application/pdf") return fromPdf(bytes);
  if (OLD_OFFICE.has(contentType))
    throw new UnconvertibleError(
      "OLD_OFFICE_FORMAT",
      t(
        "Old Office formats cannot be converted. Save it as docx, xlsx or pptx, or set up an external conversion service."
      )
    );
  throw new UnconvertibleError("CONTENT_TYPE_UNSUPPORTED", t("Cannot convert {0}", contentType));
}
