import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(`${here}../web/dist`, { recursive: true });

// Served by the site itself as /embed.js, for pages that would rather not install anything.
await build({
  entryPoints: [`${here}src/index.ts`],
  outfile: `${here}../web/dist/embed.js`,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "warning"
});
