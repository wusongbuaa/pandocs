import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { PermanentIngestError, type Processor } from "@pandocs/core";
import type { Extracted, ExtractedFile, ExtractInput } from "./convert.js";
import { currentLanguage, t } from "@pandocs/i18n";

const TIMEOUT_MS = 2 * 60 * 1000;
const EXTERNAL_TIMEOUT_MS = 10 * 60 * 1000;
const WORKER_MEMORY_MB = 1024;

export type Extractor = (input: ExtractInput) => Promise<Extracted>;

/**
 * On a thread of its own, since a large PDF takes seconds of solid work. It also keeps a bad file from taking anything
 * else down: it can be stopped when it runs too long, and running out of memory only ends that thread.
 */
export function extractInWorker(workerUrl: URL, options: { readonly timeoutMs?: number } = {}): Extractor {
  return input => new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { language: currentLanguage(), input }, resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } });
    const timer = setTimeout(() => {
      reject(new PermanentIngestError("EXTRACT_TIMEOUT", t("Conversion took too long. The file may be too complex.")));
      void worker.terminate();
    }, options.timeoutMs ?? TIMEOUT_MS);
    worker.once("message", (message: { output?: Extracted; failure?: { permanent: boolean; code: string; message: string } }) => {
      clearTimeout(timer);
      if (message.output) resolve(message.output);
      else if (message.failure?.permanent) reject(new PermanentIngestError(message.failure.code, message.failure.message));
      else reject(new Error(message.failure?.message ?? t("Conversion failed")));
      void worker.terminate();
    });
    worker.once("error", error => {
      clearTimeout(timer);
      const outOfMemory = (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY";
      reject(outOfMemory ? new PermanentIngestError("FILE_TOO_LARGE", t("The file is too large or complex, and conversion ran out of memory")) : error);
    });
  });
}

const MAX_SERVICE_FILES = 500;
const SERVICE_FILE = /^assets\/([a-f0-9]{64})\.([a-z0-9]{1,10})$/u;

/**
 * Images the service took out of the file, which its Markdown refers to as `assets/<sha256>.<ext>` the way the built-in
 * conversion does. A name has to be what its bytes hash to, or the image would turn up under someone else's.
 */
function serviceFiles(listed: unknown, warnings: string[]): ExtractedFile[] {
  if (!Array.isArray(listed)) return [];
  const files: ExtractedFile[] = [];
  let leftOut = Math.max(0, listed.length - MAX_SERVICE_FILES);
  for (const entry of listed.slice(0, MAX_SERVICE_FILES)) {
    const { path, data } = (typeof entry === "object" && entry !== null ? entry : {}) as { path?: unknown; data?: unknown };
    const named = typeof path === "string" ? SERVICE_FILE.exec(path) : null;
    const bytes = typeof data === "string" ? new Uint8Array(Buffer.from(data, "base64")) : null;
    if (!named || !bytes || createHash("sha256").update(bytes).digest("hex") !== named[1]) {
      leftOut += 1;
      continue;
    }
    files.push({ bytes, filename: `${named[1]}.${named[2]}` });
  }
  if (leftOut > 0) warnings.push(t("{0} {0|image|images} from the conversion service could not be kept", leftOut));
  return files;
}

/**
 * For what the built-in conversion cannot do well, such as scanned PDFs or old Office files: anything that takes the
 * file's bytes and answers with Markdown, either as plain text or as `{ markdown, title?, warnings?, files? }`.
 */
export function extractWithService(options: { readonly url: string; readonly token?: string | undefined; readonly timeoutMs?: number }): Extractor {
  return async ({ bytes, contentType, filename }) => {
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Filename": encodeURIComponent(filename),
        // The language of whoever brought the file in, for anything the service has to say to them.
        "Accept-Language": currentLanguage(),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      body: bytes as BodyInit,
      signal: AbortSignal.timeout(options.timeoutMs ?? EXTERNAL_TIMEOUT_MS)
    });
    if (!response.ok) {
      // It looked at this file and said no, perhaps with why. Anything else may pass, and is worth another try.
      if (response.status >= 400 && response.status < 500) {
        const said = await response.json().then(body => (typeof body?.error === "string" ? body.error.slice(0, 300) : ""), () => "");
        throw new PermanentIngestError("EXTRACT_REFUSED", said ? t("The conversion service could not convert the file: {0}", said) : t("The conversion service returned {0}", response.status));
      }
      throw new Error(t("The conversion service returned {0}", response.status));
    }
    if (response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json() as { markdown?: unknown; title?: unknown; warnings?: unknown; files?: unknown };
      if (typeof body.markdown !== "string") throw new PermanentIngestError("EXTRACT_REFUSED", t("The conversion service's answer has no markdown"));
      const warnings = Array.isArray(body.warnings) ? body.warnings.map(String) : [];
      const files = serviceFiles(body.files, warnings);
      return { markdown: body.markdown, ...(typeof body.title === "string" ? { title: body.title } : {}), warnings, files };
    }
    return { markdown: await response.text(), warnings: [], files: [] };
  };
}

export function createExtractProcessor(extract: Extractor): Processor {
  return {
    name: "extract",
    async run({ bytes, contentType, filename }) {
      if (!bytes) throw new PermanentIngestError("SOURCE_MISSING", t("There is no original file"));
      const { markdown, title, warnings, files } = await extract({ bytes, contentType, filename }).catch((error: unknown) => {
        // The conversion itself runs on another thread, away from the core, and so has an error of its own for this.
        if (error instanceof Error && error.name === "UnconvertibleError") throw new PermanentIngestError((error as Error & { code: string }).code, error.message);
        throw error;
      });
      return { markdown, ...(title ? { title } : {}), warnings, files, detail: contentType };
    }
  };
}

/** What the built-in conversion leaves to a service: a format it does not read, and an old Office one. */
const FOR_A_SERVICE = new Set(["OLD_OFFICE_FORMAT", "CONTENT_TYPE_UNSUPPORTED"]);

const leftForAService = (error: unknown) => (error instanceof PermanentIngestError || (error instanceof Error && error.name === "UnconvertibleError"))
  && FOR_A_SERVICE.has((error as Error & { code: string }).code);

/**
 * The built-in conversion first, and the service only for what it cannot read: scans, old Office formats. A service that
 * looks at a scan and says no leaves the page with just the file, as it would be without one.
 */
export function extractWithFallback(builtIn: Extractor, service: Extractor): Extractor {
  return async input => {
    let own: Extracted;
    try {
      own = await builtIn(input);
    } catch (error) {
      if (leftForAService(error)) return service(input);
      throw error;
    }
    if (!own.scanned) return own;
    try {
      return await service(input);
    } catch (error) {
      if (error instanceof PermanentIngestError) return own;
      throw error;
    }
  };
}

/** What this installation can do: a service if one is set up, the conversion built into this build, or both. */
export function extractorFromConfig(extract: { readonly url: string; readonly token?: string | undefined; readonly fallback?: boolean } | undefined): Extractor | null {
  const worker = new URL("./extract-worker.mjs", import.meta.url);
  const builtIn = existsSync(worker) ? extractInWorker(worker) : null;
  if (!extract) return builtIn;
  const service = extractWithService(extract);
  return extract.fallback && builtIn ? extractWithFallback(builtIn, service) : service;
}
