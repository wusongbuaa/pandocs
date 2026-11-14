import * as React from "react";
import type { NodeViewProps } from "@tiptap/react";

/** The selection is inside this node's text, which the source stays open for. */
export function useCaretInside(
  { editor, getPos, node }: Pick<NodeViewProps, "editor" | "getPos" | "node">,
  watching: boolean
): boolean {
  const [inside, setInside] = React.useState(false);
  React.useEffect(() => {
    if (!watching) return undefined;
    const update = () => {
      const position = getPos();
      const { from, to } = editor.state.selection;
      setInside(editor.isFocused && typeof position === "number" && from > position && to < position + node.nodeSize);
    };
    update();
    editor.on("selectionUpdate", update);
    editor.on("focus", update);
    editor.on("blur", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("focus", update);
      editor.off("blur", update);
    };
  }, [editor, getPos, node, watching]);
  return inside;
}
