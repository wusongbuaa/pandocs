import { parentPort, workerData } from "node:worker_threads";

/** A thread stays in one language, the way a page in a browser does. See `i18n`. */
(globalThis as { pandocsRenderLanguage?: string }).pandocsRenderLanguage = (
  workerData as { language: string }
).language;
/** Where the site lives below its host, which a page in a browser reads from the page itself. See `data/site-base`. */
(globalThis as { pandocsSiteBase?: string }).pandocsSiteBase = (workerData as { base?: string }).base ?? "";
/** Everything a page renders from has been prepared, and nothing in a page gets to reach out from a server. */
globalThis.fetch = input => Promise.reject(new Error(`A page being rendered asked for ${String(input)}`));

// In this order, and only now: each of these needs what comes before it while it loads.
const { loadMessages } = await import("../i18n");
await loadMessages();
await import("./page-route");
const { renderPage } = await import("./render");

parentPort!.on("message", async ({ id, input }: { id: number; input: import("./protocol").RenderInput }) => {
  try {
    const page = await renderPage(input);
    parentPort!.postMessage({ id, page, heapBytes: process.memoryUsage().heapTotal });
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      heapBytes: process.memoryUsage().heapTotal
    });
  }
});
