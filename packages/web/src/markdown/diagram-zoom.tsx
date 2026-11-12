import * as React from "react";
import { Maximize, Minus, Plus, X } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { Tip } from "../ui/tooltip";
import { t } from "../i18n";

export interface ZoomView {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

const FITTED: ZoomView = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const BUTTON_STEP = 1.5;
const WHEEL_SPEED = 0.002;
/** A small diagram stays a diagram, rather than three enormous boxes filling the window. */
const MOST_ENLARGED_WHEN_FITTED = 2.5;
const FIT_MARGIN = 32;

/** The point under the pointer stays where it is while everything around it grows. */
export function zoomAround(view: ZoomView, at: { readonly x: number; readonly y: number }, factor: number): ZoomView {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const applied = scale / view.scale;
  return { scale, x: at.x - (at.x - view.x) * applied, y: at.y - (at.y - view.y) * applied };
}

function ZoomStage({ svg, label }: { svg: string; label: string }) {
  const stage = React.useRef<HTMLDivElement>(null);
  const canvas = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef<{ readonly x: number; readonly y: number } | null>(null);
  const [view, setView] = React.useState(FITTED);

  React.useLayoutEffect(() => {
    const box = stage.current!;
    const image = canvas.current!.querySelector("svg");
    const { width = 0, height = 0 } = image?.viewBox.baseVal ?? {};
    if (!image || !width || !height) return undefined;
    const fit = () => {
      const scale = Math.min(
        (box.clientWidth - FIT_MARGIN * 2) / width,
        (box.clientHeight - FIT_MARGIN * 2) / height,
        MOST_ENLARGED_WHEN_FITTED
      );
      image.style.width = `${width * scale}px`;
      image.style.height = `${height * scale}px`;
      image.style.maxWidth = "none";
    };
    fit();
    const resized = new ResizeObserver(fit);
    resized.observe(box);
    return () => resized.disconnect();
  }, [svg]);

  // React listens for the wheel passively, and the page behind must not scroll.
  React.useEffect(() => {
    const box = stage.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { left, top } = box.getBoundingClientRect();
      setView(current =>
        zoomAround(current, { x: event.clientX - left, y: event.clientY - top }, Math.exp(-event.deltaY * WHEEL_SPEED))
      );
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  const zoomFromCentre = (factor: number) => {
    const box = stage.current!;
    setView(current => zoomAround(current, { x: box.clientWidth / 2, y: box.clientHeight / 2 }, factor));
  };

  return (
    // Focus starts here, for the keys below. On a button, it would open that button's tooltip, and Escape would close only that.
    <div
      className="pd-zoom__inner"
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key === "+" || event.key === "=") zoomFromCentre(BUTTON_STEP);
        else if (event.key === "-") zoomFromCentre(1 / BUTTON_STEP);
        else if (event.key === "0") setView(FITTED);
      }}
    >
      <header className="pd-zoom__bar">
        <Dialog.Title className="pd-zoom__title">{label}</Dialog.Title>
        <span className="pd-zoom__hint">{t("Scroll to zoom, drag to move, Esc to close")}</span>
        <Tip label={t("Zoom out")}>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("Zoom out")}
            onClick={() => zoomFromCentre(1 / BUTTON_STEP)}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
        </Tip>
        <Tip label={t("Zoom in")}>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("Zoom in")}
            onClick={() => zoomFromCentre(BUTTON_STEP)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </Tip>
        <Tip label={t("Fit to window")}>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("Fit to window")}
            onClick={() => setView(FITTED)}
          >
            <Maximize size={16} aria-hidden="true" />
          </button>
        </Tip>
        <Tip label={t("Close")}>
          <Dialog.Close className="pd-icon-button" aria-label={t("Close")}>
            <X size={16} aria-hidden="true" />
          </Dialog.Close>
        </Tip>
      </header>
      <div
        ref={stage}
        className="pd-zoom__stage"
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={event => {
          const from = dragging.current;
          if (!from) return;
          dragging.current = { x: event.clientX, y: event.clientY };
          setView(current => ({
            ...current,
            x: current.x + event.clientX - from.x,
            y: current.y + event.clientY - from.y
          }));
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
      >
        <div
          ref={canvas}
          className="pd-zoom__canvas"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

/** The same drawing the page shows, in the whole window, because a wide one shrinks until its words are hard to read. */
export function DiagramZoom({ svg, label, onClose }: { svg: string; label: string; onClose: () => void }) {
  // Focus would go back to the dialog's own trigger, and the diagram that opened this is not one.
  const [opener] = React.useState(() => document.activeElement as HTMLElement | null);
  return (
    <Dialog.Root
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          className="pd-zoom"
          initialFocus={() => document.querySelector<HTMLElement>(".pd-zoom__inner")}
          finalFocus={() => {
            opener?.focus({ preventScroll: true });
            return false;
          }}
        >
          <ZoomStage svg={svg} label={label} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
