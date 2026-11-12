import type { List } from "mdast";
import { parseDocument } from "@pandocs/markdown";
import { inlineMarkdown } from "../markdown/pipeline";

export interface MindmapNode {
  /** Inline Markdown, never HTML. */
  readonly text: string;
  readonly children: MindmapNode[];
  /** Present when the node stands for a heading of the page, which picking it leads to. */
  readonly headingId?: string;
}

function treeBuilder(title: string) {
  const root: MindmapNode = { text: title, children: [] };
  const open: { depth: number; node: MindmapNode }[] = [{ depth: 0, node: root }];
  return {
    root,
    current: () => open.at(-1)!.node,
    heading(depth: number, text: string, headingId?: string) {
      while (open.at(-1)!.depth >= depth) open.pop();
      const node: MindmapNode = { text, children: [], ...(headingId ? { headingId } : {}) };
      open.at(-1)!.node.children.push(node);
      open.push({ depth, node });
    }
  };
}

export function treeFromOutline(title: string, outline: readonly { readonly id: string; readonly text: string; readonly depth: number }[]): MindmapNode {
  const tree = treeBuilder(title);
  for (const entry of outline) tree.heading(entry.depth, entry.text, entry.id);
  return tree.root;
}

function addList(list: List, parent: MindmapNode): void {
  for (const item of list.children) {
    const [first, ...rest] = item.children;
    const node: MindmapNode = { text: first?.type === "paragraph" ? inlineMarkdown(first).trim() : "", children: [] };
    parent.children.push(node);
    for (const child of rest) if (child.type === "list") addList(child, node);
  }
}

/** Headings and lists give the levels. With one thing at the top that is the centre; otherwise the title is. */
export function treeFromMarkdown(source: string, title = ""): MindmapNode {
  const tree = treeBuilder(title);
  for (const block of parseDocument(source).tree.children) {
    if (block.type === "heading") tree.heading(block.depth, inlineMarkdown(block).trim());
    else if (block.type === "list") addList(block, tree.current());
    else if (block.type === "paragraph") tree.current().children.push({ text: inlineMarkdown(block).trim(), children: [] });
  }
  return !title && tree.root.children.length === 1 ? tree.root.children[0]! : tree.root;
}
