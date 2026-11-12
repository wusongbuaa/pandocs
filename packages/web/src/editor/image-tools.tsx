import * as React from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import clsx from "clsx";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import { imageLayout } from "@pandocs/editor-model";
import { parseImageTitle, type ImageAlign } from "@pandocs/markdown";
import { fromInputMethod } from "../ui/input-method";
import { Tip } from "../ui/tooltip";
import { t } from "../i18n";

const ALIGNMENTS: readonly { readonly value: ImageAlign; readonly label: string; readonly icon: typeof AlignLeft }[] = [
  { value: "left", label: t("Align left"), icon: AlignLeft },
  { value: "center", label: t("Center"), icon: AlignCenter },
  { value: "right", label: t("Align right"), icon: AlignRight }
];

const CENTER_OFFSET = 170;

/**
 * Shown while an image is selected. The choices end up in the image's Markdown title, so they survive anywhere the file
 * goes. In the editor each is an attribute of its own, so that two people changing different ones keep both.
 */
export function ImageTools({ editor }: { editor: Editor }) {
  const [box, setBox] = React.useState<DOMRect | null>(null);
  // Spaces at the end of what is being typed would not survive a trip through the Markdown title.
  const [caption, setCaption] = React.useState<string | null>(null);
  const captionInput = React.useRef<HTMLInputElement>(null);
  const update = React.useCallback(() => {
    const { selection } = editor.state;
    // While someone types a caption the focus is there, and the image is still what they are working on.
    const image = selection instanceof NodeSelection && selection.node.type.name === "image" && (editor.view.hasFocus() || document.activeElement === captionInput.current);
    const dom = image ? editor.view.nodeDOM(selection.from) : null;
    setBox(dom instanceof HTMLElement ? dom.getBoundingClientRect() : null);
  }, [editor]);
  React.useEffect(() => {
    // Clicking into the caption blurs the editor, which must not take the caption away while it is getting the focus.
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const blur = transaction.getMeta("blur") as { event?: FocusEvent } | undefined;
      if (!captionInput.current || blur?.event?.relatedTarget !== captionInput.current) update();
    };
    editor.on("selectionUpdate", update);
    editor.on("transaction", onTransaction);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", onTransaction);
      window.removeEventListener("scroll", update);
    };
  }, [editor, update]);
  if (!box) return null;
  const attrs = editor.getAttributes("image");
  const layout = imageLayout(attrs);
  // A draft from before they were apart has all three in the title, which the first change takes apart.
  const apart = (change: Record<string, unknown>) => {
    const written = parseImageTitle(String(attrs.title ?? ""));
    const legacy = written.align !== undefined || written.width !== undefined;
    return legacy ? { title: layout.title || null, align: layout.align ?? null, width: layout.width ?? null, ...change } : change;
  };
  return (
    <div className="pd-toolbar" role="toolbar" aria-label={t("Image settings")} style={{ top: Math.max(box.top - 48, 72), left: Math.max(box.left + box.width / 2 - CENTER_OFFSET, 8) }} onMouseDown={event => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}>
      {ALIGNMENTS.map(({ value, label, icon: Icon }) => (
        <Tip key={value} label={label}><button type="button" className={clsx("pd-tool pd-tool--icon", layout.align === value && "pd-tool--active")} aria-label={label} aria-pressed={layout.align === value}
          onClick={() => editor.chain().focus().updateAttributes("image", apart({ align: value })).run()}>
          <Icon size={16} aria-hidden="true" />
        </button></Tip>
      ))}
      <input ref={captionInput} className="pd-image-caption" aria-label={t("Image caption")} placeholder={t("Add a caption")} value={caption ?? layout.title}
        onFocus={() => setCaption(layout.title)}
        onBlur={() => { setCaption(null); update(); }}
        onKeyDown={event => { if (event.key === "Enter" && !fromInputMethod(event)) { event.preventDefault(); editor.commands.focus(); } }}
        onChange={event => {
          setCaption(event.target.value);
          editor.chain().updateAttributes("image", apart({ title: event.target.value.trim() || null })).run();
        }} />
    </div>
  );
}
