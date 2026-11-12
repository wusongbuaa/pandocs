import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Nodes } from "mdast";
import {
  anchorFromRange,
  outlineOf,
  parseDocument,
  relocateTextAnchor,
  resolveDocLink,
  squashWhitespace,
  topLevelBlocks,
  visibleText
} from "@pandocs/markdown";

const DIR = join(import.meta.dirname, "fixtures/corpus");
interface Entry {
  file: string;
  path: string;
  title: string;
  restricted: boolean;
}
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as Entry[];
const pages = manifest.map(entry => ({ ...entry, markdown: readFileSync(join(DIR, entry.file), "utf8") }));

function walk(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) walk(child, visit);
}

describe("a whole handbook as a conformance corpus", () => {
  const parsed = pages.map(page => ({ page, document: parseDocument(page.markdown) }));

  it("parses every page without a diagnostic", () => {
    expect(pages).toHaveLength(12);
    expect(parsed.flatMap(({ document }) => document.diagnostics)).toEqual([]);
  });

  it("recognises every block", () => {
    const counts = new Map<string, number>();
    for (const { document } of parsed)
      for (const block of document.blocks) counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ callout: 13, columns: 3, column: 6, mermaid: 4, subpages: 3 });
  });

  it("renders every bold span, including the CJK cases CommonMark rejects", () => {
    let strong = 0;
    for (const { page, document } of parsed) {
      walk(document.tree, node => {
        if (node.type === "strong") strong += 1;
      });
      expect(visibleText(document), page.title).not.toContain("**");
    }
    expect(strong).toBe(55);
  });

  it("keeps every image and resolves every cross link", () => {
    const paths = new Set(manifest.map(entry => entry.path));
    let images = 0;
    let links = 0;
    for (const { page, document } of parsed) {
      walk(document.tree, node => {
        if (node.type === "image") {
          images += 1;
          expect(node.url).toMatch(/^assets\/[a-f0-9]{64}\.png$/u);
          expect(node.alt, page.title).not.toBe("");
        }
        if (node.type === "link" && !/^https?:/u.test(node.url)) {
          links += 1;
          const target = resolveDocLink(page.path, node.url);
          expect(target && paths.has(target.path), `${page.title} → ${node.url}`).toBe(true);
        }
      });
    }
    expect(images).toBe(4);
    expect(links).toBe(15);
  });

  it("has an outline and addressable blocks on every content page", () => {
    for (const { page, document } of parsed) {
      expect(topLevelBlocks(document).length, page.title).toBeGreaterThan(0);
      for (const entry of outlineOf(document)) expect(entry.ref, entry.text).toMatch(/^b\d+$/u);
    }
  });

  it("marks only the manager's page as restricted", () => {
    expect(manifest.filter(entry => entry.restricted).map(entry => entry.title)).toEqual(["门店管理（仅店长）"]);
  });
});

describe("anchors on real text", () => {
  let seed = 20261105;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low));

  const texts = pages
    .map(page => squashWhitespace(visibleText(parseDocument(page.markdown))))
    .filter(text => text.length > 200);
  const samples = Array.from({ length: 300 }, () => {
    const text = texts[between(0, texts.length)]!;
    const length = between(12, 60);
    const start = between(0, text.length - length);
    return { text, anchor: anchorFromRange(text, start, start + length) };
  });

  const rate = (edit: (sample: (typeof samples)[number]) => { text: string; truth: number | null } | null) => {
    let total = 0;
    let right = 0;
    let wrong = 0;
    for (const sample of samples) {
      const edited = edit(sample);
      if (!edited) continue;
      total += 1;
      const moved = relocateTextAnchor(sample.anchor, edited.text);
      if (moved.state === "orphaned") {
        if (edited.truth === null) right += 1;
        continue;
      }
      if (edited.truth !== null && Math.abs(moved.anchor.start - edited.truth) <= 6) right += 1;
      else wrong += 1;
    }
    return { right: right / total, wrong: wrong / total };
  };

  it("survives unrelated edits", () => {
    const { right, wrong } = rate(({ text, anchor }) => ({
      text: `这是新插入的一段说明文字。${text}`,
      truth: anchor.start + "这是新插入的一段说明文字。".length
    }));
    expect(right).toBeGreaterThan(0.97);
    expect(wrong).toBeLessThan(0.01);
  });

  it("follows a small edit inside the quote", () => {
    const { right, wrong } = rate(({ text, anchor }) => {
      const at = anchor.start + Math.floor((anchor.end - anchor.start) / 2);
      return { text: `${text.slice(0, at)}改动${text.slice(at + 2)}`, truth: anchor.start };
    });
    expect(right).toBeGreaterThan(0.85);
    expect(wrong).toBeLessThan(0.05);
  });

  it("rarely latches onto something else once the quote is gone", () => {
    const { right, wrong } = rate(({ text, anchor }) => ({
      text: text.slice(0, anchor.start) + text.slice(anchor.end),
      truth: null
    }));
    expect(right).toBeGreaterThan(0.9);
    expect(wrong).toBeLessThan(0.1);
  });
});
