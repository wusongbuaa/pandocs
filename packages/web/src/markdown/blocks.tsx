import * as React from "react";
import { NoSSR, useFrontmatter } from "@rspress/core/runtime";
import { MessageSquarePlus, Download, FileText } from "lucide-react";
import { Tooltip } from "@base-ui/react/tooltip";
import { Badge, Callout, Link, Prompt, Steps, type CalloutProps } from "@rspress/core/theme";
import { DocTabs, labelText } from "./tabs";
import { BLOCK_ELEMENT, defaultBlockRegistry, INLINE_ELEMENT, LABEL_ELEMENT, parseAttributes, resolveDocLink, UNKNOWN_ELEMENT } from "@pandocs/markdown";
import { Tip } from "../ui/tooltip";
import { documentRoute } from "../data/paths";
import { assetSource, BlockError, type BlockProps } from "./block-parts";
import { FileTree } from "./file-tree";
import { SAFE_URL } from "./pipeline";
import { Compare, Hotspots } from "./media-blocks";
import { useReader } from "./reader-context";
import { t } from "../i18n";

export { BlockError, type BlockProps } from "./block-parts";

const DiagramZoom = React.lazy(() => import("./diagram-zoom").then(module => ({ default: module.DiagramZoom })));
const Chart = React.lazy(() => import("./chart"));
const MindmapBlock = React.lazy(() => import("../present/mindmap-block"));

/** Callouts can carry an emoji where the official containers carry a type. */
const EMOJI_TYPES: Readonly<Record<string, CalloutProps["type"]>> = {
  "💡": "tip",
  "✅": "tip",
  "🔎": "tip",
  "🎯": "info",
  "👋": "note",
  "👥": "note",
  "💬": "note",
  "📷": "warning",
  "🔐": "warning",
  "❌": "danger"
};

const CALLOUT_TITLES: Readonly<Record<CalloutProps["type"], string>> = { note: t("Note"), tip: t("Tip"), info: t("Info"), important: t("Important"), warning: t("Warning"), caution: t("Caution"), danger: t("Danger"), details: t("Details") };

export function calloutTitle(type: CalloutProps["type"]): string {
  return CALLOUT_TITLES[type];
}

