import { parentPort, workerData } from "node:worker_threads";
import { addMessages, inLanguage, type Language } from "@pandocs/i18n";
import { zh } from "../i18n/zh.js";
import "../language.js";
import { extractToMarkdown, UnconvertibleError, type ExtractInput } from "./convert.js";

addMessages("zh", zh);

const { language, input } = workerData as { language: Language; input: ExtractInput };

/** One file per thread, which ends with it: what a file does to memory goes away, and a stuck one can be stopped. */
inLanguage(language, () => extractToMarkdown(input)).then(
  output => parentPort!.postMessage({ output }),
  (error: unknown) => parentPort!.postMessage({
    failure: {
      permanent: error instanceof UnconvertibleError,
      code: error instanceof UnconvertibleError ? error.code : "EXTRACT_FAILED",
      message: error instanceof Error ? error.message : String(error)
    }
  })
);
