import { API_BASE, insideSite, SITE_BASE } from "../data/site-base";

/**
 * The same app, inside another system's page. It gets its identity from that page rather than a cookie: browsers block
 * cookies in frames from another site, and this way the token is only ever in memory.
 */
const EMBED_PATH = /^\/embed\/([a-z0-9][a-z0-9-]*)(?:\/|$)/u;
const slug = typeof location === "undefined" ? null : EMBED_PATH.exec(insideSite(location.pathname))?.[1] ?? null;
/** The same app again, for someone with a share link: they have no login, and the link is who they are. */
const SHARE_PATH = /^\/s\/(pds_[\w-]+)(?:\/|$)/u;
const shareToken = typeof location === "undefined" ? null : SHARE_PATH.exec(insideSite(location.pathname))?.[1] ?? null;

export const shared = shareToken !== null;
export const embedded = slug !== null || shared;
/** Where the app is served from when embedded, below the site's own path: the theme's router works below both. */
export const embedBase = slug ? `/embed/${slug}/` : shareToken ? `/s/${shareToken}/` : null;

/** Options come in the first address and have to survive a reload, after which the address no longer has them. */
export function embedOption(name: string): string | null {
  if (!embedded) return null;
  const given = new URLSearchParams(location.search).get(name);
  if (given !== null) {
    sessionStorage.setItem(`pandocs:embed:${name}`, given);
    return given;
  }
  return sessionStorage.getItem(`pandocs:embed:${name}`);
}

const hostOrigin = embedOption("host") ?? "*";
export const embedShowsSidebar = embedOption("sidebar") === "1";

const FIRST_TOKEN_TIMEOUT_MS = 30_000;
/** Renew a little before the end, so that nothing on the page ever sees an expired token. */
const RENEW_BEFORE_MS = 60_000;

let token = "";
let ticket = "";
let waiting: ((value: string) => void)[] = [];
let renewal: ReturnType<typeof setTimeout> | null = null;

const toHost = (message: Record<string, unknown>) => window.parent.postMessage(message, hostOrigin);

function expiryOf(value: string): number {
  try {
    const payload = value.slice(value.indexOf("_") + 1).split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/");
    return (JSON.parse(atob(payload)) as { exp: number }).exp * 1000;
  } catch {
    return 0;
  }
}

function requestToken(): Promise<string> {
  return new Promise(resolve => {
    waiting.push(resolve);
    if (waiting.length === 1) toHost({ type: "pandocs:need-token" });
  });
}

async function loadTicket(): Promise<void> {
  const response = await originalFetch(`${API_BASE}/embed/ticket`, { headers: { authorization: `Bearer ${token}` } });
  if (response.ok) ticket = ((await response.json()) as { data: { ticket: string } }).data.ticket;
}

function accept(value: string): void {
  token = value;
  if (renewal) clearTimeout(renewal);
  const delay = expiryOf(value) - Date.now() - RENEW_BEFORE_MS;
  if (delay > 0) renewal = setTimeout(() => void renew(), Math.min(delay, 2 ** 31 - 1));
  const resolvers = waiting;
  waiting = [];
  for (const resolve of resolvers) resolve(value);
}

async function renew(): Promise<void> {
  await requestToken();
  await loadTicket().catch(() => undefined);
}

const originalFetch: typeof fetch = typeof window === "undefined" ? fetch : window.fetch.bind(window);

/** Everything the app asks this server for carries the token, including what the theme's own code fetches. */
function installFetch(): void {
  const needsToken = (url: URL) => url.origin === location.origin && (url.pathname.startsWith(`${SITE_BASE}/api/`) || url.pathname.endsWith(".md"));
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!needsToken(url)) return originalFetch(input, init);
    const request = new Request(input, init);
    const send = () => {
      const attempt = request.clone();
      attempt.headers.set("authorization", `Bearer ${token}`);
      return originalFetch(attempt);
    };
    const response = await send();
    if (response.status !== 401 || shared) return response;
    // It ran out without the renewal getting there, such as after a laptop slept. Ask once.
    await renew();
    return send();
  };
}

function applyTheme(theme: string | null): void {
  if (theme !== "dark" && theme !== "light") return;
  localStorage.setItem("rspress-theme-appearance", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("rp-dark", theme === "dark");
}

function pathBelowBase(): string {
  return `${insideSite(location.pathname).slice(embedBase!.length - 1)}${location.search}${location.hash}`;
}

/** Waits for the host page to say who this is, and connects the two pages. */
export async function startEmbedSession(): Promise<void> {
  document.documentElement.classList.add("pd-embedded");
  if (shareToken) {
    token = shareToken;
    ticket = shareToken;
    installFetch();
    return;
  }
  if (window.parent === window) throw new Error("This address only opens inside the page that embeds it");
  window.addEventListener("message", event => {
    if (event.source !== window.parent || (hostOrigin !== "*" && event.origin !== hostOrigin)) return;
    const message = event.data as { type?: string; token?: string; path?: string; theme?: string } | null;
    if (message?.type === "pandocs:token" && typeof message.token === "string") accept(message.token);
    else if (message?.type === "pandocs:theme" && typeof message.theme === "string") applyTheme(message.theme);
    else if (message?.type === "pandocs:navigate" && typeof message.path === "string" && message.path.startsWith("/") && !message.path.startsWith("//")) {
      history.pushState(null, "", `${embedBase!.slice(0, -1)}${message.path}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }
  });
  applyTheme(embedOption("theme"));
  // Going somewhere inside the frame is news to the page around it, which may want to reflect it in its own address.
  const announce = () => toHost({ type: "pandocs:navigate", path: pathBelowBase() });
  const { pushState } = history;
  history.pushState = function pushed(...args) {
    pushState.apply(history, args);
    announce();
  };
  window.addEventListener("popstate", announce);

  const first = requestToken();
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("The page around this one did not provide a token")), FIRST_TOKEN_TIMEOUT_MS);
  });
  await Promise.race([first, timeout]);
  await loadTicket();
  installFetch();
  toHost({ type: "pandocs:ready" });
}

/** For what cannot carry a header: images, videos and event streams. */
export function withTicket(url: string): string {
  if (!embedded || !ticket) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
}
