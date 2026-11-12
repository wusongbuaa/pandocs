import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..");
const ALIASES: Readonly<Record<string, string>> = { "@rspress/core/theme": "src/theme/index.tsx", "#theme": "src/theme/index.tsx", "@rspress/core/theme-original": "vendor/rspress/theme/index.ts", "@rspress/core/runtime": "vendor/rspress/runtime/index.ts" };

function fileOf(from: string, specifier: string): string | null {
  const base = ALIASES[specifier] ? join(WEB, ALIASES[specifier]) : specifier.startsWith("@/") ? join(WEB, "vendor/shadcn", specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // The next one, then.
    }
  }
  return null;
}

/** Everything a module brings along by being imported. An `import()` is left out, since that loads when something asks for it. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/u.test(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gmu)) {
      const next = fileOf(file, match[1]!);
      if (next) pending.push(next);
    }
  }
  return seen;
}

describe("what a reader's first page loads", () => {
  it("leaves out the form kit, which only people changing something need", () => {
    const loaded = [...reachableFrom(join(WEB, "src/mount.tsx"))].map(path => path.slice(WEB.length + 1));
    expect(loaded).toContain("src/ui/menu.tsx");
    expect(loaded.filter(path => path.startsWith("vendor/shadcn/") || path === "src/styles/kit.css" || path === "src/ui/form.tsx" || path === "src/ui/dialog.tsx")).toEqual([]);
  });
});
