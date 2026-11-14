// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseDocument, resolveDocLink } from "@pandocs/markdown";
import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";
import examples from "../sample-docs/examples.json";
import { SAMPLE_PAGES, samplePage, sampleImageNames, type SampleLanguage } from "../src/manage/sample-docs";

const ROOT = resolve(import.meta.dirname, "../sample-docs");
const REPO = resolve(ROOT, "../../..");
const LANGUAGES: readonly SampleLanguage[] = ["zh", "en"];

const pagesOnDisk = (language: SampleLanguage) =>
  readdirSync(join(ROOT, language), { recursive: true, encoding: "utf8" })
    .filter(file => file.endsWith(".md"))
    .map(file => relative("", file).replace(/\.md$/u, ""))
    .sort();

/** Examples of how to write something use names that are not meant to exist. */
const withoutExamples = (markdown: string) => markdown.replace(/^(`{3,})(?:md|yaml|bash|tree)\b[\s\S]*?^\1$/gmu, "");

/** A container nested with the wrong number of colons is no error to the parser: its markers just come out as text. */
function strayMarkers(node: Nodes): readonly string[] {
  if (node.type === "text") return /^:{2,}/mu.test(node.value) ? [node.value] : [];
  return "children" in node ? node.children.flatMap(strayMarkers) : [];
}

describe.each(LANGUAGES)("the sample documents in %s", language => {
  const pages = SAMPLE_PAGES.map(path => ({ path, ...samplePage(language, path) }));

  it("lists every page there is, each after the page holding it", () => {
    expect([...SAMPLE_PAGES].sort()).toEqual(pagesOnDisk(language));
    SAMPLE_PAGES.forEach((path, index) => {
      if (path.includes("/"))
        expect(SAMPLE_PAGES.indexOf(path.slice(0, path.lastIndexOf("/")) as never)).toBeLessThan(index);
    });
  });

  it("has no problems for the site to report", () => {
    for (const { path, title, markdown } of pages) {
      expect(title, path).not.toBe("");
      const { diagnostics, tree } = parseDocument(markdown);
      expect(diagnostics, path).toEqual([]);
      expect(strayMarkers(tree), path).toEqual([]);
    }
  });

  it("links only to pages and images that are there", () => {
    const images = new Set(sampleImageNames());
    for (const { path, markdown } of pages) {
      const body = withoutExamples(markdown);
      const links = [...body.matchAll(/\]\(([^)\s]+\.md(?:#[^)]*)?)\)|href="([^"]+\.md)"/gu)].map(
        match => match[1] ?? match[2]!
      );
      for (const link of links) expect(SAMPLE_PAGES, `${path}: ${link}`).toContain(resolveDocLink(path, link)?.path);
      for (const [, image] of body.matchAll(/assets\/([\w.-]+)/gu))
        expect(images, `${path}: ${image}`).toContain(image);
    }
  });

  it("mentions only settings that exist", () => {
    const known = [
      ".env.example",
      ...readdirSync(join(REPO, "docs"))
        .filter(file => file.endsWith(".md"))
        .map(file => join("docs", file))
    ]
      .map(file => readFileSync(join(REPO, file), "utf8"))
      .join("\n");
    for (const { path, markdown } of pages) {
      for (const [setting] of markdown.matchAll(/PANDOCS_[A-Z0-9_]+/gu))
        expect(known.includes(setting), `${path}: ${setting}`).toBe(true);
    }
  });

  it("has the text its example comment and suggestion are about, once each", () => {
    const { markdown } = samplePage(language, examples.page);
    const { comment, suggestion } = examples[language];
    expect(markdown.split(comment.quote)).toHaveLength(2);
    expect(markdown.split(suggestion.pattern)).toHaveLength(2);
  });
});

it("notices a container nested with the wrong number of colons", () => {
  const nestedWrongly = ":::steps\n\n### A\n\n::::tabs\n\n:::tab[B]\n\nC\n\n:::\n\n::::\n\n:::\n";
  expect(strayMarkers(parseDocument(nestedWrongly).tree)).not.toEqual([]);
});

describe("the two languages", () => {
  it("keep to their own language", () => {
    const chinese = /\p{Script=Han}/u;
    for (const path of SAMPLE_PAGES) {
      expect(chinese.test(samplePage("en", path).markdown), path).toBe(false);
      expect(chinese.test(samplePage("zh", path).title), path).toBe(true);
    }
  });

  it("use the same blocks, so a translation shows what its original does", () => {
    const blocks = (language: SampleLanguage, path: string) =>
      parseDocument(samplePage(language, path).markdown).blocks.map(block => block.name);
    for (const path of SAMPLE_PAGES) expect(blocks("en", path), path).toEqual(blocks("zh", path));
  });
});
