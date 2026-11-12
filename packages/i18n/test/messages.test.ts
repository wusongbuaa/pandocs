import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packages = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Which dictionaries a package's text can come from when it runs. */
const SOURCES: Readonly<Record<string, readonly string[]>> = {
  markdown: ["markdown"],
  core: ["markdown", "core"],
  server: ["markdown", "core", "server"],
  web: ["markdown", "web"]
};

function codeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return codeFiles(path);
    return /\.tsx?$/u.test(name) && !name.endsWith(".d.ts") && !path.endsWith(join("i18n", "zh.ts")) ? [path] : [];
  });
}

const sourcesOf = (name: string) => codeFiles(join(packages, name, "src")).map(path => ({ path, text: readFileSync(path, "utf8") }));

async function dictionaryOf(name: string): Promise<Readonly<Record<string, string>>> {
  return (await import(join(packages, name, "src/i18n/zh.ts"))).zh as Readonly<Record<string, string>>;
}

const argumentsIn = (message: string) => new Set([...message.matchAll(/\{(\d+)\}/gu)].map(match => match[1]));

describe.each(Object.keys(SOURCES))("the text of %s", name => {
  it("all has a translation", async () => {
    const known = Object.assign({}, ...await Promise.all(SOURCES[name]!.map(dictionaryOf))) as Record<string, string>;
    const missing = sourcesOf(name).flatMap(({ path, text }) =>
      [...text.matchAll(/(?<![\w.])t\(\s*("(?:[^"\\]|\\.)*")/gu)].map(match => JSON.parse(match[1]!) as string)
        .filter(message => known[message] === undefined).map(message => `${path}: ${message}`));
    expect(missing).toEqual([]);
  });

  it("has no translations left over from text that is gone", async () => {
    // Block names and samples are looked up through the registry rather than written out where they are used.
    if (name === "markdown") return;
    const code = sourcesOf(name).map(({ text }) => text).join("\n");
    const unused = Object.keys(await dictionaryOf(name)).filter(message => !code.includes(JSON.stringify(message)));
    expect(unused).toEqual([]);
  });

  it("keeps its arguments in translation", async () => {
    const wrong = Object.entries(await dictionaryOf(name)).filter(([message, translated]) => {
      const source = [...argumentsIn(message)].sort().join();
      return source !== [...argumentsIn(translated)].sort().join() && !message.includes("|");
    });
    expect(wrong).toEqual([]);
  });

  it("is only ever English in the code", () => {
    // Language names are written in their own language, and comments may show what they talk about.
    const written = /简体中文|日本語/gu;
    const other = sourcesOf(name).flatMap(({ path, text }) => text.split("\n")
      .map(line => line.trim())
      .filter(line => !line.startsWith("*") && !line.startsWith("/*"))
      .map(line => line.replace(/\s\/\/ .*$/u, "").replace(/^\/\/ .*$/u, "").replace(written, ""))
      .filter(line => /[\u3400-\u9fff\u3001-\u303f\uff00-\uffef]/u.test(line))
      .map(line => `${path}: ${line}`));
    expect(other).toEqual([]);
  });
});

describe("the packages", () => {
  it("all have their text checked here", () => {
    const withText = readdirSync(packages).filter(name => existsSync(join(packages, name, "src/i18n/zh.ts")));
    expect(withText.sort()).toEqual(Object.keys(SOURCES).sort());
  });
});
