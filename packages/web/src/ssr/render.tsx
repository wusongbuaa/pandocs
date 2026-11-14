import { PassThrough } from "node:stream";
import { text } from "node:stream/consumers";
import { createHead, renderSSRHead, UnheadProvider } from "@unhead/react/server";
import type { ReactNode } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router-dom";
import { ThemeContext } from "@rspress/core/runtime";
import { createPageRoutes } from "../../vendor/rspress/runtime/PageRoute";
import { PAGE_ROUTE_ID } from "../../vendor/rspress/runtime/pageDataLoader";
import { matchPath } from "../../vendor/rspress/runtime/route";
import { prepareAnswers } from "../api/client";
import { applyBootstrap, loadBootstrap } from "../data/bootstrap";
import { SITE_BASE } from "../data/site-base";
import { invalidatePages, notFoundPage, setDocumentBody } from "../data/pages";
import { app, routes, siteData } from "../data/runtime-data";
import { DocumentBody } from "../markdown/document-body";
import { pageRoute } from "./page-route";
import type { RenderedPage, RenderInput } from "./protocol";

const ORIGIN = "http://pandocs.local";
/** Nothing normalizes to this, so the theme finds no route, the same as for any other address that has none. */
const NO_PATH = "/\0";

setDocumentBody(DocumentBody);

/** The first two segments, the way the theme looks for a language in an address it has no page for. */
function languageOfAddress(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean).slice(0, 2);
  return siteData.locales.find(({ lang }) => segments.includes(lang))?.lang ?? siteData.lang;
}

function pointRouteAt(pathname: string): void {
  const found = routes.find(route => matchPath(route.path, pathname));
  // The theme remembers an address it has found a route for, and that page may have gone since. It then loads this as the page.
  const missing = async () => notFoundPage({ routePath: "/404", lang: languageOfAddress(pathname), version: "" });
  Object.assign(
    pageRoute,
    found ?? { path: NO_PATH, filePath: "", lang: "", version: "", element: null, preload: missing }
  );
}

function renderToHtml(app: ReactNode): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const { pipe } = renderToPipeableStream(app, {
      // Larger sections would otherwise be finished by an inline script, which the page's policy refuses.
      progressiveChunkSize: Number.POSITIVE_INFINITY,
      onError: reject,
      onAllReady() {
        pipe(output);
        text(output).then(resolve, reject);
      }
    });
  });
}

export async function renderPage({ url, origin, answers }: RenderInput): Promise<RenderedPage> {
  prepareAnswers(answers);
  app.origin = origin;
  applyBootstrap(await loadBootstrap());
  invalidatePages();
  // Not `new URL(url, ORIGIN)`: an address can start with two slashes, which would read as another host.
  const address = new URL(`${ORIGIN}${url}`);
  pointRouteAt(address.pathname);
  // Below the site's path, the same as the router in the browser, so links come out the same in both.
  const { query, dataRoutes } = createStaticHandler(
    createPageRoutes(),
    SITE_BASE ? { basename: SITE_BASE } : undefined
  );
  const context = await query(new Request(`${ORIGIN}${SITE_BASE}${url}`));
  if (context instanceof Response) throw new Error(`Rendering ${url} answered ${context.status}`);
  if (context.errors) throw Object.values(context.errors)[0];
  const head = createHead({ disableDefaults: true });
  const html = await renderToHtml(
    <ThemeContext.Provider value={{ theme: "light" }}>
      <UnheadProvider value={head}>
        <StaticRouterProvider router={createStaticRouter(dataRoutes, context)} context={context} hydrate={false} />
      </UnheadProvider>
    </ThemeContext.Provider>
  );
  const { headTags, htmlAttrs } = await renderSSRHead(head);
  const { pageType } = context.loaderData[PAGE_ROUTE_ID] as { pageType: string };
  return { html, headTags, htmlAttrs, status: pageType === "404" ? 404 : 200 };
}
