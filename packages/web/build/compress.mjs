import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".html", ".json", ".svg", ".map", ".wasm"]);
const dist = fileURLToPath(new URL("../dist", import.meta.url));

/** Compressing once at build time lets the server hand out the smallest form at no cost per request. */
function compress(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      // What renders pages on the server never goes to a browser.
      if (name !== "ssr") compress(path);
      continue;
    }
    if (!COMPRESSIBLE.has(extname(name))) continue;
    const content = readFileSync(path);
    if (content.length < 1024) continue;
    writeFileSync(`${path}.br`, brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
    writeFileSync(`${path}.gz`, gzipSync(content, { level: 9 }));
  }
}

compress(dist);
