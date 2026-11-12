import * as React from "react";
import type { IPureNode } from "markmap-common";
import { Markmap } from "markmap-view";
import { renderInlineMarkdown } from "../theme/text";
import type { MindmapNode } from "./mindmap-tree";

/** Markmap puts `content` into the page as HTML, and headings are written by anyone with access: only ever hand it escaped text. */
export function toMarkmapData(node: MindmapNode): IPureNode {
  return {
    content: renderInlineMarkdown(node.text).dangerouslySetInnerHTML.__html,
    children: node.children.map(toMarkmapData),
    payload: node.headingId ? { headingId: node.headingId } : {}
  };
}

export interface MindmapChartProps {
  readonly root: MindmapNode;
  /** Whether the wheel and dragging move the map. Inside a page the wheel has to keep scrolling the page. */
  readonly movable?: boolean;
  readonly onPickHeading?: (headingId: string) => void;
}

export default function MindmapChart({ root, movable = false, onPickHeading }: MindmapChartProps) {
  const svg = React.useRef<SVGSVGElement>(null);
  React.useEffect(() => {
    const element = svg.current!;
    // Markmap fits with this measure, which a scaled ancestor such as a slide inflates.
    element.getBoundingClientRect = () => new DOMRect(0, 0, element.clientWidth, element.clientHeight);
    const markmap = Markmap.create(
      element,
      {
        autoFit: true,
        duration: 200,
        zoom: movable,
        pan: movable,
        maxInitialScale: 1.5,
        maxWidth: 320,
        paddingX: 10,
        spacingHorizontal: 72,
        spacingVertical: 10,
        lineWidth: () => 1.5,
        color: node => (node.state.depth <= 2 ? "var(--rp-c-brand)" : "var(--rp-c-text-3)")
      },
      toMarkmapData(root)
    );
    // A map on a slide that is not showing yet has no size to fit into.
    const resized = new ResizeObserver(() => {
      if (element.clientWidth > 0) void markmap.fit();
    });
    resized.observe(element);
    return () => {
      resized.disconnect();
      markmap.destroy();
    };
  }, [movable, root]);
  const pick = (event: React.MouseEvent) => {
    const group = (event.target as Element).closest(".markmap-foreign")?.closest(".markmap-node") as
      | (Element & { __data__?: { payload?: { headingId?: string } } })
      | null
      | undefined;
    const headingId = group?.__data__?.payload?.headingId;
    if (headingId) onPickHeading?.(headingId);
  };
  return (
    <svg
      ref={svg}
      className={onPickHeading ? "pd-mindmap__chart pd-mindmap__chart--links" : "pd-mindmap__chart"}
      onClick={pick}
    />
  );
}