export function calloutType(name: string, attrs: Readonly<Record<string, string>>): CalloutProps["type"] {
  if (name !== "callout") return name as CalloutProps["type"];
  return (attrs.tone as CalloutProps["type"] | undefined) ?? EMOJI_TYPES[(attrs.emoji ?? "").replace(/️/gu, "")] ?? "note";
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** A directive's `[title]`. Rendered by whichever block it opens; the block finds it by this component. */
function Label({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function splitLabel(children: React.ReactNode) {
  const parts = React.Children.toArray(children);
  const label = parts.find(part => React.isValidElement(part) && part.type === Label);
  return { label, rest: parts.filter(part => part !== label) };
}

function DocCallout({ name, attrs, children }: BlockProps) {
  const type = calloutType(name, attrs);
  const { label, rest } = splitLabel(children);
  // A written title is part of the text; one the renderer supplies is not, or comment offsets would drift.
  const fallback = attrs.title ?? calloutTitle(type);
  const title = label ?? <span data-pandocs-nontext="">{fallback}</span>;
  return <Callout type={type} title={title as never}>{rest}</Callout>;
}

function StepsBlock({ children }: BlockProps) {
  return <Steps>{children}</Steps>;
}

/** The labels sit together above the panes, away from where each is written, so they are not part of the counted text. */
function TabsBlock({ attrs, children }: BlockProps) {
  const panes = React.Children.toArray(children).filter((child): child is React.ReactElement<ElementProps> => React.isValidElement(child) && (child.props as ElementProps)["data-name"] === "tab");
  const tabs = panes.map((pane, index) => {
    const label = splitLabel(pane.props.children).label ?? t("Tab {0}", index + 1);
    return { label: <span data-pandocs-nontext="">{label}</span>, value: labelText(label), content: pane };
  });
  return <DocTabs group={attrs.group} tabs={tabs} />;
}

function TabPane({ children }: BlockProps) {
  return <>{splitLabel(children).rest}</>;
}

function Cards({ children }: BlockProps) {
  return <div className="pd-doc-cards">{children}</div>;
}

/** The title is the link and its hit area covers the card, so a card can still hold lists and links of its own. */
function Card({ attrs, children }: BlockProps) {
  const { label, rest } = splitLabel(children);
  // A block's own attributes do not pass through the pipeline that cleans links.
  const href = attrs.href && SAFE_URL.test(attrs.href) ? attrs.href : undefined;
  return (
    <div className={href ? "pd-doc-card pd-doc-card--link" : "pd-doc-card"}>
      {label ? <div className="pd-doc-card__title">{href ? <DocLink href={href}>{label}</DocLink> : label}</div> : null}
      {rest}
    </div>
  );
}

function PromptBlock({ attrs, source = "" }: BlockProps) {
  return <Prompt title={attrs.title ?? t("Agent Prompt")} eyebrow={t("For your Agent")} prompt={source} {...(attrs.description ? { description: attrs.description } : {})} />;
}

function Columns({ children }: BlockProps) {
  return <div className="pd-columns">{children}</div>;
}

function Column({ attrs, children }: BlockProps) {
  const width = Number(attrs.width);
  return <div className="pd-column" style={width > 0 ? { flexGrow: width } : undefined}>{children}</div>;
}

function OriginalFile({ attrs, children }: BlockProps) {
  const { space } = useReader();
  return (
    <a className="pd-file rp-not-doc" href={assetSource(space.slug, attrs.src ?? "")} download data-pandocs-nontext="">
      <FileText size={20} aria-hidden="true" />
      <span className="pd-file__name">{children}</span>
      <span className="pd-file__action"><Download size={16} aria-hidden="true" />{t("Download the original file")}</span>
    </a>
  );
}

const ApiReference = React.lazy(() => import("./api-reference"));

/** Until it has loaded, and for whatever reads the page without running it, there is the document itself. */
function OpenApi({ attrs }: BlockProps) {
  const { space } = useReader();
  const { frontmatter } = useFrontmatter();
  const url = assetSource(space.slug, attrs.src ?? "");
  const link = <a className="pd-file rp-not-doc" href={url} download data-pandocs-nontext=""><FileText size={20} aria-hidden="true" /><span className="pd-file__name">{t("API reference")}</span><span className="pd-file__action"><Download size={16} aria-hidden="true" />{t("Download the OpenAPI document")}</span></a>;
  return <div className="rp-not-doc" data-pandocs-nontext=""><NoSSR fallback={link}><React.Suspense fallback={link}><ApiReference url={url} full={frontmatter.pageType === "doc-wide"} /></React.Suspense></NoSSR></div>;
}

function Video({ attrs, children }: BlockProps) {
  const { space } = useReader();
  return (
    <figure className="pd-video" data-pandocs-nontext="">
      <video controls preload="metadata" src={assetSource(space.slug, attrs.src ?? "")} poster={attrs.poster ? assetSource(space.slug, attrs.poster) : undefined} />
      {children ? <figcaption>{children}</figcaption> : null}
    </figure>
  );
}

function Subpages() {
  const { children, routePrefix, space } = useReader();
  if (children.length === 0) return <p data-pandocs-nontext="" className="pd-muted">{t("No subpages yet.")}</p>;
  return (
    <nav aria-label={t("Subpages")} data-pandocs-nontext="" className="rp-overview-group rp-not-doc">
      <div className="rp-overview-group__grid">
        {children.map(child => (
          <div key={child.id} className="rp-overview-group__grid-item rp-overview-group__item__title">
            <Link href={documentRoute(space.slug, child.path, routePrefix)} className="rp-overview-group__item__title__link">{child.title}</Link>
          </div>
        ))}
      </div>
    </nav>
  );
}

function Mermaid({ attrs, source = "", preview }: BlockProps) {
  const [svg, setSvg] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  const [enlarged, setEnlarged] = React.useState(false);
  const id = React.useId().replace(/[^a-zA-Z0-9]/gu, "");
  React.useEffect(() => {
    let current = true;
    let lastTheme = "";
    // Switching themes while a drawing is under way starts another; only the latest may land, or an older one could
    // finish last and leave a diagram in the theme just left.
    let runs = 0;
    const render = async () => {
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "default";
      if (theme === lastTheme) return;
      lastTheme = theme;
      const run = (runs += 1);
      const latest = () => current && run === runs;
      try {
        const { default: mermaid } = await import("mermaid");
        // Strict because the source may come from anyone who can write here, agents included.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
        // Rendering something invalid leaves an error diagram in the page; parsing first does not.
        await mermaid.parse(source);
        const rendered = await mermaid.render(`pandocs-mermaid-${id}`, source);
        if (latest()) {
          setSvg(rendered.svg);
          setFailed(false);
        }
      } catch {
        if (latest()) setFailed(true);
      }
    };
    void render();
    const observer = new MutationObserver(() => void render());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      current = false;
      observer.disconnect();
    };
  }, [id, source]);
  if (failed) return <BlockError title={t("This diagram cannot be shown")} source={source} />;
  const label = attrs.title ?? t("Diagram");
  if (preview || !svg) return <div className="pd-diagram" role="img" aria-label={label} data-pandocs-nontext="" dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <>
      <div className="pd-diagram pd-diagram--enlargeable" role="button" tabIndex={0} aria-label={t("Enlarge: {0}", label)} data-pandocs-nontext=""
        onClick={() => { if (!window.getSelection()?.toString()) setEnlarged(true); }}
        onKeyDown={event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setEnlarged(true);
        }}
        dangerouslySetInnerHTML={{ __html: svg }} />
      {enlarged ? <React.Suspense fallback={null}><DiagramZoom svg={svg} label={label} onClose={() => setEnlarged(false)} /></React.Suspense> : null}
    </>
  );
}

