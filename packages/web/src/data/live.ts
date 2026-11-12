import { API_BASE } from "../api/client";
import { embedded, shared, withTicket } from "../embed/session";

const EMBED_RETRY_MS = 5000;

export interface LiveChange {
  readonly kind: "document" | "discussion" | "space";
  readonly revision: number | null;
  readonly deleted: boolean;
}

/**
 * Follows one page for as long as it is showing. Browsers allow a site only a few open connections, so a tab in the
 * background holds none, and picks up where it left off when it comes back. If the connection is refused, as it is once
 * a login expires, `onChange` simply stops: the page still catches up when someone comes back to it.
 */
export function followDocument(documentId: string, onChange: (change: LiveChange | null) => void): () => void {
  if (typeof EventSource === "undefined" || shared) return () => undefined;
  let source: EventSource | null = null;
  let position: string | null = null;

  const remember = (event: Event) => {
    const { lastEventId } = event as MessageEvent<string>;
    if (lastEventId) position = lastEventId;
  };
  const connect = () => {
    if (source || document.visibilityState !== "visible") return;
    const query = new URLSearchParams({ document: documentId, ...(position ? { since: position } : {}) });
    const opened = new EventSource(withTicket(`${API_BASE}/events?${query}`));
    source = opened;
    // A ticket running out closes the stream for good. Embedded, a newer one is on its way, so try again with that.
    if (embedded) {
      opened.addEventListener("error", () => {
        if (opened.readyState !== EventSource.CLOSED || source !== opened) return;
        source = null;
        setTimeout(connect, EMBED_RETRY_MS);
      });
    }
    source.addEventListener("ready", remember);
    source.addEventListener("change", event => {
      remember(event);
      onChange(JSON.parse((event as MessageEvent<string>).data) as LiveChange);
    });
    // Too much went by to list. All this page needs to do is look again.
    source.addEventListener("reset", () => onChange(null));
  };
  const disconnect = () => {
    source?.close();
    source = null;
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") connect();
    else disconnect();
  };
  document.addEventListener("visibilitychange", onVisibility);
  connect();
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    disconnect();
  };
}
