import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import svgr from "vite-plugin-svgr";
import { vendorAliases } from "./build/aliases.js";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

/** The same options Rsbuild gives the theme's icons, which keeps them pixel-identical to an official build. */
const svgrOptions = {
  include: "**/*.svg",
  svgrOptions: {
    exportType: "default",
    ref: false,
    titleProp: false,
    svgo: true,
    plugins: ["@svgr/plugin-svgo", "@svgr/plugin-jsx"],
    svgoConfig: { plugins: [{ name: "preset-default", params: { overrides: { removeViewBox: false } } }, "prefixIds"] }
  }
} as Parameters<typeof svgr>[0];

/**
 * The theme loads after the first chunk, and so does its CSS. A page that arrives finished would show without any until
 * then, so the page names them up front, which also starts the fetching earlier for one that does not.
 */
function linkTheTheme(mode: string): Plugin {
  return {
    name: "pandocs:link-the-theme",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle }) {
        const chunks = new Map(
          Object.values(bundle ?? {}).flatMap(file => (file.type === "chunk" ? [[file.fileName, file] as const] : []))
        );
        const start = [...chunks.values()].find(chunk => chunk.facadeModuleId?.endsWith("/src/mount.tsx"));
        if (!start) return [];
        const scripts = new Set<string>();
        const styles = new Set<string>();
        const visit = (name: string) => {
          const chunk = chunks.get(name);
          if (!chunk || scripts.has(name)) return;
          scripts.add(name);
          for (const style of chunk.viteMetadata?.importedCss ?? []) styles.add(style);
          chunk.imports.forEach(visit);
        };
        visit(start.fileName);
        const links = (rel: string, files: Set<string>) =>
          [...files]
            .filter(file => !html.includes(`/${file}"`))
            .map(file => ({
              tag: "link",
              attrs: { rel, crossorigin: true, href: `/${file}` },
              injectTo: "head" as const
            }));
        // Formulas without their CSS show twice over. Only pages with some need it, and the server knows which those are.
        const math =
          [...chunks.values()].find(chunk => chunk.facadeModuleId?.endsWith("/src/markdown/katex.ts"))?.viteMetadata
            ?.importedCss ?? [];
        return [
          ...links("stylesheet", styles),
          // After the theme's, for the site's own colour and rules to win. A comparison with an official build has no site.
          ...(mode === "parity"
            ? []
            : [{ tag: "link", attrs: { rel: "stylesheet", href: "/site.css" }, injectTo: "head" as const }]),
          ...links("modulepreload", scripts),
          ...[...math].map(style => ({
            tag: "meta",
            attrs: { name: "pandocs-math-styles", content: `/${style}` },
            injectTo: "head" as const
          }))
        ];
      }
    }
  };
}

export default defineConfig(({ command, mode, isSsrBuild }) => {
  // Also when a test runner starts the build: its setting would otherwise decide which React the page gets.
  if (command === "build") process.env.NODE_ENV = "production";
  return {
    // What the app loads names the rest relative to itself, so one build works at the root and below any path. The server
    // starts the page's own addresses from the site's path (see `placeBelow`). The comparison with an official build is
    // served as it is, by a plain file server, so it keeps them from the root.
    base: command === "build" && !isSsrBuild && mode !== "parity" ? "./" : "/",
    plugins: [react(), tailwindcss(), svgr(svgrOptions), linkTheTheme(mode)],
    define: {
      // Without this a bundle for a server keeps React's development build as well, and may run it.
      ...(isSsrBuild ? { "process.env.NODE_ENV": JSON.stringify("production") } : {}),
      // The theme's search panel builds its index URL from this, so the index comes from the API, below the site's path.
      __WEBPACK_PUBLIC_PATH__: '(globalThis.pandocsApiBase ?? "/api/v1")',
      "import.meta.env.ENABLE_LLMS_UI": "true",
      // Off where the page is compared with an official build, which has neither.
      "import.meta.env.ENABLE_LLMS_HINT": JSON.stringify(mode !== "parity"),
      "import.meta.env.ENABLE_WEBMCP": JSON.stringify(mode !== "parity"),
      // The theme's tools that read a page get its Markdown, which here comes from the server rather than the build.
      "import.meta.env.ENABLE_SSG_MD": JSON.stringify(mode !== "parity"),
      "import.meta.env.SSG_MD": "false"
    },
    resolve: {
      alias: [
        // The comparison with an official build runs without a server behind it; see parity/README.md.
        ...(mode === "parity"
          ? [
              { find: /^.*\/api\/client$/u, replacement: `${appRoot}parity/client.ts` },
              { find: /^.*\/styles\/density\.css$/u, replacement: `${appRoot}parity/no-density.css` }
            ]
          : []),
        ...vendorAliases(appRoot)
      ]
    },
    server: {
      port: 3100,
      // `pnpm --filter @pandocs/web dev` runs against a server started with `pnpm dev`.
      proxy: {
        "^/(api|auth|login|logout)(/|$)": {
          target: process.env.PANDOCS_DEV_SERVER ?? "http://127.0.0.1:8080",
          changeOrigin: false
        },
        "^/sign-in\\.css$": { target: process.env.PANDOCS_DEV_SERVER ?? "http://127.0.0.1:8080", changeOrigin: false },
        "^/.*(\\.md|llms(-full)?\\.txt)$": {
          target: process.env.PANDOCS_DEV_SERVER ?? "http://127.0.0.1:8080",
          changeOrigin: false
        }
      }
    },
    // The server's image holds no packages, so what renders pages brings its own.
    ssr: { noExternal: true },
    build: isSsrBuild
      ? {
          target: "node24",
          chunkSizeWarningLimit: 50000,
          copyPublicDir: false,
          rolldownOptions: { output: { entryFileNames: "[name].mjs", chunkFileNames: "chunks/[name]-[hash].mjs" } }
        }
      : {
          target: "esnext",
          chunkSizeWarningLimit: 5000,
          // A chunk runs before the one importing it. Together, these two run before anything has created a schema, wherever that ends up.
          rolldownOptions: {
            output: {
              codeSplitting: { groups: [{ name: "zod", test: /\/node_modules\/.*\/zod\/|\/src\/no-eval\.ts$/u }] }
            }
          }
        }
  };
});
