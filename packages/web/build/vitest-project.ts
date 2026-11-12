import { fileURLToPath } from "node:url";
import svgr from "vite-plugin-svgr";
import { vendorAliases } from "./aliases.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/** The app's tests run the vendored theme, so they need the aliases and icon handling of its build. */
export function webProject(shared: object, aliases: Record<string, string>) {
  return {
    plugins: [svgr({ include: "**/*.svg", svgrOptions: { exportType: "default" as const, ref: false, titleProp: false } })],
    define: {
      __WEBPACK_PUBLIC_PATH__: JSON.stringify("/api/v1"),
      // Vitest turns these into environment strings, where "false" reads as true; the flags that are off stay unset.
      "import.meta.env.ENABLE_LLMS_UI": "true"
    },
    resolve: { alias: [...vendorAliases(appRoot), ...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))] },
    test: { ...shared, name: "web", include: ["packages/web/test/**/*.test.{ts,tsx}"], setupFiles: ["packages/web/test/setup-language.ts"], passWithNoTests: true }
  };
}
