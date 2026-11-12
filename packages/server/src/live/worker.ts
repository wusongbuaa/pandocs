import { parentPort } from "node:worker_threads";
import { createLiveCodec } from "@pandocs/editor-model";
import { runLiveCodecJob, type LiveCodecJob } from "./codec.js";

const codec = createLiveCodec();

parentPort!.on("message", ({ id, input }: { id: number; input: LiveCodecJob }) => {
  try {
    parentPort!.postMessage({ id, result: runLiveCodecJob(codec, input) });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
