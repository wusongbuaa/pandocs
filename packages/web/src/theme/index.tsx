// The same mechanism as a Rspress project's theme/index.tsx: re-export the original theme, override what differs.
import * as React from "react";
import clsx from "clsx";
import type { Header } from "@rspress/core";
import {
  PageContext,
  useFrontmatter,
  useHead,
  useI18n,
  useLocation,
  usePage,
  useSearchParams
} from "@rspress/core/runtime";
import {
  getCustomMDXComponent as getBaseMDXComponent,
  IconEdit,
  Layout as BaseLayout,
  Link,
  LlmsContainer,
  LlmsCopyButton,
  LlmsHint as BaseLlmsHint,
  NotFoundLayout as BaseNotFoundLayout,
  parseInlineMarkdownText,
  SvgWrapper,
  Tag,
  useDynamicToc as useCollectedToc
} from "@rspress/core/theme-original";
import { DocActions } from "../annotations/doc-actions";
import { DocComments } from "../annotations/doc-comments";
import { PageLabels } from "../annotations/page-labels";
import { AnnotationLayer } from "../annotations/layer";
import { ErrorBoundary } from "../ui/error-boundary";
import { AskButton, AskHost } from "../ask/ask-host";
import { PageFeedback } from "../feedback/page-feedback";
import { DocNotices } from "../review/doc-notices";
import { shared } from "../embed/session";
import { useEditorShown } from "../data/editor-shown";
import { asEditable, editorModeOf, type AppPage } from "../data/pages";
import { api } from "../api/client";
import { APP_BASE, documentRoute, localePrefix, pageUrl } from "../data/paths";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import { atLeast } from "../types";
import { useSearchIgnoresInputMethod } from "../ui/input-method";
import { AppSwitch, NavAccount } from "./nav-slots";
import { SidebarActions } from "./sidebar-actions";
import { ManageSpaceNav } from "./manage-space-nav";
import { PageMenu } from "./page-menu";
import { usePrintsWhatIsFolded, useRevealLinkTarget } from "../markdown/reveal";
import { RecentPages } from "./home-recent";
import { SignInHost } from "./sign-in";
import "../styles/app.css";
import "../styles/annotations.css";
import "../styles/manage.css";
import "../styles/density.css";
import { language, resolveLanguage, t } from "../i18n";

export * from "@rspress/core/theme-original";
export { renderHtmlOrText, renderInlineMarkdown } from "./text";

/**
 * Once mounted, the theme collects the outline from the page, which is how it knows what is visible right now. It keeps
 * each heading as HTML, and the function above only takes text, so the words come from the document's own outline.
 */
export function useDynamicToc(): Header[] {
  const {
    page: { toc = [] }
  } = usePage();
  const collected = useCollectedToc();
  return React.useMemo(() => {
    const texts = new Map(toc.map(header => [header.id, header.text]));
    return collected.map(header => ({ ...header, text: texts.get(header.id) ?? parseInlineMarkdownText(header.text) }));
  }, [collected, toc]);
}

/** The theme's "edit this page" entries, leading to the editor instead of a repository. */
export function EditLink({ isOutline }: { isOutline?: boolean }) {
  const themeText = useI18n();
  const { page } = usePage();
  const data = (page as unknown as { pandocs?: AppPage }).pandocs;
  if (data?.kind !== "document" || (import.meta.env.MODE !== "parity" && !atLeast(data.view.role, "commenter")))
    return null;
  const href = `${documentRoute(data.space.slug, data.entry.path, localePrefix(page.lang, app.bootstrap.site.defaultLang))}?mode=edit`;
  // Someone who can only comment goes on to suggest, which is what the button at the top of the page calls it too.
  const text =
    import.meta.env.MODE === "parity" || atLeast(data.view.role, "editor")
      ? themeText("editLinkText")
      : t("Suggest changes");
  if (isOutline) {
    return (
      <Link href={href} className="rp-outline__action-row rp-edit-link">
        <SvgWrapper icon={IconEdit} width="16" height="16" />
        <span>{text}</span>
      </Link>
    );
  }
  return (
    <Link href={href} className="rp-edit-link">
      {text}
    </Link>
  );
}

