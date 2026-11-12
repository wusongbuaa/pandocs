import * as React from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import clsx from "clsx";
import { Bold, ChevronDown, Code, Italic, Link2, MessageSquarePlus, Sparkles, Strikethrough, Subscript, Superscript } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "../ui/tooltip";
import type { AssistAction } from "../annotations/assist-card";
import { app } from "../data/runtime-data";
import { t } from "../i18n";

const GAP = 8;
const NAV_HEIGHT = 72;

const TURN_INTO: readonly { readonly label: string; run(editor: Editor): void; active(editor: Editor): boolean }[] = [
  { label: t("Normal text"), run: editor => editor.chain().focus().setParagraph().run(), active: editor => editor.isActive("paragraph") },
  { label: t("Heading 1"), run: editor => editor.chain().focus().toggleHeading({ level: 1 }).run(), active: editor => editor.isActive("heading", { level: 1 }) },
  { label: t("Heading 2"), run: editor => editor.chain().focus().toggleHeading({ level: 2 }).run(), active: editor => editor.isActive("heading", { level: 2 }) },
  { label: t("Heading 3"), run: editor => editor.chain().focus().toggleHeading({ level: 3 }).run(), active: editor => editor.isActive("heading", { level: 3 }) },
  { label: t("Bulleted list"), run: editor => editor.chain().focus().toggleBulletList().run(), active: editor => editor.isActive("bulletList") },
  { label: t("Numbered list"), run: editor => editor.chain().focus().toggleOrderedList().run(), active: editor => editor.isActive("orderedList") },
  { label: t("Task list"), run: editor => editor.chain().focus().toggleTaskList().run(), active: editor => editor.isActive("taskList") },
  { label: t("Code block"), run: editor => editor.chain().focus().toggleCodeBlock().run(), active: editor => editor.isActive("codeBlock") },
  { label: t("Quote"), run: editor => editor.chain().focus().toggleBlockquote().run(), active: editor => editor.isActive("blockquote") },
  { label: t("Callout"), run: editor => editor.chain().focus().wrapIn("tip").run(), active: editor => editor.isActive("tip") }
];

const AI_ACTIONS: readonly { readonly action: AssistAction; readonly label: string }[] = [
  { action: "rewrite", label: t("Rewrite") },
  { action: "translate", label: t("Translate") },
  { action: "summarize", label: t("Summarize") },
  { action: "explain", label: t("Explain") }
];

