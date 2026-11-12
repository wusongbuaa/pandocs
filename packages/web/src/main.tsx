import "./no-eval";
import "../vendor/rspress/theme/styles";
import { ApiError, prepareAnswers } from "./api/client";
import { applyBootstrap, initialRedirect, loadBootstrap } from "./data/bootstrap";
import { app } from "./data/runtime-data";
import { embedded, startEmbedSession } from "./embed/session";
import { loadMessages, t } from "./i18n";
import { STATE_ELEMENT_ID, type RenderedState } from "./ssr/protocol";

const CHUNK_RELOAD_KEY = "pandocs:chunk-reload";
/**
 * At most one reload a minute: a chunk can still fail after one, and WebKit does not even ask again for a chunk that
 * has failed, so reloading for it would never stop.
 */
const CHUNK_RELOAD_GAP_MS = 60_000;
let leaving = false;

// Leaving a page stops what it is still loading, which Firefox reports as if those chunks were gone. Reloading then
// would cancel going wherever someone was going.
window.addEventListener("beforeunload", () => {
  leaving = true;
});
window.addEventListener("pageshow", () => {
  leaving = false;
});

/** A release removes the chunks an open tab still asks for. One reload picks up the new ones. */
window.addEventListener("vite:preloadError", event => {
  if (leaving || Date.now() - Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) < CHUNK_RELOAD_GAP_MS) return;
  sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  event.preventDefault();
  location.reload();
});

function showFailure(container: HTMLElement, error: unknown): void {
  const denied = error instanceof ApiError && error.status === 403;
  const notice = document.createElement("div");
  notice.className = "pd-notice";
  const title = document.createElement("h1");
  title.textContent = denied ? t("You do not have access to these documents") : t("The documents cannot be opened right now");
  const detail = document.createElement("p");
  detail.textContent = denied ? t("Ask an administrator for access.") : t("Refresh the page in a moment.");
  notice.append(title, detail);
  container.replaceChildren(notice);
}

function renderedState(): RenderedState | null {
  const content = document.getElementById(STATE_ELEMENT_ID)?.textContent;
  return content ? JSON.parse(content) as RenderedState : null;
}

async function start(): Promise<void> {
  const container = document.getElementById("__rspress_root")!;
  await loadMessages();
  const rendered = renderedState();
  try {
    app.origin = rendered?.origin ?? location.origin;
    if (rendered) {
      prepareAnswers(rendered.answers);
      app.renderedPath = location.pathname;
    }
    if (embedded) await startEmbedSession();
    const bootstrap = await loadBootstrap();
    const redirect = initialRedirect(bootstrap, location.pathname);
    if (redirect) history.replaceState(null, "", `${redirect}${location.search}${location.hash}`);
    applyBootstrap(bootstrap);
    // The theme captures its data when it loads, so it only loads now that the data exists.
    const { mount } = await import("./mount");
    await mount(container, rendered !== null);
  } catch (error) {
    // What the server rendered can still be read, even if nothing on it will respond.
    if (rendered) throw error;
    await import("./styles/app.css");
    showFailure(container, error);
  }
}

void start();