/** The theme's title with its copy row, plus the page's own actions on that row. */
function H1({ className, children, ...rest }: React.ComponentProps<"h1">) {
  const {
    frontmatter: { tag }
  } = useFrontmatter();
  const page = useAppPage();
  const [params] = useSearchParams();
  const editorShown = useEditorShown();
  // Where the title can be changed, the editor shows it as a field in this place, once the editor is there.
  if (editorShown && params.get("mode") === "edit" && page?.kind === "document" && editorModeOf(page) !== "propose")
    return null;
  return (
    <>
      <h1 className={clsx("rp-toc-include", className)} {...rest}>
        {children} <Tag tag={tag} />
      </h1>
      <LlmsContainer>
        <LlmsCopyButton />
        {/* What it offers includes opening the address elsewhere, and on a share link the address is the secret. */}
        {shared ? null : <PageMenu />}
        <DocActions />
      </LlmsContainer>
      <PageLabels />
    </>
  );
}

// The comparison with an official build looks at the theme alone.
export function getCustomMDXComponent() {
  const base = getBaseMDXComponent();
  return import.meta.env.MODE === "parity" ? base : { ...base, h1: H1 };
}

/**
 * Pages that moved keep their old addresses working. The routes only know where pages are now, so a miss asks the server,
 * unless the page came from the server and it has already looked.
 */
function useMovedPage(space: string, path: string, answered: boolean): "checking" | "gone" {
  const [state, setState] = React.useState<"checking" | "gone">(() =>
    space && path && !answered ? "checking" : "gone"
  );
  React.useEffect(() => {
    if (!space || !path || answered) return;
    api
      .get<{ path: string; redirected: boolean }>(
        `spaces/${encodeURIComponent(space)}/resolve?path=${encodeURIComponent(path)}`
      )
      .then(
        // Found where it was asked for, it is a page the routes do not have yet. Loading again would only ask again.
        moved =>
          moved.redirected
            ? location.replace(`${pageUrl(documentRoute(space, moved.path))}${location.search}${location.hash}`)
            : setState("gone"),
        () => setState("gone")
      );
  }, [space, path, answered]);
  return state;
}

function NotFoundLayout() {
  const { pathname } = useLocation();
  const [space = "", ...rest] = decodeURIComponent(pathname.slice(1)).split("/");
  const known = app.bootstrap.spaces.some(item => item.slug === space);
  const moved = useMovedPage(
    known ? space : "",
    rest.join("/").replace(/\/$/u, ""),
    import.meta.env.SSR || pageUrl(pathname) === app.renderedPath
  );
  if (moved === "checking") return null;
  return (
    <>
      <BaseNotFoundLayout />
      {/* Someone with no login gets this for what is closed to them as well, and nothing says which it is. */}
      {app.bootstrap.me.anonymous ? (
        <p className="pd-not-found-note">{t("If this page is behind a login, sign in to see it.")}</p>
      ) : null}
    </>
  );
}

/** The text on a page is settled when it loads, and moving to another language's pages can change what it should be. */
function useLanguageOfAddress(): void {
  const { page } = usePage();
  const arrivedIn = React.useRef(page.lang);
  React.useEffect(() => {
    // Staying put settles nothing: this browser may simply ask for something else than the request for this page did.
    if (page.lang !== arrivedIn.current && resolveLanguage() !== language) location.reload();
  }, [page.lang]);
}

/** Most of what is here is for people and tools that read the site, which someone's own pages are not. */
export function LlmsHint() {
  const data = useAppPage();
  return data?.kind === "document" || data?.kind === "home" ? <BaseLlmsHint /> : null;
}

const absolute = (route: string) => `${app.origin}${pageUrl(route)}`;

