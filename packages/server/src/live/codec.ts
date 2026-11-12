import { existsSync } from "node:fs";
import type { LiveCodecPort } from "@pandocs/core";
import { createLiveCodec, type LiveCodec } from "@pandocs/editor-model";
import { mergeThreeWay } from "@pandocs/markdown";
import { createWorkerPool } from "../worker-pool.js";

/** Below this, a conversion takes a few milliseconds and a trip to another thread gains nothing. */
const IN_LINE_BELOW_BYTES = 64 * 1024;

export type LiveCodecJob =
  | { readonly kind: "seed"; readonly markdown: string; readonly meta: Parameters<LiveCodec["seed"]>[1] }
  | { readonly kind: "markdownOf"; readonly state: Uint8Array; readonly baseMarkdown: string }
  | { readonly kind: "align"; readonly state: Uint8Array; readonly markdown: string; readonly meta: Parameters<LiveCodec["align"]>[2] }
  | { readonly kind: "merge"; readonly base: string; readonly ours: string; readonly theirs: string };

export function runLiveCodecJob(codec: LiveCodec, job: LiveCodecJob): unknown {
  if (job.kind === "seed") return codec.seed(job.markdown, job.meta);
  if (job.kind === "markdownOf") return codec.markdownOf(job.state, job.baseMarkdown);
  if (job.kind === "merge") return mergeThreeWay(job.base, job.ours, job.theirs);
  return codec.align(job.state, job.markdown, job.meta);
}

/** Long pages convert on other threads, like everything else that takes time in proportion to a page's length. */
export function createLiveCodecPort(workerUrl: URL = new URL("./live-worker.mjs", import.meta.url)): LiveCodecPort & { stop(): Promise<void> } {
  let inline: LiveCodec | null = null;
  const pool = existsSync(workerUrl) ? createWorkerPool<LiveCodecJob, unknown>(workerUrl) : null;
  const run = async <Output>(job: LiveCodecJob, size: number): Promise<Output> => {
    if (pool && size >= IN_LINE_BELOW_BYTES) return await pool.run(job) as Output;
    inline ??= createLiveCodec();
    return runLiveCodecJob(inline, job) as Output;
  };
  return {
    seed: (markdown, meta) => run({ kind: "seed", markdown, meta }, markdown.length),
    markdownOf: (state, baseMarkdown) => run({ kind: "markdownOf", state, baseMarkdown }, Math.max(state.byteLength, baseMarkdown.length)),
    align: (state, markdown, meta) => run({ kind: "align", state, markdown, meta }, Math.max(state.byteLength, markdown.length)),
    merge: (base, ours, theirs) => run({ kind: "merge", base, ours, theirs }, base.length),
    stop: async () => pool?.stop()
  };
}
