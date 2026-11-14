import * as React from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { GripVertical, Plus } from "lucide-react";
import { Tip } from "../ui/tooltip";
import { t } from "../i18n";

interface HoveredBlock {
  readonly pos: number;
  readonly top: number;
  readonly left: number;
}

const GUTTER = 56;

/**
 * Starts moving the block at a position, for ProseMirror to finish where it is dropped. The block goes with the drag,
 * so the drop removes that block: left to remove whatever is selected by then, it cleared a table's cells and left the
 * table, because selecting a whole table selects its cells.
 */
export function startBlockDrag(view: EditorView, pos: number): NodeSelection {
  const selection = NodeSelection.create(view.state.doc, pos);
  view.dispatch(view.state.tr.setSelection(selection));
  (view as unknown as { dragging: unknown }).dragging = { slice: selection.content(), move: true, node: selection };
  return selection;
}

/** Hover a block to get its handle: drag to move it, or add a block below. ProseMirror does the moving once `dragging` is set. */
export function BlockHandle({ editor }: { editor: Editor }) {
  const [hovered, setHovered] = React.useState<HoveredBlock | null>(null);
  React.useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!editor.view.dom.isConnected) return;
      const box = editor.view.dom.getBoundingClientRect();
      const inRange =
        event.clientY >= box.top &&
        event.clientY <= box.bottom &&
        event.clientX >= box.left - GUTTER &&
        event.clientX <= box.right;
      if (!inRange) {
        setHovered(null);
        return;
      }
      const found = editor.view.posAtCoords({ left: Math.max(event.clientX, box.left + 1), top: event.clientY });
      if (!found) return;
      const $pos = editor.state.doc.resolve(found.pos);
      const pos = $pos.depth > 0 ? $pos.before(1) : found.pos;
      const dom = editor.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(dom).lineHeight) || 28;
      setHovered({ pos, top: rect.top + Math.min(lineHeight, rect.height) / 2 - 12, left: box.left - GUTTER + 4 });
    };
    const onLeave = () => setHovered(null);
    document.addEventListener("mousemove", onMove);
    window.addEventListener("scroll", onLeave, { passive: true });
    return () => {
      document.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onLeave);
    };
  }, [editor]);
  if (!hovered) return null;
  const startDrag = (event: React.DragEvent) => {
    const { view } = editor;
    startBlockDrag(view, hovered.pos);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "");
    const dom = view.nodeDOM(hovered.pos);
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);
  };
  const addBelow = () => {
    const node = editor.state.doc.nodeAt(hovered.pos);
    if (!node) return;
    const at = hovered.pos + node.nodeSize;
    // Typing `/` is what opens the menu, so a new block starts with it.
    editor
      .chain()
      .insertContentAt(at, { type: "paragraph", content: [{ type: "text", text: "/" }] })
      .focus(at + 2)
      .run();
  };
  return (
    <div className="pd-block-handle" style={{ top: hovered.top, left: hovered.left }} contentEditable={false}>
      <Tip label={t("Add below")}>
        <button
          type="button"
          className="pd-icon-button pd-icon-button--small"
          aria-label={t("Add below")}
          onClick={addBelow}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
      </Tip>
      <Tip label={t("Drag")}>
        <button
          type="button"
          className="pd-icon-button pd-icon-button--small pd-block-handle__grip"
          draggable
          aria-label={t("Drag this block")}
          onDragStart={startDrag}
        >
          <GripVertical size={15} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}
