import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));

rmSync(`${here}dist`, { recursive: true, force: true });
mkdirSync(`${here}dist/sql`, { recursive: true });

await build({
  entryPoints: {
    main: `${here}src/main.ts`,
    "analyze-worker": `${here}src/analyze-worker.ts`,
    "extract-worker": `${here}src/extract/worker.ts`,
    "live-worker": `${here}src/live/worker.ts`
  },
  outdir: `${here}dist`,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  define: { PANDOCS_VERSION: JSON.stringify(JSON.parse(readFileSync(`${here}../../package.json`, "utf8")).version) },
  format: "esm",
  target: "node24",
  // CommonJS dependencies inside an ES module still reach for these.
  // A dependency of editing together looks for browser storage, and merely looking makes Node warn on every start.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url); delete globalThis.localStorage; delete globalThis.sessionStorage;"
  },
  // Optional native driver that `pg` tries to load; the JavaScript client is what runs.
  external: ["pg-native"],
  legalComments: "none",
  logLevel: "warning"
});

cpSync(`${here}../core/sql/schema.sql`, `${here}dist/sql/schema.sql`);
cpSync(`${here}sql/auth.sql`, `${here}dist/sql/auth.sql`);
cpSync(`${here}../../docs/api/openapi.yaml`, `${here}dist/openapi.yaml`);
// What pdf.js reads to get the text out of a PDF in a font it does not carry, as most Chinese PDFs are written.
const pdfjs = fileURLToPath(new URL(".", import.meta.resolve("pdfjs-dist/package.json")));
for (const folder of ["cmaps", "standard_fonts"])
  cpSync(`${pdfjs}${folder}`, `${here}dist/pdf/${folder}`, { recursive: true });