function TreeBlock({ attrs, source = "" }: BlockProps) {
  return <FileTree source={source} title={attrs.title} />;
}

function Tag({ attrs, children }: BlockProps) {
  return <Badge type={(attrs.tone as "tip" | undefined) ?? "info"}>{children}</Badge>;
}

function Mindmap(props: BlockProps) {
  return <div className="pd-mindmap" role="img" aria-label={props.attrs.title ?? t("Mind map")} data-pandocs-nontext=""><NoSSR><React.Suspense fallback={null}><MindmapBlock {...props} /></React.Suspense></NoSSR></div>;
}

function ChartBlock(props: BlockProps) {
  const placeholder = <div className="pd-chart" data-pandocs-nontext="" />;
  return <NoSSR fallback={placeholder}><React.Suspense fallback={placeholder}><Chart {...props} /></React.Suspense></NoSSR>;
}

export type BlockRenderer = React.ComponentType<BlockProps>;

const builtinRenderers: Readonly<Record<string, BlockRenderer>> = {
  callout: DocCallout,
  note: DocCallout,
  tip: DocCallout,
  info: DocCallout,
  important: DocCallout,
  warning: DocCallout,
  caution: DocCallout,
  danger: DocCallout,
  details: DocCallout,
  columns: Columns,
  column: Column,
  steps: StepsBlock,
  tabs: TabsBlock,
  tab: TabPane,
  cards: Cards,
  card: Card,
  prompt: PromptBlock,
  hotspots: Hotspots,
  mindmap: Mindmap,
  compare: Compare,
  video: Video,
  file: OriginalFile,
  openapi: OpenApi,
  subpages: Subpages,
  mermaid: Mermaid,
  chart: ChartBlock,
  tree: TreeBlock,
  tag: Tag
};

type ElementProps = React.HTMLAttributes<HTMLElement> & Record<string, unknown> & { children?: React.ReactNode };

/** Fenced blocks that read differently from their source, shown as they read while someone edits that source. */
export const PREVIEWED_FENCES: ReadonlySet<string> = new Set(["mermaid", "chart", "tree", "prompt", "mindmap"]);

export function FencePreview({ name, info, source }: { name: string; info: string; source: string }) {
  const Renderer = builtinRenderers[name];
  const attrs = React.useMemo(() => parseAttributes(info), [info]);
  const body = React.useMemo(() => {
    try {
      return defaultBlockRegistry.get(name)?.parseBody?.(source);
    } catch {
      return undefined;
    }
  }, [name, source]);
  return Renderer ? <Renderer name={name} attrs={attrs} source={source} body={body} preview /> : null;
}

function BlockCommentButton({ blockRef, label }: { blockRef: string; label: string }) {
  const { onCommentBlock } = useReader();
  if (!onCommentBlock) return null;
  return (
    <Tip label={label}><button type="button" className="pd-block-comment" aria-label={label} onClick={() => onCommentBlock(blockRef)}>
      <MessageSquarePlus size={16} aria-hidden="true" />
    </button></Tip>
  );
}

function BlockElement(props: ElementProps) {
  const name = String(props["data-name"] ?? "");
  const Renderer = builtinRenderers[name];
  const attrs = parseJson<Record<string, string>>(props["data-attrs"], {});
  const source = props["data-source"] as string | undefined;
  const body = parseJson<unknown>(props["data-body"], undefined);
  const ref = props["data-block-ref"] as string | undefined;
  const content = Renderer
    ? <Renderer name={name} attrs={attrs} source={source} body={body}>{props.children}</Renderer>
    : <BlockError title={t("Block {0} has no way to be shown", name)} source={source ?? ""} />;
  const hasOwnText = source === undefined && props["data-kind"] !== "leaf";
  if (!ref) return content;
  return (
    <div data-block-ref={ref} className="pd-block">
      {content}
      {hasOwnText ? null : <BlockCommentButton blockRef={ref} label={name === "mermaid" ? t("Comment on this diagram") : t("Comment on this block")} />}
    </div>
  );
}

