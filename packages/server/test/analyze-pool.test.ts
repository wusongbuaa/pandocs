import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inLanguage } from "@pandocs/i18n";
import { analyzeDocument } from "@pandocs/markdown";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnalyzePool, parsingMemory } from "../src/analyze-pool.js";
import { createWorkerPool } from "../src/worker-pool.js";
import "../src/language.js";

describe("threads with nothing to do", () => {
  it("go away, and come back when there is work", async () => {
    const script = `import { parentPort } from "node:worker_threads"; parentPort.on("message", ({ id, input }) => parentPort.postMessage({ id, result: input + 1 }));`;
    const pool = createWorkerPool<number, number>(
      new URL(`data:text/javascript,${encodeURIComponent(script)}`),
      1,
      undefined,
      50
    );
    expect(await pool.run(1)).toBe(2);
    expect(pool.workers).toBe(1);
    await expect.poll(() => pool.workers, { timeout: 5000 }).toBe(0);
    expect(await pool.run(2)).toBe(3);
    await pool.stop();
  });
});

describe("threads that say other things", () => {
  it("take no notice of a message that is not an answer, such as a development server's", async () => {
    const script = `import { parentPort } from "node:worker_threads"; parentPort.on("message", ({ id, input }) => { parentPort.postMessage({ "watch:import": "file:///a.ts" }); parentPort.postMessage({ id, result: input + 1 }); });`;
    const pool = createWorkerPool<number, number>(new URL(`data:text/javascript,${encodeURIComponent(script)}`), 1);
    expect(await pool.run(1)).toBe(2);
    expect(await pool.run(5)).toBe(6);
    await pool.stop();
  });
});

describe("how much memory parsing may use", () => {
  it("leaves room for the server in a small container, and is not greedy in a large one", () => {
    expect(parsingMemory(1024, 8)).toEqual({ threads: 1, heapMb: 614 });
    expect(parsingMemory(2048, 8)).toEqual({ threads: 2, heapMb: 1228 });
    expect(parsingMemory(65_536, 8)).toEqual({ threads: 2, heapMb: 2048 });
    expect(parsingMemory(65_536, 1).threads).toBe(1);
  });
});

describe("parsing long documents off the main thread", () => {
  const dir = mkdtempSync(join(tmpdir(), "pandocs-worker-"));
  const outfile = join(dir, "analyze-worker.mjs");
  const long = "# 标题\n\n段落内容。\n\n:::tip\n\n提示内容\n\n:::\n\n".repeat(5000);
  let pool: ReturnType<typeof createAnalyzePool>;

  beforeAll(async () => {
    await build({
      entryPoints: [join(import.meta.dirname, "../src/analyze-worker.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      alias: {
        "@pandocs/markdown/zh": join(import.meta.dirname, "../../markdown/src/i18n/zh.ts"),
        "@pandocs/markdown": join(import.meta.dirname, "../../markdown/src/index.ts")
      },
      logLevel: "silent"
    });
    pool = createAnalyzePool(pathToFileURL(outfile), 2);
  });
  afterAll(async () => {
    await pool.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives the same answer as parsing in line", async () => {
    expect(await pool.analyze(long)).toEqual(analyzeDocument(long));
  });

  it("reports problems in the language of whoever asked", async () => {
    const odd = `:::no-such-block\n\nx\n\n:::\n\n${long}`;
    expect((await pool.analyze(odd)).diagnostics[0]!.message).toContain("Unknown block no-such-block");
    expect((await inLanguage("zh", () => pool.analyze(odd))).diagnostics[0]!.message).toContain(
      "不认识的块 no-such-block"
    );
  });

  it("keeps the main thread free while it works", async () => {
    let longestStall = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      longestStall = Math.max(longestStall, now - last);
      last = now;
    }, 5);
    const started = performance.now();
    await Promise.all([pool.analyze(long), pool.analyze(`${long}\n更多内容\n`), pool.analyze(`${long}\n再多一点\n`)]);
    const took = performance.now() - started;
    clearInterval(ticker);
    expect(took).toBeGreaterThan(100);
    expect(longestStall).toBeLessThan(took / 2);
  });

  it("does short documents in line", async () => {
    expect((await pool.analyze("# 短\n")).outline[0]?.text).toBe("短");
  });

  it("says a page is too much for this server when a worker runs out of memory", async () => {
    const script = `import { parentPort } from "node:worker_threads"; parentPort.on("message", () => { throw Object.assign(new Error("out of memory"), { code: "ERR_WORKER_OUT_OF_MEMORY" }); });`;
    const small = createAnalyzePool(new URL(`data:text/javascript,${encodeURIComponent(script)}`), 1);
    await expect(small.analyze(long)).rejects.toMatchObject({ status: 422, code: "DOCUMENT_TOO_COMPLEX" });
    await small.stop();
  });

  it("reports a failure instead of hanging, and keeps working", async () => {
    const broken = createAnalyzePool(new URL("data:text/javascript,process.exit(3)"), 1);
    await expect(broken.analyze(long)).rejects.toThrow();
    await broken.stop();
    expect((await pool.analyze(long)).blocks.length).toBeGreaterThan(0);
  });
});
