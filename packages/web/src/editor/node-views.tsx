import * as React from "react";
import "katex/dist/katex.min.css";
import { Button } from "@/components/ui/button";
import { Tip } from "../ui/tooltip";
import { TextareaField, TextField } from "../ui/form";
import { Popover } from "../ui/popover";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Plus, Settings2, Trash2 } from "lucide-react";
import type { BlockDefinition } from "@pandocs/markdown";
import { calloutTitle, calloutType, FencePreview, PREVIEWED_FENCES } from "../markdown/blocks";
import type { DialectViews } from "@pandocs/editor-model";
import { CompareView, HotspotsView } from "./media-views";
import { useCaretInside } from "./use-caret-inside";
import { t } from "../i18n";

const FIELD_LABELS: Readonly<Record<string, string>> = {
  label: t("Title"),
  title: t("Title"),
  emoji: t("Icon"),
  tone: t("Type"),
  width: t("Width (0 to 1)"),
  src: t("Address"),
  poster: t("Cover"),
  group: t("Group (tabs with the same name switch together)"),
  href: t("Link (such as ./page.md)"),
  before: t("Before image"),
  after: t("After image"),
  beforeLabel: t("Before label"),
  afterLabel: t("After label")
};

function BlockSettings({
  definition,
  node,
  updateAttributes,
  withoutLabel
}: { definition: BlockDefinition; withoutLabel?: boolean } & Pick<NodeViewProps, "node" | "updateAttributes">) {
  const keys = [...new Set([...(withoutLabel ? [] : ["label"]), ...Object.keys(definition.attrs.shape)])].filter(
    key => !(key === "title" && definition.kind === "container")
  );
  return (
    <Popover.Root>
      <Tip label={t("Settings")}>
        <Popover.Trigger
          className="pd-icon-button pd-icon-button--small"
          contentEditable={false}
          aria-label={t("Settings: {0}", t(definition.summary))}
        >
          <Settings2 size={14} aria-hidden="true" />
        </Popover.Trigger>
      </Tip>
      <Popover.Content className="pd-popover" align="end" sideOffset={6}>
        {keys.map(key => (
          <TextField
            key={key}
            label={FIELD_LABELS[key] ?? key}
            value={String(node.attrs[key] ?? "")}
            onChange={event => updateAttributes({ [key]: event.target.value || null })}
          />
        ))}
      </Popover.Content>
    </Popover.Root>
  );
}

/** Blocks look the way they read: a callout being edited is the theme's callout, with a settings button in its title. */
function CalloutView(props: NodeViewProps & { definition: BlockDefinition }) {
  const { definition, node } = props;
  const attrs = Object.fromEntries(
    Object.entries(node.attrs).filter(([, value]) => typeof value === "string")
  ) as Record<string, string>;
  const type = calloutType(definition.name, attrs);
  return (
    <NodeViewWrapper data-pandocs-block={definition.name} className={`rp-callout rp-callout--${type}`}>
      <div className="rp-callout__title pd-block-title" contentEditable={false}>
        <span>{(node.attrs.label as string | null) ?? attrs.title ?? calloutTitle(type)}</span>
        <BlockSettings {...props} />
      </div>
      <NodeViewContent className="rp-callout__content" />
    </NodeViewWrapper>
  );
}

/** The formula as it reads, with its source a click away. */
function MathView({ node, updateAttributes }: NodeViewProps) {
  const block = node.type.name === "mathBlock";
  const latex = String(node.attrs.latex ?? "");
  const [html, setHtml] = React.useState("");
  React.useEffect(() => {
    let current = true;
    void import("katex").then(({ default: katex }) => {
      if (current)
        setHtml(
          katex.renderToString(latex || t("\\text{Click to enter a formula}"), {
            displayMode: block,
            throwOnError: false,
            strict: false
          })
        );
    });
    return () => {
      current = false;
    };
  }, [block, latex]);
  return (
    <NodeViewWrapper
      as={block ? "div" : "span"}
      className={block ? "pd-math pd-math--block" : "pd-math"}
      contentEditable={false}
    >
      <Popover.Root>
        {/* KaTeX's own output, from its default safe mode: no links, no raw HTML. */}
        <Popover.Trigger
          nativeButton={false}
          render={
            <span
              role="button"
              tabIndex={0}
              aria-label={t("Edit formula")}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          }
        />
        <Popover.Content className="pd-popover" align="start" sideOffset={6}>
          <TextareaField
            label={t("Formula (LaTeX)")}
            mono
            rows={3}
            value={latex}
            onChange={event => updateAttributes({ latex: event.target.value })}
          />
        </Popover.Content>
      </Popover.Root>
    </NodeViewWrapper>
  );
}