function InlineElement(props: ElementProps) {
  const name = String(props["data-name"] ?? "");
  const Renderer = builtinRenderers[name];
  if (!Renderer) return <>{props.children}</>;
  return <Renderer name={name} attrs={parseJson<Record<string, string>>(props["data-attrs"], {})}>{props.children}</Renderer>;
}

function DocLink({ href = "", children, ...rest }: React.ComponentProps<"a">) {
  const { currentPath, routePrefix, space } = useReader();
  const target = resolveDocLink(currentPath, href);
  if (target) return <Link {...rest} href={`${documentRoute(space.slug, target.path, routePrefix)}${target.hash ? `#${encodeURIComponent(target.hash)}` : ""}`}>{children}</Link>;
  // Footnote numbers are not part of the source's visible text.
  if ((rest as Record<string, unknown>)["data-footnote-ref"] !== undefined) return <a href={href} {...rest} data-pandocs-nontext="">{children}</a>;
  return <Link {...rest} href={href}>{children}</Link>;
}

function DocImage({ src = "", alt = "", title, ...rest }: React.ComponentProps<"img">) {
  const { space } = useReader();
  const blockRef = (rest as Record<string, unknown>)["data-block-ref"] as string | undefined;
  const image = <img {...rest} src={assetSource(space.slug, src).startsWith("/") || /^[a-z]+:/iu.test(src) ? assetSource(space.slug, src) : src} alt={alt} data-block-ref={blockRef} />;
  if (!title) return image;
  // Inside a paragraph, which cannot hold a `figure`. The server counts no text for an image, so the caption is not counted either.
  return <span className="pd-figure" data-align={(rest as Record<string, unknown>)["data-align"] as string | undefined}>{image}<span className="pd-figure__caption" data-pandocs-nontext="">{title}</span></span>;
}

/** Images sit in their own paragraph, which is the block a discussion attaches to. */
function DocParagraph({ children, ...rest }: React.ComponentProps<"p">) {
  const ref = (rest as Record<string, unknown>)["data-block-ref"] as string | undefined;
  const hasImage = React.Children.toArray(children).some(child => React.isValidElement(child) && child.type === DocImage);
  return (
    <p {...rest} className={hasImage ? "pd-block" : undefined}>
      {children}
      {hasImage && ref ? <BlockCommentButton blockRef={ref} label={t("Comment on this image")} /> : null}
    </p>
  );
}

function FootnoteSection({ children, ...rest }: React.ComponentProps<"section">) {
  return <section {...rest} {...((rest as Record<string, unknown>)["data-footnotes"] !== undefined ? { "data-pandocs-nontext": "" } : {})}>{children}</section>;
}

/** Stand-ins for what the MDX compiler would have produced, on top of the theme's own tag components. */
function GlossaryTerm({ children, "data-definition": definition, ...rest }: React.ComponentProps<"abbr"> & { "data-definition"?: string }) {
  if (!definition) return <abbr {...rest}>{children}</abbr>;
  return (
    <Tooltip.Provider delay={150}>
      <Tooltip.Root>
        <Tooltip.Trigger render={<abbr className="pd-term" tabIndex={0}>{children}</abbr>} />
        <Tooltip.Portal><Tooltip.Positioner className="pd-floating" side="top" sideOffset={6}><Tooltip.Popup className="pd-term-tip">{definition}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export const dialectComponents = {
  abbr: GlossaryTerm,
  [BLOCK_ELEMENT]: ({ node: _node, ...props }: ElementProps & { node?: unknown }) => <BlockElement {...props} />,
  [INLINE_ELEMENT]: ({ node: _node, ...props }: ElementProps & { node?: unknown }) => <InlineElement {...props} />,
  [UNKNOWN_ELEMENT]: ({ node: _node, ...props }: ElementProps & { node?: unknown }) => <BlockError title={t("Unsupported block: {0}", String(props["data-name"] ?? ""))} source={String(props["data-raw"] ?? "")} />,
  [LABEL_ELEMENT]: Label,
  a: DocLink,
  img: DocImage,
  p: DocParagraph,
  section: FootnoteSection
};
