import type { Element, ElementContent, Root, RootContent } from "hast";

const MAX_BLOCKS_ON_A_SLIDE = 8;
const DEEPEST_SPLIT = 4;

const isElement = (node: RootContent, tag?: string): node is Element =>
  node.type === "element" && (tag === undefined || node.tagName === tag);
const isFootnotes = (node: RootContent) => isElement(node, "section") && node.properties.dataFootnotes !== undefined;

function splitAt(nodes: readonly RootContent[], level: number): RootContent[][] {
  const parts: RootContent[][] = [[]];
  for (const node of nodes) {
    if (isElement(node, "hr")) {
      parts.push([]);
      continue;
    }
    if (isElement(node, `h${level}`) || isFootnotes(node)) parts.push([]);
    parts.at(-1)!.push(node);
  }
  return parts
    .filter(part => part.length > 0)
    .flatMap(part =>
      // A long section breaks at its next level of headings instead of running off the slide.
      part.length > MAX_BLOCKS_ON_A_SLIDE &&
      level < DEEPEST_SPLIT &&
      part.some(node => isElement(node, `h${level + 1}`))
        ? splitAt(part, level + 1)
        : [part]
    );
}

export interface SlideSplit {
  /** What comes before the first heading, which goes under the title on the opening slide. */
  readonly opening: readonly RootContent[];
  readonly slides: readonly Root[];
}

/** One slide for each `##` and each `---`. The page's own `h1` is dropped, because the opening slide shows the title. */
export function splitSlides(root: Root): SlideSplit {
  const blocks = root.children.filter(node => node.type !== "text" || node.value.trim());
  const body = blocks[0] && isElement(blocks[0], "h1") ? blocks.slice(1) : blocks;
  const parts = splitAt(body, 2);
  const startsWithSection =
    parts[0]?.[0] !== undefined && isElement(parts[0][0]) && /^h[1-6]$/u.test(parts[0][0].tagName);
  const [opening, sections] = startsWithSection || parts[0] === undefined ? [[], parts] : [parts[0], parts.slice(1)];
  return { opening, slides: sections.map(children => ({ type: "root", children: children as ElementContent[] })) };
}
