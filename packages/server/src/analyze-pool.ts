import { existsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { PandocsError } from "@pandocs/core";
import { currentLanguage, t, type Language } from "@pandocs/i18n";
import { analyzeDocument, type DocumentAnalysis } from "@pandocs/markdown";
import { createWorkerPool } from "./worker-pool.js";

/** Below this, parsing takes a few milliseconds and a trip to another thread gains nothing. */
const IN_LINE_BELOW_CHARS = 32 * 1024;

const MEGABYTE = 1024 * 1024;
/** Below this, two long pages at once could take more than there is, and the process would be killed instead of told no. */
const ROOM_FOR_TWO_MB = 2048;
const MOST_HEAP_MB = 2048;

/**
 * What a thread may use, out of what this process has. Left to itself it gets too little in a small container: a dense page
 * of 1 MB, the kind with tens of thousands of blocks, needs 600 MB to parse, and 2 MB, the limit on a page, about 1.5 GB.
 */
export function parsingMemory(memoryMb: number, processors: number): { readonly threads: number; readonly heapMb: number } {
  return { threads: memoryMb < ROOM_FOR_TWO_MB ? 1 : Math.max(1, Math.min(2, processors - 1)), heapMb: Math.min(MOST_HEAP_MB, Math.floor(memoryMb * 0.6)) };
}

function memoryOfThisProcess(): number {
  const limit = process.constrainedMemory();
  return (limit > 0 && limit < totalmem() ? limit : totalmem()) / MEGABYTE;
}

/** Long documents parse on other threads: on the main one, a 500 KB page stops every other request for hundreds of milliseconds. */
export function createAnalyzePool(workerUrl: URL, size?: number) {
  const { threads, heapMb } = parsingMemory(memoryOfThisProcess(), cpus().length);
  const pool = createWorkerPool<{ markdown: string; language: Language }, DocumentAnalysis>(workerUrl, size ?? threads, heapMb);
  return {
    analyze(markdown: string): Promise<DocumentAnalysis> {
      if (markdown.length < IN_LINE_BELOW_CHARS) return Promise.resolve(analyzeDocument(markdown));
      return pool.run({ markdown, language: currentLanguage() }).catch((error: unknown) => {
        // What it costs to parse depends on how much structure there is, not only on the size limit it already passed.
        if ((error as { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY") throw new PandocsError(422, "DOCUMENT_TOO_COMPLEX", t("This page has more in it than this server has memory to process. Split it into several pages."));
        throw error;
      });
    },
    stop: pool.stop
  };
}

/** Next to the entry point in a built server. From source, documents parse in line. */
export function analyzePoolFromBuild() {
  const url = new URL("./analyze-worker.mjs", import.meta.url);
  return existsSync(url) ? createAnalyzePool(url) : null;
}