const PREVIEW_DELAY_MS = 400;

/**
 * Diagrams, charts and file trees read as they will on the page. Putting the caret in one opens its source below,
 * with the preview following what is typed. The source stays in the document's flow, so the caret can always get in.
 */
function PreviewedCodeView({ editor, getPos, node }: NodeViewProps) {
  const info = String(node.attrs.language ?? "");
  const name = info.split(/\s/u, 1)[0] ?? "";
  const previewed = PREVIEWED_FENCES.has(name);
  const inside = useCaretInside({ editor, getPos, node }, previewed);
  const source = node.textContent;
  const [shown, setShown] = React.useState(source);
  React.useEffect(() => {
    const timer = setTimeout(() => setShown(source), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source]);
  const openSource = (event: React.MouseEvent) => {
    event.preventDefault();
    const position = getPos();
    if (typeof position === "number")
      editor
        .chain()
        .focus(position + 1)
        .run();
  };
  return (
    <NodeViewWrapper className="pd-code-view" data-code-language={name || undefined}>
      {previewed ? (
        <div className="pd-code-view__preview" contentEditable={false} data-pandocs-nontext="" onMouseDown={openSource}>
          <span className="pd-code-view__hint">{inside ? t("Editing source") : t("Click to edit source")}</span>
          <FencePreview name={name} info={info.slice(name.length).trim()} source={shown} />
        </div>
      ) : null}
      <pre
        className={previewed && !inside ? "pd-code-view__source pd-code-view__source--closed" : "pd-code-view__source"}
      >
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

function CodeBlockView(props: NodeViewProps) {
  const isHotspots = String(props.node.attrs.language ?? "").split(/\s/u, 1)[0] === "hotspots";
  return isHotspots ? <HotspotsView {...props} /> : <PreviewedCodeView {...props} />;
}

function ColumnsView({ definition }: NodeViewProps & { definition: BlockDefinition }) {
  return (
    <NodeViewWrapper data-pandocs-block={definition.name} className="pd-columns pd-columns--editing">
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

function ColumnView(props: NodeViewProps & { definition: BlockDefinition }) {
  const width = Number(props.node.attrs.width);
  return (
    <NodeViewWrapper
      data-pandocs-block={props.definition.name}
      className="pd-column pd-column--editing"
      style={width > 0 ? { flexGrow: width } : undefined}
    >
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

function StepsView({ definition }: NodeViewProps & { definition: BlockDefinition }) {
  return (
    <NodeViewWrapper data-pandocs-block={definition.name} className="pd-steps-edit">
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

/**
 * Tabs and cards laid out so everything in them can be reached and typed in. A pane that only showed when its tab is
 * picked would hide text from the caret, from find and from anyone checking a page before saving it.
 */
function GroupView(props: NodeViewProps & { definition: BlockDefinition; item: "tab" | "card"; addLabel: string }) {
  const { definition, editor, getPos, item, addLabel, node } = props;
  const add = () => {
    const position = getPos();
    if (typeof position !== "number") return;
    editor
      .chain()
      .focus()
      .insertContentAt(position + node.nodeSize - 1, {
        type: item,
        attrs: { label: item === "tab" ? t("New tab") : t("New card") },
        content: [{ type: "paragraph" }]
      })
      .run();
  };
  const hasSettings = Object.keys(definition.attrs.shape).length > 0;
  return (
    <NodeViewWrapper data-pandocs-block={definition.name} className={`pd-group-edit pd-group-edit--${definition.name}`}>
      <NodeViewContent />
      <div className="pd-group-edit__bar" contentEditable={false}>
        <Button variant="outline" onClick={add}>
          <Plus size={14} aria-hidden="true" />
          {addLabel}
        </Button>
        {hasSettings ? <BlockSettings {...props} withoutLabel /> : null}
      </div>
    </NodeViewWrapper>
  );
}

function PaneView(props: NodeViewProps & { definition: BlockDefinition }) {
  const { definition, deleteNode, node, updateAttributes } = props;
  const isCard = definition.name === "card";
  return (
    <NodeViewWrapper
      data-pandocs-block={definition.name}
      className={isCard ? "pd-doc-card pd-pane-edit" : "pd-pane-edit pd-pane-edit--tab"}
    >
      <div className="pd-pane-edit__head" contentEditable={false}>
        <input
          className="pd-pane-edit__label"
          aria-label={isCard ? t("Card title") : t("Tab name")}
          placeholder={isCard ? t("Card title") : t("Tab name")}
          value={String(node.attrs.label ?? "")}
          onChange={event => updateAttributes({ label: event.target.value || null })}
        />
        {isCard ? <BlockSettings {...props} withoutLabel /> : null}
        <Tip label={t("Delete")}>
          <button
            type="button"
            className="pd-icon-button pd-icon-button--small"
            aria-label={isCard ? t("Delete this card") : t("Delete this tab")}
            onClick={() => deleteNode()}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </Tip>
      </div>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

function ContainerView(props: NodeViewProps & { definition: BlockDefinition }) {
  const { name } = props.definition;
  if (name === "columns") return <ColumnsView {...props} />;
  if (name === "column") return <ColumnView {...props} />;
  if (name === "steps") return <StepsView {...props} />;
  if (name === "tabs") return <GroupView {...props} item="tab" addLabel={t("Add a tab")} />;
  if (name === "cards") return <GroupView {...props} item="card" addLabel={t("Add a card")} />;
  if (name === "tab" || name === "card") return <PaneView {...props} />;
  return <CalloutView {...props} />;
}

function LeafView(props: NodeViewProps & { definition: BlockDefinition }) {
  const { definition, node } = props;
  if (definition.name === "compare") return <CompareView {...props} settings={<BlockSettings {...props} />} />;
  const details = Object.keys(definition.attrs.shape)
    .map(key => node.attrs[key])
    .filter(Boolean)
    .join(" · ");
  return (
    <NodeViewWrapper data-pandocs-block={definition.name} className="pd-block-card">
      <span>
        {t(definition.summary)}
        {node.attrs.label ? t(": {0}", node.attrs.label as string) : ""}
        {details ? ` · ${details}` : ""}
      </span>
      <BlockSettings {...props} />
    </NodeViewWrapper>
  );
}

function InlineView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className="rp-badge rp-badge--info" contentEditable={false}>
      {String(node.attrs.label ?? "")}
    </NodeViewWrapper>
  );
}

function FootnoteView({ node, updateAttributes }: NodeViewProps) {
  const label = String(node.attrs.label ?? "");
  const text = String(node.attrs.text ?? "");
  return (
    <NodeViewWrapper className="pd-footnote-edit" contentEditable={false}>
      <sup>{label}</sup>
      <textarea
        aria-label={t("Footnote {0}", label)}
        rows={text.split("\n").length}
        value={text}
        onChange={event => updateAttributes({ text: event.target.value })}
      />
    </NodeViewWrapper>
  );
}

function RawView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper className="pd-block-card pd-block-card--raw" contentEditable={false}>
      <strong>
        {t("This block cannot be edited here: {0}. Saving leaves it unchanged.", String(node.attrs.directive ?? ""))}
      </strong>
      <pre>{String(node.attrs.raw ?? "")}</pre>
    </NodeViewWrapper>
  );
}

export const dialectViews: DialectViews = {
  code: () => ReactNodeViewRenderer(CodeBlockView),
  math: () => ReactNodeViewRenderer(MathView as never),
  container: definition => ReactNodeViewRenderer(props => <ContainerView {...props} definition={definition} />),
  leaf: definition => ReactNodeViewRenderer(props => <LeafView {...props} definition={definition} />),
  inline: () => ReactNodeViewRenderer(InlineView),
  raw: () => ReactNodeViewRenderer(RawView),
  footnote: () => ReactNodeViewRenderer(FootnoteView)
};
