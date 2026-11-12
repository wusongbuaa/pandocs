import type { Editor, JSONContent, Range } from "@tiptap/core";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BookOpenText,
  Bot,
  ChevronRight,
  Code,
  Columns2,
  FileStack,
  Film,
  FolderTree,
  Footprints,
  GitBranch,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Info,
  LayoutGrid,
  Lightbulb,
  List,
  ListOrdered,
  ListTodo,
  MapPin,
  Minus,
  Network,
  OctagonAlert,
  PanelTop,
  PieChart,
  Quote,
  Sigma,
  SquareSplitHorizontal,
  Star,
  StickyNote,
  Table,
  Type
} from "lucide-react";
import { defaultBlockRegistry, type BlockRegistry } from "@pandocs/markdown";
import { t } from "../i18n";

const EMPTY_PARAGRAPH: JSONContent = { type: "paragraph" };
const stepHeading = (text: string): JSONContent => ({
  type: "heading",
  attrs: { level: 3 },
  content: [{ type: "text", text }]
});
const pane = (type: string, label: string): JSONContent => ({ type, attrs: { label }, content: [EMPTY_PARAGRAPH] });

/** Blocks that mean nothing empty start out with the parts they are made of. */
const STARTERS: Readonly<Record<string, JSONContent>> = {
  columns: {
    type: "columns",
    content: [
      { type: "column", attrs: { width: "0.5" }, content: [EMPTY_PARAGRAPH] },
      { type: "column", attrs: { width: "0.5" }, content: [EMPTY_PARAGRAPH] }
    ]
  },
  steps: {
    type: "steps",
    content: [stepHeading(t("First step")), EMPTY_PARAGRAPH, stepHeading(t("Second step")), EMPTY_PARAGRAPH]
  },
  tabs: { type: "tabs", content: [pane("tab", t("Tab one")), pane("tab", t("Tab two"))] },
  cards: { type: "cards", content: [pane("card", t("Card one")), pane("card", t("Card two"))] },
  hotspots: { type: "codeBlock", attrs: { language: "hotspots" }, content: [{ type: "text", text: "[]" }] }
};

export function insertBlock(editor: Editor, registry: BlockRegistry, name: string): void {
  const definition = registry.get(name);
  if (!definition) return;
  const chain = editor.chain().focus();
  if (STARTERS[name]) {
    chain.insertContent(STARTERS[name]).run();
  } else if (definition.kind === "container") {
    chain.insertContent({ type: name, content: [{ type: "paragraph" }] }).run();
  } else if (definition.kind === "fence") {
    const [, ...lines] = t(definition.example).split("\n");
    chain
      .insertContent({
        type: "codeBlock",
        attrs: { language: name },
        content: [{ type: "text", text: lines.slice(0, -1).join("\n") }]
      })
      .run();
  } else if (definition.kind === "inline") {
    chain.insertContent({ type: name, attrs: { label: t("Tag") } }).run();
  } else {
    chain.insertContent({ type: name }).run();
  }
}

export interface SlashItem {
  readonly id: string;
  readonly label: string;
  /** Searched as well as the label, so `/bt` and `/title` both find headings. */
  readonly keywords: string;
  readonly icon: LucideIcon;
  run(editor: Editor): void;
}

const block = (
  id: string,
  label: string,
  keywords: string,
  icon: LucideIcon,
  registry: BlockRegistry = defaultBlockRegistry
): SlashItem => ({
  id,
  label,
  keywords,
  icon,
  run: editor => insertBlock(editor, registry, id)
});

