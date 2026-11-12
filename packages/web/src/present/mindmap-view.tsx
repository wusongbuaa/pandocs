import * as React from "react";
import { useNavigate, usePage } from "@rspress/core/runtime";
import type { PandocsPage } from "../data/pages";
import MindmapChart from "./mindmap-chart";
import { treeFromOutline } from "./mindmap-tree";
import { PresentFrame, usePageRoute } from "./present-frame";
import { t } from "../i18n";

/** The page's outline as a map. Picking a heading leads to it on the page. */
export default function MindmapView({ page }: { page: PandocsPage }) {
  const navigate = useNavigate();
  const route = usePageRoute(page);
  const { page: { title } } = usePage();
  const root = React.useMemo(() => treeFromOutline(title, page.rendered.toc), [page.rendered.toc, title]);
  return (
    <PresentFrame page={page} label={t("Mind map")}>
      {root.children.length > 0
        ? <MindmapChart root={root} movable onPickHeading={id => navigate(`${route}#${encodeURIComponent(id)}`)} />
        : <p className="pd-present__empty">{t("This page has no section headings to make a mind map from")}</p>}
    </PresentFrame>
  );
}
