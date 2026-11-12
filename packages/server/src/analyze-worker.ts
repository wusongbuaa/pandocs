import { parentPort } from "node:worker_threads";
import { addMessages, inLanguage, type Language } from "@pandocs/i18n";
import { analyzeDocument } from "@pandocs/markdown";
import { zh } from "@pandocs/markdown/zh";
import "./language.js";

addMessages("zh", zh);

parentPort!.on("message", ({ id, input: { markdown, language } }: { id: number; input: { markdown: string; language: Language } }) => {
  try {
    parentPort!.postMessage({ id, result: inLanguage(language, () => analyzeDocument(markdown)) });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