export function slashItems(onImage: () => void, onApiDocument: () => void): readonly SlashItem[] {
  return [
    {
      id: "paragraph",
      label: t("Normal text"),
      keywords: "zw text paragraph",
      icon: Type,
      run: editor => editor.chain().focus().setParagraph().run()
    },
    {
      id: "h1",
      label: t("Heading 1"),
      keywords: "bt yj title heading h1",
      icon: Heading1,
      run: editor => editor.chain().focus().setHeading({ level: 1 }).run()
    },
    {
      id: "h2",
      label: t("Heading 2"),
      keywords: "bt ej title heading h2",
      icon: Heading2,
      run: editor => editor.chain().focus().setHeading({ level: 2 }).run()
    },
    {
      id: "h3",
      label: t("Heading 3"),
      keywords: "bt sj title heading h3",
      icon: Heading3,
      run: editor => editor.chain().focus().setHeading({ level: 3 }).run()
    },
    {
      id: "bullet",
      label: t("Bulleted list"),
      keywords: "lb wx list bullet ul",
      icon: List,
      run: editor => editor.chain().focus().toggleBulletList().run()
    },
    {
      id: "ordered",
      label: t("Numbered list"),
      keywords: "lb yx list ordered ol",
      icon: ListOrdered,
      run: editor => editor.chain().focus().toggleOrderedList().run()
    },
    {
      id: "task",
      label: t("Task list"),
      keywords: "rw lb task todo",
      icon: ListTodo,
      run: editor => editor.chain().focus().toggleTaskList().run()
    },
    {
      id: "quote",
      label: t("Quote"),
      keywords: "yy quote",
      icon: Quote,
      run: editor => editor.chain().focus().toggleBlockquote().run()
    },
    {
      id: "code",
      label: t("Code block"),
      keywords: "dm code",
      icon: Code,
      run: editor => editor.chain().focus().toggleCodeBlock().run()
    },
    {
      id: "divider",
      label: t("Divider"),
      keywords: "fgx divider hr",
      icon: Minus,
      run: editor => editor.chain().focus().setHorizontalRule().run()
    },
    {
      id: "table",
      label: t("Table"),
      keywords: "bg table",
      icon: Table,
      run: editor => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    },
    { id: "image", label: t("Image"), keywords: "tp image picture", icon: ImagePlus, run: () => onImage() },
    block("tip", t("Tip"), "ts tip callout", Lightbulb),
    block("info", t("Info"), "sm info callout", Info),
    block("note", t("Note"), "bz note callout", StickyNote),
    block("important", t("Important"), "zy important callout", Star),
    block("warning", t("Warning"), "zy warning callout", AlertTriangle),
    block("danger", t("Danger"), "wx danger callout", OctagonAlert),
    block("details", t("Collapsible section"), "zd details", ChevronRight),
    block("columns", t("Columns"), "fl columns", Columns2),
    block("steps", t("Steps"), "bz steps", Footprints),
    block("tabs", t("Tabs"), "bqy tabs", PanelTop),
    block("cards", t("Cards"), "kp cards", LayoutGrid),
    block("prompt", t("Agent Prompt"), "tsc prompt agent ai", Bot),
    block("hotspots", t("Annotated screenshot"), "jtbz dd hotspots", MapPin),
    block("compare", t("Before and after"), "xjdb compare", SquareSplitHorizontal),
    block("subpages", t("Subpage list"), "zym subpages", FileStack),
    block("video", t("Video"), "sp video", Film),
    {
      id: "openapi",
      label: t("API reference"),
      keywords: "jk api openapi swagger",
      icon: BookOpenText,
      run: () => onApiDocument()
    },
    block("mermaid", t("Diagram"), "lct mermaid flow", GitBranch),
    block("mindmap", t("Mind map"), "nt mindmap", Network),
    {
      id: "math",
      label: t("Formula"),
      keywords: "gs math formula latex katex",
      icon: Sigma,
      run: editor =>
        editor
          .chain()
          .focus()
          .insertContent({ type: "mathBlock", attrs: { latex: "E = mc^2" } })
          .run()
    },
    block("tree", t("File tree"), "wjs tree file", FolderTree),
    block("chart", t("Chart"), "tb chart", PieChart)
  ];
}

export function runSlashItem(editor: Editor, range: Range, item: SlashItem): void {
  editor.chain().focus().deleteRange(range).run();
  item.run(editor);
}
