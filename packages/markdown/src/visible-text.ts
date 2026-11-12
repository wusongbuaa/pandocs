import type { Nodes } from "mdast";
import { dialectOf, type ParsedDocument } from "./parse.js";
import { defaultBlockRegistry, type BlockRegistry } from "./registry.js";

const FLOW = new Set([
  "root",
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "containerDirective",
  "code",
  "thematicBreak"
]);

/** The text a reader sees, in document order. Images, diagrams and unknown blocks take block anchors instead. */
export function visibleText(document: ParsedDocument, registry: BlockRegistry = defaultBlockRegistry): string {
  return visibleTextOf(document.tree, registry);
}

export function visibleTextOf(root: Nodes, registry: BlockRegistry = defaultBlockRegistry): string {
  const walk = (node: Nodes): string => {
    // Formulas render as typesetting rather than their source, so they take block anchors like images do.
    const type: string = node.type;
    if (type === "math" || type === "inlineMath") return "";
    switch (node.type) {
      case "text":
      case "inlineCode":
        return node.value;
      case "break":
        return "\n";
      case "html":
      case "image":
      case "imageReference":
      case "yaml":
      case "definition":
      case "footnoteDefinition":
      case "footnoteReference":
      case "leafDirective":
        return "";
      case "code": {
        const hidden =
          node.lang && registry.get(node.lang)?.kind === "fence" && registry.get(node.lang)?.visibleText === false;
        return hidden ? "" : `${node.value}\n`;
      }
      default:
        break;
    }
    if (dialectOf(node).pandocsUnknown) return "";
    if (!("children" in node)) return "";
    const labelHidden = node.type === "containerDirective" && registry.get(node.name)?.labelText === false;
    const shown = labelHidden
      ? node.children.filter(child => !(child.data as { directiveLabel?: boolean } | undefined)?.directiveLabel)
      : node.children;
    const text = shown.map(walk).join("");
    return FLOW.has(node.type) ? `${text}\n` : text;
  };
  return walk(root);
}

/** Offsets count non-whitespace characters: the DOM and the source disagree on whitespace, never on the rest. */
export function squashWhitespace(text: string): string {
  return text.replace(/\s+/gu, "");
}
