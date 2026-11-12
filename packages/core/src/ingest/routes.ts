import { invalid } from "../domain/errors.js";
import type { PersistMode } from "../domain/types.js";
import { t } from "@pandocs/i18n";

const MARKDOWN = "text/markdown";
const PLAIN = "text/plain";
const DOCUMENT_TYPES = [
  "text/html",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "text/csv"
];

export interface IngestRoute {
  readonly name: string;
  readonly match: { readonly channels?: readonly string[]; readonly contentTypes: readonly string[] };
  readonly processors: readonly string[];
  /** `auto`: editors publish; everyone else gets a proposal on an existing document or a draft. */
  readonly persist: PersistMode | "auto";
  /** Async routes end in a draft, because a background worker has no live identity to publish as. */
  readonly mode: "sync" | "async";
}

/** Channel × content type decides what happens to inbound content. New parsers only add entries here. */
export const defaultIngestRoutes: readonly IngestRoute[] = [
  { name: "markdown-programmatic", match: { channels: ["api", "cli", "mcp", "agent", "migration"], contentTypes: [MARKDOWN, PLAIN] }, processors: ["normalize"], persist: "auto", mode: "sync" },
  { name: "markdown-upload", match: { contentTypes: [MARKDOWN, PLAIN] }, processors: ["normalize"], persist: "draft", mode: "sync" },
  { name: "document-extract", match: { contentTypes: DOCUMENT_TYPES }, processors: ["extract", "normalize"], persist: "draft", mode: "async" }
];

export function resolveRoute(routes: readonly IngestRoute[], channel: string, contentType: string): IngestRoute {
  const route = routes.find(item => item.match.contentTypes.includes(contentType) && (!item.match.channels || item.match.channels.includes(channel)));
  if (!route) throw invalid("CONTENT_TYPE_UNSUPPORTED", t("Importing {1} from {0} is not supported", channel, contentType));
  return route;
}

const BY_EXTENSION: Readonly<Record<string, string>> = {
  md: MARKDOWN,
  markdown: MARKDOWN,
  txt: PLAIN,
  html: "text/html",
  htm: "text/html",
  mhtml: "text/html",
  csv: "text/csv",
  tsv: "text/csv",
  pdf: "application/pdf",
  docx: DOCUMENT_TYPES[2]!,
  xlsx: DOCUMENT_TYPES[3]!,
  pptx: DOCUMENT_TYPES[4]!,
  doc: DOCUMENT_TYPES[5]!,
  xls: DOCUMENT_TYPES[6]!,
  ppt: DOCUMENT_TYPES[7]!
};

/**
 * The bytes outrank the extension, and the extension outranks the caller's claim. A `.md` that is
 * really a PDF goes down the PDF route, not into the Markdown parser.
 */
export function detectContentType(input: { bytes?: Uint8Array | undefined; filename?: string | undefined; declared?: string | undefined }): string {
  const declared = input.declared?.split(";")[0]?.trim().toLowerCase();
  const extension = input.filename?.toLowerCase().split(".").pop();
  const byExtension = extension ? BY_EXTENSION[extension] : undefined;
  const bytes = input.bytes;
  if (bytes && bytes.byteLength > 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (isZip) {
      if (byExtension && DOCUMENT_TYPES.slice(2, 5).includes(byExtension)) return byExtension;
      throw invalid("CONTENT_TYPE_UNSUPPORTED", t("An archive or unknown Office file. Use docx, xlsx or pptx."));
    }
    const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "text/html";
    if (bytes.subarray(0, 4096).includes(0) && !byExtension) throw invalid("CONTENT_TYPE_UNSUPPORTED", t("An unrecognized binary file"));
  }
  return byExtension ?? declared ?? PLAIN;
}
