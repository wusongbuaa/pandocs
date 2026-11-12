import * as React from "react";
import { useMDXComponents } from "@mdx-js/react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { NoSSR, useLocation, usePage, useSearchParams } from "@rspress/core/runtime";
import { Link } from "@rspress/core/theme";
import { useEditorShown } from "../data/editor-shown";
import type { AppPage, PandocsPage } from "../data/pages";
import { localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";
import { commentOnBlock } from "../annotations/layer";
import { atLeast } from "../types";
import { dialectComponents } from "./blocks";
import type { RenderedMarkdown } from "./pipeline";
import { ReaderContextProvider } from "./reader-context";
import { ErrorBoundary } from "../ui/error-boundary";
import { t } from "../i18n";

export function useAppPage(): AppPage | undefined {
  const { page } = usePage();
  return (page as unknown as { pandocs?: AppPage }).pandocs;
}

export function useReaderContextOf(page: PandocsPage, onCommentBlock?: (ref: string) => void) {
  const lang = usePage().page.lang;
  return React.useMemo(() => ({
    space: page.space,
    currentPath: page.entry.path,
    routePrefix: localePrefix(lang, app.bootstrap.site.defaultLang),
    children: app.bootstrap.spaces.find(space => space.slug === page.space.slug)?.tree.filter(entry => entry.parentId === page.entry.id) ?? [],
    ...(onCommentBlock ? { onCommentBlock } : {})
  }), [lang, onCommentBlock, page]);
}

export function useDocumentContent(hast: RenderedMarkdown["hast"], overrides?: Readonly<Record<string, unknown>>) {
  const provided = useMDXComponents();
  return React.useMemo(
    () => toJsxRuntime(hast, { Fragment, jsx, jsxs, components: { ...provided, ...dialectComponents, ...overrides } as never, ignoreInvalidStyle: true, passKeys: true }),
    [hast, overrides, provided]
  );
}

export function RenderedBody({ page }: { page: PandocsPage }) {
  const onCommentBlock = React.useMemo(() => (import.meta.env.MODE !== "parity" && atLeast(page.view.role, "commenter") ? (ref: string) => commentOnBlock(page, ref) : undefined), [page]);
  const context = useReaderContextOf(page, onCommentBlock);
  const content = useDocumentContent(page.rendered.hast);
  // `contents` keeps the theme's layout unchanged; the element only marks where a document's own text starts.
  return <ReaderContextProvider value={context}><div data-pandocs-body="" style={{ display: "contents" }}>{content}</div></ReaderContextProvider>;
}

/** A page someone made and has not written yet. */
function BlankPage({ page }: { page: PandocsPage }) {
  const { pathname } = useLocation();
  if (!atLeast(page.view.role, "editor")) return <p className="pd-muted">{t("Nothing has been written here yet.")}</p>;
  return (
    <div className="pd-blank-page rp-not-doc">
      <p>{t("This page is empty.")}</p>
      <Link href={`${pathname}?mode=edit`} className="pd-btn pd-btn--primary">{t("Start writing")}</Link>
    </div>
  );
}

const EditorPage = React.lazy(() => import("../editor/editor-page"));
const HistoryView = React.lazy(() => import("../review/history-view"));
const SourceView = React.lazy(() => import("../review/source-view"));
const ManagePage = React.lazy(() => import("../manage/manage-page"));
const SlidesView = React.lazy(() => import("../present/slides-view"));
const MindmapView = React.lazy(() => import("../present/mindmap-view"));

/** Tools rather than reading: they load what they work on once they run, so the server leaves a place for them. */
function ClientView({ children, fallback = <p className="pd-muted">{t("Opening…")}</p>, area = "A view" }: { readonly children: React.ReactNode; readonly fallback?: React.ReactNode; readonly area?: string }) {
  return (
    <NoSSR fallback={fallback}>
      <ErrorBoundary area={area} fallback={<p className="pd-muted">{t("This could not be shown. Reload the page to try again.")}</p>}>
        <React.Suspense fallback={fallback}>{children}</React.Suspense>
      </ErrorBoundary>
    </NoSSR>
  );
}

/** A page whose text could not be drawn is still there to read, as it was written. */
function SourceInstead({ page }: { page: PandocsPage }) {
  return (
    <div className="rp-not-doc">
      <p className="pd-muted">{t("Part of this page could not be shown, so here is its text as written.")}</p>
      <pre className="pd-source">{page.view.markdown ?? ""}</pre>
    </div>
  );
}

function DocumentView({ page }: { page: PandocsPage }) {
  const [params] = useSearchParams();
  const editorShown = useEditorShown();
  const editing = params.get("mode") === "edit" && (atLeast(page.view.role, "commenter") || Boolean(page.translation?.canEdit));
  if (!editing && params.get("view") === "history") return <ClientView><HistoryView key={page.entry.id} page={page} /></ClientView>;
  if (!editing && params.get("view") === "source") return <ClientView><SourceView page={page} /></ClientView>;
  if (!editing && params.get("view") === "slides") return <ClientView><SlidesView key={page.entry.id} page={page} /></ClientView>;
  if (!editing && params.get("view") === "mindmap") return <ClientView><MindmapView key={page.entry.id} page={page} /></ClientView>;
  const reading = !page.translation?.exists && !page.view.markdown?.trim()
    ? <BlankPage page={page} />
    : <ErrorBoundary key={`${page.entry.id}:${page.view.revision.no}`} area="The page's text" fallback={<SourceInstead page={page} />}><RenderedBody page={page} /></ErrorBoundary>;
  // The same two places either way, so what is being read stays mounted while the editor opens beside it.
  return (
    <>
      {editing && editorShown ? null : reading}
      {editing ? <ClientView fallback={null} area="The editor"><EditorPage key={`${page.entry.id}:${page.translation?.lang ?? ""}`} page={page} /></ClientView> : null}
    </>
  );
}

export function DocumentBody() {
  const page = useAppPage();
  if (!page) return null;
  switch (page.kind) {
    case "document":
      return <DocumentView page={page} />;
    case "manage":
      return <ClientView><ManagePage spec={page.spec} /></ClientView>;
    default:
      return null;
  }
}