/** Which languages a page can be read in, as addresses. A translation nobody has written yet is the source under another address, so it does not count. */
function languageVersions(
  data: AppPage | undefined,
  pathname: string,
  lang: string
): readonly { readonly lang: string; readonly href: string }[] {
  const { locales, defaultLang } = app.bootstrap.site;
  if (locales.length < 2) return [];
  const here = localePrefix(lang, defaultLang);
  const path = here && pathname.startsWith(here) ? pathname.slice(here.length) : pathname;
  return locales
    .filter(
      locale =>
        data?.kind !== "document" || locale.lang === defaultLang || data.entry.titles?.[locale.lang] !== undefined
    )
    .map(locale => ({ lang: locale.lang, href: absolute(`${localePrefix(locale.lang, defaultLang)}${path}`) }));
}

/** What search engines and link previews read beyond the theme's title and description. Addresses are without a query, so views of a page are not pages. */
function PageHead() {
  const { page } = usePage();
  const { pathname } = useLocation();
  const data = useAppPage();
  const { site } = app.bootstrap;
  const untranslated = data?.kind === "document" && data.translation !== null && !data.translation.exists;
  const canonical = absolute(untranslated ? documentRoute(data.space.slug, data.entry.path) : pathname);
  const versions = languageVersions(data, pathname, page.lang);
  const image = /^https?:/u.test(site.logo)
    ? site.logo
    : site.logo.startsWith("/")
      ? `${app.origin}${site.logo}`
      : null;
  useHead(
    !shared && (data?.kind === "document" || data?.kind === "home")
      ? {
          link: [
            { rel: "canonical", href: canonical },
            ...versions.map(version => ({ rel: "alternate", hreflang: version.lang, href: version.href })),
            ...versions
              .filter(version => version.lang === site.defaultLang)
              .map(version => ({ rel: "alternate", hreflang: "x-default", href: version.href }))
          ],
          meta: [
            { property: "og:url", content: canonical },
            { property: "og:site_name", content: site.title },
            { name: "twitter:card", content: "summary" },
            ...(image ? [{ property: "og:image", content: image }] : [])
          ]
        }
      : { meta: [{ name: "robots", content: "noindex" }] }
  );
  return null;
}

/** Someone with the page open in a browser, not a view of it or the editor. Crawlers and tools have other ways of being counted. */
function useCountedRead(): void {
  const data = useAppPage();
  const [params] = useSearchParams();
  const reading = data?.kind === "document" && !params.get("mode") && !shared ? data.entry.id : null;
  React.useEffect(() => {
    if (reading) api.beacon("stats/views", { document: reading });
  }, [reading]);
}

export function Layout() {
  useLanguageOfAddress();
  useCountedRead();
  useSearchIgnoresInputMethod();
  useRevealLinkTarget();
  usePrintsWhatIsFolded();
  // A page from the server looks ready before it responds. This is for whoever has to know the difference, such as tests.
  React.useEffect(() => {
    document.documentElement.dataset.live = "";
  }, []);
  const context = React.useContext(PageContext);
  const [params] = useSearchParams();
  const mode = params.get("mode");
  const editable = React.useMemo(
    () => (context.data ? asEditable(context.data, mode) : context.data),
    [context.data, mode]
  );
  const shown = React.useMemo(() => ({ ...context, data: editable }), [context, editable]);
  if (import.meta.env.MODE === "parity") return <BaseLayout />;
  const layout = (
    <BaseLayout
      NotFoundLayout={NotFoundLayout}
      top={<PageHead />}
      beforeNavTitle={<AppSwitch />}
      beforeNavMenu={<AskButton />}
      afterNavMenu={<NavAccount />}
      beforeSidebar={<ManageSpaceNav />}
      afterSidebar={<SidebarActions />}
      beforeDocContent={<DocNotices />}
      afterDocContent={<DocComments />}
      beforeDocFooter={<PageFeedback />}
      afterFeatures={<RecentPages />}
      bottom={
        <>
          <ErrorBoundary area="Comments" fallback={null}>
            <AnnotationLayer />
          </ErrorBoundary>
          <ErrorBoundary area="Ask" fallback={null}>
            <AskHost />
          </ErrorBoundary>
          <SignInHost />
        </>
      }
    />
  );
  return editable === context.data ? layout : <PageContext.Provider value={shown}>{layout}</PageContext.Provider>;
}
