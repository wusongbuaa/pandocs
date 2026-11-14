import type { Nodes, Root, RootContent } from "mdast";
import type { Pluggable } from "unified";
import { applyDialect, dialectOf, REMARK_SYNTAX } from "./parse.js";
import { defaultBlockRegistry, type BlockRegistry } from "./registry.js";
import { createSlugger, plainText } from "./structure.js";

export const BLOCK_ELEMENT = "pandocs-block";
export const INLINE_ELEMENT = "pandocs-inline";
export const UNKNOWN_ELEMENT = "pandocs-unknown";
export const LABEL_ELEMENT = "pandocs-label";

function hast(node: Nodes, name: string | undefined, properties: Record<string, unknown>): void {
  const data = ((node as unknown as { data?: Record<string, unknown> }).data ??= {});
  if (name) data.hName = name;
  data.hProperties = { ...(data.hProperties as object | undefined), ...properties };
}

/** Maps dialect marks onto custom elements, so the reader needs no Markdown knowledge beyond a component table. */
function annotate(tree: Root): void {
  const slug = createSlugger();
  const visit = (node: Nodes, parent: { children: unknown[] } | null, index: number): void => {
    const { pandocsBlock: block, pandocsUnknown: unknown } = dialectOf(node);
    if (unknown) {
      const replacement = {
        type: "pandocsUnknown",
        data: {
          hName: UNKNOWN_ELEMENT,
          hProperties: { "data-raw": unknown.raw, "data-name": (node as { name?: string }).name ?? "" }
        },
        children: [],
        position: node.position
      };
      parent!.children[index] = replacement;
      return;
    }
    if (block) {
      const properties = {
        "data-name": block.name,
        "data-kind": block.kind,
        "data-attrs": JSON.stringify(block.attrs)
      };
      if (node.type === "code") {
        parent!.children[index] = {
          type: "pandocsFence",
          data: {
            hName: BLOCK_ELEMENT,
            hProperties: {
              ...properties,
              "data-source": node.value,
              "data-body": block.body === undefined ? "" : JSON.stringify(block.body)
            }
          },
          children: [],
          position: node.position
        };
        return;
      }
      hast(node, block.kind === "inline" ? INLINE_ELEMENT : BLOCK_ELEMENT, properties);
    }
    if (node.type === "heading") hast(node, undefined, { id: slug(plainText(node).trim()) });
    if (node.type === "paragraph" && (node.data as { directiveLabel?: boolean } | undefined)?.directiveLabel)
      hast(node, LABEL_ELEMENT, {});
    if ("children" in node) node.children.forEach((child, childIndex) => visit(child, node, childIndex));
  };
  visit(tree, null, 0);
  let ref = 0;
  for (const child of tree.children as (RootContent & { data?: Record<string, unknown> })[]) {
    if (child.type === "yaml") continue;
    ref += 1;
    (child.data ??= {}).hProperties = {
      ...(child.data.hProperties as object | undefined),
      "data-block-ref": `b${ref}`
    };
  }
}

/** The same dialect passes the server runs, packaged for a react-markdown `remarkPlugins` list. */
export function dialectRemarkPlugins(registry: BlockRegistry = defaultBlockRegistry): Pluggable[] {
  const dialect = () => (tree: Root, file: { value: unknown }) => {
    applyDialect(tree, String(file.value), registry);
    annotate(tree);
  };
  return [...REMARK_SYNTAX, dialect];
}
