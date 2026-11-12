import type { Element, ElementContent, Root, RootContent } from "hast";
import type { GlossaryEntry } from "../types";

const SKIPPED_TAGS = new Set([
  "a",
  "abbr",
  "button",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "kbd",
  "math",
  "pre",
  "sub",
  "sup",
  "svg"
]);
const SKIPPED_CLASSES = new Set(["katex", "katex-display", "katex-error", "rp-header-anchor"]);
const LATIN = /[A-Za-z0-9_]/u;

const escaped = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function skips(node: Element): boolean {
  return (
    SKIPPED_TAGS.has(node.tagName) ||
    [node.properties?.className ?? []].flat().some(name => SKIPPED_CLASSES.has(String(name)))
  );
}

/**
 * Marks the first place a page uses each term, which is where a reader needs it; marking every use would turn the
 * page into underlines. Only wraps text and never changes it, so comment offsets are unaffected.
 */
export function rehypeGlossary(glossary: readonly GlossaryEntry[]) {
  return (tree: Root) => {
    const remaining = new Map(
      [...glossary]
        .sort((a, b) => b.term.length - a.term.length)
        .map(entry => [entry.term.toLowerCase(), entry] as const)
    );
    const pattern = () =>
      remaining.size === 0
        ? null
        : new RegExp([...remaining.values()].map(entry => escaped(entry.term)).join("|"), "giu");
    let matcher = pattern();

    const inText = (value: string): ElementContent[] | null => {
      const parts: ElementContent[] = [];
      let at = 0;
      let copied = 0;
      while (matcher) {
        matcher.lastIndex = at;
        const match = matcher.exec(value);
        if (!match) break;
        const word = match[0];
        const before = value[match.index - 1];
        const after = value[match.index + word.length];
        // `API` is a term in "API 文档", not inside "RAPID"; Chinese has no such boundaries to check.
        if (LATIN.test(word) && ((before && LATIN.test(before)) || (after && LATIN.test(after)))) {
          at = match.index + 1;
          continue;
        }
        const entry = remaining.get(word.toLowerCase())!;
        if (match.index > copied) parts.push({ type: "text", value: value.slice(copied, match.index) });
        parts.push({
          type: "element",
          tagName: "abbr",
          properties: { "data-definition": entry.definition },
          children: [{ type: "text", value: word }]
        });
        at = match.index + word.length;
        copied = at;
        remaining.delete(word.toLowerCase());
        matcher = pattern();
      }
      if (parts.length === 0) return null;
      if (copied < value.length) parts.push({ type: "text", value: value.slice(copied) });
      return parts;
    };

    const walk = (parent: Root | Element) => {
      const children: RootContent[] = [];
      for (const child of parent.children as RootContent[]) {
        if (!matcher) {
          children.push(child);
        } else if (child.type === "text") {
          children.push(...(inText(child.value) ?? [child]));
        } else {
          if (child.type === "element" && !skips(child)) walk(child);
          children.push(child);
        }
      }
      parent.children = children as typeof parent.children;
    };
    walk(tree);
  };
}
