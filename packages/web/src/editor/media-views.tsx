import * as React from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Code, ImagePlus, Trash2 } from "lucide-react";
import { defaultBlockRegistry, formatAttributes, MAX_HOTSPOTS, parseAttributes, type HotspotsBody } from "@pandocs/markdown";
import { Button } from "@/components/ui/button";
import { Tip } from "../ui/tooltip";
import { failureMessage } from "../api/client";
import { assetSource } from "../markdown/block-parts";
import { Compare } from "../markdown/media-blocks";
import { useReader } from "../markdown/reader-context";
import { toast } from "../ui/toast";
import { uploadAsset } from "./upload";
import { useCaretInside } from "./use-caret-inside";
import { t } from "../i18n";

function ImagePicker({ label, onPicked }: { label: string; onPicked: (path: string) => void }) {
  const { space } = useReader();
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      onPicked(await uploadAsset(space.slug, file));
    } catch (error) {
      toast(failureMessage(error, t("Image upload failed")), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={14} aria-hidden="true" />{busy ? t("Uploading…") : label}</Button>
      <input ref={input} type="file" accept="image/*" hidden aria-hidden="true" onChange={event => {
        const file = event.target.files?.[0];
        if (file) void upload(file);
        event.target.value = "";
      }} />
    </>
  );
}

export function CompareView({ node, updateAttributes, settings }: NodeViewProps & { settings: React.ReactNode }) {
  const attrs = Object.fromEntries(Object.entries(node.attrs).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  return (
    <NodeViewWrapper data-pandocs-block="compare" className="pd-media-edit" contentEditable={false}>
      {attrs.before && attrs.after
        ? <Compare name="compare" attrs={attrs}>{attrs.label}</Compare>
        : <div className="pd-media-edit__empty">{t("Choose a before and an after image. Readers drag the divider to compare them.")}</div>}
      <div className="pd-media-edit__bar">
        <ImagePicker label={attrs.before ? t("Change the before image") : t("Choose the before image")} onPicked={path => updateAttributes({ before: path })} />
        <ImagePicker label={attrs.after ? t("Change the after image") : t("Choose the after image")} onPicked={path => updateAttributes({ after: path })} />
        {settings}
      </div>
    </NodeViewWrapper>
  );
}

function pointsOf(source: string): HotspotsBody | null {
  try {
    return defaultBlockRegistry.get("hotspots")!.parseBody!(source) as HotspotsBody;
  } catch {
    return null;
  }
}

const percent = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

/** Clicking the screenshot adds a mark and dragging moves one. All of it ends up in the block's JSON, which stays editable. */
export function HotspotsView({ editor, getPos, node, updateAttributes }: NodeViewProps) {
  const { space } = useReader();
  const info = String(node.attrs.language ?? "");
  const attrs = parseAttributes(info.slice(info.split(/\s/u, 1)[0]!.length));
  const source = node.textContent;
  const points = React.useMemo(() => pointsOf(source), [source]);
  const inside = useCaretInside({ editor, getPos, node }, true);
  const stage = React.useRef<HTMLDivElement>(null);
  const [moving, setMoving] = React.useState<{ readonly index: number; readonly x: number; readonly y: number } | null>(null);

  const write = (next: HotspotsBody) => {
    const position = getPos();
    if (typeof position !== "number") return;
    editor.view.dispatch(editor.state.tr.replaceWith(position + 1, position + node.nodeSize - 1, editor.schema.text(JSON.stringify(next, null, 2))));
  };
  const pointerAt = (event: { clientX: number; clientY: number }) => {
    const box = stage.current!.getBoundingClientRect();
    return { x: percent(((event.clientX - box.left) / box.width) * 100), y: percent(((event.clientY - box.top) / box.height) * 100) };
  };
  const openSource = () => {
    const position = getPos();
    if (typeof position === "number") editor.chain().focus(position + 1).run();
  };

  return (
    <NodeViewWrapper className="pd-code-view pd-hotspots-edit" data-code-language="hotspots">
      <div contentEditable={false} data-pandocs-nontext="">
        {attrs.src ? (
          <div ref={stage} className="pd-hotspots__stage pd-hotspots-edit__stage" onClick={event => { if (points && points.length < MAX_HOTSPOTS) write([...points, { ...pointerAt(event), title: "" }]); }}>
            <img src={assetSource(space.slug, attrs.src)} alt={attrs.alt ?? ""} draggable={false} />
            {(points ?? []).map((point, index) => {
              const shown = moving?.index === index ? moving : point;
              return (
                <button type="button" key={index} className="pd-hotspots__mark" style={{ left: `${shown.x}%`, top: `${shown.y}%` }} aria-label={t("Note {0}, drag to move it", index + 1)}
                  onClick={event => event.stopPropagation()}
                  onPointerDown={event => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setMoving({ index, x: point.x, y: point.y });
                  }}
                  onPointerMove={event => { if (moving?.index === index) setMoving({ index, ...pointerAt(event) }); }}
                  onPointerUp={() => {
                    if (moving && points && (moving.x !== point.x || moving.y !== point.y)) write(points.map((item, at) => (at === index ? { ...item, x: moving.x, y: moving.y } : item)));
                    setMoving(null);
                  }}>{index + 1}</button>
              );
            })}
          </div>
        ) : <div className="pd-media-edit__empty">{t("Choose a screenshot, then click the spot you want to explain")}</div>}
        <div className="pd-media-edit__bar">
          <ImagePicker label={attrs.src ? t("Change screenshot") : t("Choose screenshot")} onPicked={path => updateAttributes({ language: `hotspots ${formatAttributes({ ...attrs, src: path }).slice(1, -1)}` })} />
          <Button variant="outline" onClick={openSource}><Code size={14} aria-hidden="true" />{t("Edit source")}</Button>
          {attrs.src && points?.length === 0 ? <span className="pd-muted">{t("Click the image to add the first note")}</span> : null}
          {points ? null : <span className="pd-muted">{t("The JSON has an error. Fix the source to use clicks.")}</span>}
        </div>
        {points && points.length > 0 ? (
          <ol className="pd-hotspots-edit__list">
            {points.map((point, index) => (
              <li key={index}>
                <span className="pd-hotspots-edit__number">{index + 1}</span>
                <div className="pd-hotspots-edit__fields">
                  <input aria-label={t("Title of note {0}", index + 1)} placeholder={t("Title")} value={point.title} onChange={event => write(points.map((item, at) => (at === index ? { ...item, title: event.target.value } : item)))} />
                  <input aria-label={t("Text of note {0}", index + 1)} placeholder={t("Note (optional)")} value={point.text ?? ""} onChange={event => write(points.map((item, at) => {
                    if (at !== index) return item;
                    const { text: _text, ...rest } = item;
                    return event.target.value ? { ...rest, text: event.target.value } : rest;
                  }))} />
                </div>
                <Tip label={t("Delete")}><button type="button" className="pd-icon-button pd-icon-button--small" aria-label={t("Delete note {0}", index + 1)} onClick={() => write(points.filter((_item, at) => at !== index))}><Trash2 size={14} aria-hidden="true" /></button></Tip>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <pre className={inside ? "pd-code-view__source" : "pd-code-view__source pd-code-view__source--closed"}><NodeViewContent<"code"> as="code" /></pre>
    </NodeViewWrapper>
  );
}
