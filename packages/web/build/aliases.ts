import { resolve } from "node:path";

/**
 * The vendored theme imports these names, which Rspress's build normally provides. Pointing them here is
 * what lets the theme run on data loaded at runtime without changing a line of it.
 */
export function vendorAliases(appRoot: string) {
  const at = (path: string) => resolve(appRoot, path);
  const virtual = (name: string) => ({ find: new RegExp(`^virtual-${name}$`, "u"), replacement: at(`src/virtual/${name}`) });
  return [
    { find: "@rspress/core/runtime", replacement: at("vendor/rspress/runtime/index.ts") },
    { find: "@rspress/core/theme-original", replacement: at("vendor/rspress/theme/index.ts") },
    { find: "@rspress/core/theme", replacement: at("src/theme/index.tsx") },
    { find: "#theme", replacement: at("src/theme/index.tsx") },
    { find: "@rspress/core/shiki-transformers", replacement: at("vendor/rspress/shiki-transformers.ts") },
    // The real module also pulls in Node-only code; the theme's Markdown plugins only need one function from it.
    { find: "@rspress/shared/node-utils", replacement: at("src/virtual/node-utils.ts") },
    // What the generated components in vendor/shadcn call each other.
    { find: /^@\/(.*)$/u, replacement: at("vendor/shadcn/$1") },
    ...["routes", "page-data", "site-data", "i18n-text", "social-links", "search-hooks", "global-components"].map(virtual)
  ];
}
