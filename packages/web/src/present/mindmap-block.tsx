import * as React from "react";
import type { BlockProps } from "../markdown/block-parts";
import MindmapChart from "./mindmap-chart";
import { treeFromMarkdown } from "./mindmap-tree";

export default function MindmapBlock({ attrs, source = "" }: BlockProps) {
  const root = React.useMemo(() => treeFromMarkdown(source, attrs.title ?? ""), [attrs.title, source]);
  return <MindmapChart root={root} />;
}
