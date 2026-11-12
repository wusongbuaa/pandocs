import { startTransition } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { ClientApp, createClientRouter } from "../vendor/rspress/runtime/ClientApp";
import { initPageData } from "../vendor/rspress/runtime/initPageData";
import { redirectToCleanUrl } from "../vendor/rspress/runtime/route";
import { removeBase } from "../vendor/rspress/runtime/utils";
import { setDocumentBody } from "./data/pages";
import { DocumentBody } from "./markdown/document-body";
import { ErrorBoundary } from "./ui/error-boundary";
import { t } from "./i18n";

/** The last resort, for what no smaller part caught: a way back rather than an empty page. */
function PageFailed() {
  return (
    <main className="pd-page-failed">
      <p>{t("Something went wrong showing this page.")}</p>
      <a href={window.location.href} className="pd-btn pd-btn--primary">{t("Reload")}</a>
    </main>
  );
}

export async function mount(container: HTMLElement, rendered: boolean): Promise<void> {
  setDocumentBody(DocumentBody);
  redirectToCleanUrl(window.location, window.history);
  if (!rendered) {
    createRoot(container).render(<ErrorBoundary area="The page" fallback={<PageFailed />}><ClientApp router={createClientRouter()} /></ErrorBoundary>);
    return;
  }
  // The same order as the theme's own entry for pages rendered ahead of time: the page's data first, or there is nothing to match the HTML with.
  const router = createClientRouter(await initPageData(removeBase(window.location.pathname)));
  startTransition(() => {
    hydrateRoot(container, <ErrorBoundary area="The page" fallback={<PageFailed />}><ClientApp router={router} /></ErrorBoundary>, {
      onRecoverableError: error => console.error("The page did not match what the server rendered", error)
    });
  });
}
