import * as React from "react";
import type { Editor } from "@tiptap/core";
import { t } from "../i18n";

const ACTIONS: readonly { readonly label: string; run(editor: Editor): void }[] = [
  { label: t("Insert row above"), run: editor => editor.chain().focus().addRowBefore().run() },
  { label: t("Insert row below"), run: editor => editor.chain().focus().addRowAfter().run() },
  { label: t("Insert column left"), run: editor => editor.chain().focus().addColumnBefore().run() },
  { label: t("Insert column right"), run: editor => editor.chain().focus().addColumnAfter().run() },
  { label: t("Delete row"), run: editor => editor.chain().focus().deleteRow().run() },
  { label: t("Delete column"), run: editor => editor.chain().focus().deleteColumn().run() },
  { label: t("Delete table"), run: editor => editor.chain().focus().deleteTable().run() }
];

/** Rows and columns can only be changed from here while the cursor is in a table. */
export function TableTools({ editor }: { editor: Editor }) {
  const [box, setBox] = React.useState<DOMRect | null>(null);
  React.useEffect(() => {
    const update = () => {
      if (!editor.isActive("table") || !editor.view.hasFocus()) {
        setBox(null);
        return;
      }
      const at = editor.view.domAtPos(editor.state.selection.from).node;
      const element = at instanceof Element ? at : at.parentElement;
      setBox(element?.closest("table")?.getBoundingClientRect() ?? null);
    };
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    editor.on("blur", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      editor.off("blur", update);
      window.removeEventListener("scroll", update);
    };
  }, [editor]);
  if (!box) return null;
  return (
    <div
      className="pd-toolbar pd-table-tools"
      role="toolbar"
      aria-label={t("Table actions")}
      style={{ top: Math.max(box.top - 48, 72), left: box.left }}
      onMouseDown={event => event.preventDefault()}
    >
      {ACTIONS.map(action => (
        <button type="button" key={action.label} className="pd-tool" onClick={() => action.run(editor)}>
          {action.label}
        </button>
      ))}
    </div>
  );
}