function Mark({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Tip label={label}><button type="button" className={clsx("pd-tool pd-tool--icon", active && "pd-tool--active")} aria-label={label} aria-pressed={active} onClick={onClick}>{children}</button></Tip>;
}

/** The toolbar over a selection while editing. Same look as the one in reading, with what Markdown can express. */
export function SelectionBubble({ editor, onComment, onAssist }: { editor: Editor; onComment: (quote: string) => void; onAssist: (action: AssistAction) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null);
  const [visible, setVisible] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  const [aiMenu, setAiMenu] = React.useState(false);
  const [linking, setLinking] = React.useState<string | null>(null);

  React.useEffect(() => {
    const hide = () => {
      setVisible(false);
      setMenu(false);
      setAiMenu(false);
      setLinking(null);
    };
    const focused = () => editor.view.hasFocus() || Boolean(ref.current?.contains(document.activeElement));
    const update = () => {
      const { selection } = editor.state;
      const selected = !selection.empty && !(selection instanceof NodeSelection) && editor.isEditable && !editor.isActive("codeBlock");
      if (!selected) {
        hide();
        return;
      }
      // Typing a link's address moves the focus into this toolbar. While it moves, the editor has lost it and the toolbar
      // does not have it yet, and the editor says so in a change of its own, so this looks again once the focus has landed.
      if (!focused()) {
        requestAnimationFrame(() => { if (!editor.isDestroyed && !focused()) hide(); });
        return;
      }
      setVisible(true);
      const from = editor.view.coordsAtPos(selection.from);
      const to = editor.view.coordsAtPos(selection.to);
      const element = ref.current;
      const width = element?.offsetWidth ?? 400;
      const height = element?.offsetHeight ?? 42;
      const middle = (Math.min(from.left, to.left) + Math.max(from.right, to.right)) / 2;
      const left = Math.min(Math.max(middle - width / 2, GAP), innerWidth - width - GAP);
      const above = from.top - height - GAP;
      setPosition({ top: above > NAV_HEIGHT ? above : to.bottom + GAP, left });
    };
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    editor.on("focus", update);
    const onBlur = ({ event }: { event: FocusEvent }) => {
      if (event.relatedTarget instanceof Node && ref.current?.contains(event.relatedTarget)) return;
      // Not every browser says where the focus is going, so this looks once it has got there.
      requestAnimationFrame(() => { if (!editor.isDestroyed && !focused()) setVisible(false); });
    };
    editor.on("blur", onBlur);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      editor.off("focus", update);
      editor.off("blur", onBlur);
      window.removeEventListener("scroll", update);
    };
  }, [editor]);

  if (!visible) return null;
  const chain = () => editor.chain().focus();
  const current = TURN_INTO.find(item => item.active(editor) && item.label !== t("Normal text"))?.label ?? t("Normal text");
  const applyLink = () => {
    if (linking) chain().extendMarkRange("link").setLink({ href: linking }).run();
    else chain().extendMarkRange("link").unsetLink().run();
    setLinking(null);
  };
  const quote = () => {
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, "\n");
  };
  return (
    <div ref={ref} className="pd-toolbar" role="toolbar" aria-label={t("Format the selected text")} style={position ?? { visibility: "hidden", top: 0, left: 0 }} onMouseDown={event => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}>
      {linking === null ? (
        <>
          <span className="pd-tool-group">
            <button type="button" className={clsx("pd-tool", menu && "pd-tool--open")} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>{current}<ChevronDown size={14} aria-hidden="true" /></button>
            {menu ? (
              <div className="pd-tool-menu pd-tool-menu--start" role="menu">
                {TURN_INTO.map(item => <button type="button" key={item.label} role="menuitem" className="pd-tool-menu__item" onClick={() => { item.run(editor); setMenu(false); }}><span>{item.label}</span></button>)}
              </div>
            ) : null}
          </span>
          <span className="pd-tool-sep" />
          <Mark label={t("Bold")} active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}><Bold size={16} aria-hidden="true" /></Mark>
          <Mark label={t("Italic")} active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}><Italic size={16} aria-hidden="true" /></Mark>
          <Mark label={t("Strikethrough")} active={editor.isActive("strike")} onClick={() => chain().toggleStrike().run()}><Strikethrough size={16} aria-hidden="true" /></Mark>
          <Mark label={t("Superscript")} active={editor.isActive("superscript")} onClick={() => editor.chain().focus().toggleMark("superscript").run()}><Superscript size={16} aria-hidden="true" /></Mark>
          <Mark label={t("Subscript")} active={editor.isActive("subscript")} onClick={() => editor.chain().focus().toggleMark("subscript").run()}><Subscript size={16} aria-hidden="true" /></Mark>
          <Mark label={t("Inline code")} active={editor.isActive("code")} onClick={() => chain().toggleCode().run()}><Code size={16} aria-hidden="true" /></Mark>
          <Mark label={t("Link")} active={editor.isActive("link")} onClick={() => setLinking(String(editor.getAttributes("link").href ?? ""))}><Link2 size={16} aria-hidden="true" /></Mark>
          <span className="pd-tool-sep" />
          <button type="button" className="pd-tool" onClick={() => onComment(quote())}><MessageSquarePlus size={16} aria-hidden="true" />{t("Comment")}</button>
          {app.bootstrap.ai?.configured ? (
            <span className="pd-tool-group">
              <button type="button" className={clsx("pd-tool", aiMenu && "pd-tool--open")} aria-haspopup="menu" aria-expanded={aiMenu} onClick={() => setAiMenu(!aiMenu)}><Sparkles size={16} aria-hidden="true" />AI<ChevronDown size={14} aria-hidden="true" /></button>
              {aiMenu ? (
                <div className="pd-tool-menu" role="menu">
                  {AI_ACTIONS.map(item => <button type="button" key={item.action} role="menuitem" className="pd-tool-menu__item" onClick={() => { setAiMenu(false); onAssist(item.action); }}><span>{item.label}</span></button>)}
                </div>
              ) : null}
            </span>
          ) : null}
        </>
      ) : (
        <form className="pd-link-form" onSubmit={event => { event.preventDefault(); applyLink(); }}>
          <input autoFocus value={linking} placeholder={t("Link address. For a page here, use a relative path such as ./getting-started.md")} aria-label={t("Link address")} onChange={event => setLinking(event.target.value)}
            onKeyDown={event => { if (event.key === "Escape") { setLinking(null); editor.commands.focus(); } }} />
          <Button type="submit">{t("OK")}</Button>
        </form>
      )}
    </div>
  );
}
