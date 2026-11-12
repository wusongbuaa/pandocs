import { HocuspocusProvider } from "@hocuspocus/provider";
import { LIVE_META } from "@pandocs/editor-model";
import * as Y from "yjs";
import { api, API_BASE } from "../api/client";
import { embedded } from "../embed/session";

const CONNECT_WITHIN_MS = 8000;

/** Why someone is no longer in a draft: they signed out, they can no longer edit, or the draft was started again. */
export type LiveEnding = "signed-out" | "forbidden" | "stale";

export interface LiveSession {
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  /** What everyone in the draft should agree on besides the text. */
  readonly meta: Y.Map<string | number | null>;
  onEnded(handler: (ending: LiveEnding) => void): () => void;
  destroy(): void;
}

const ENDINGS: readonly string[] = ["signed-out", "forbidden", "stale"];

/** The shared draft of a page, or null if this has to be done alone: the server does not offer it, or the connection is not getting through. */
export async function openLiveSession(documentId: string): Promise<{ readonly session: LiveSession | null; readonly unreachable: boolean }> {
  // A page in another system's frame has a token that runs out and is renewed from outside, which this connection does not follow yet.
  if (embedded) return { session: null, unreachable: false };
  const opened = await api.send<{ available: false } | { available: true; name: string }>("POST", `documents/${documentId}/live`);
  if (!opened.available) return { session: null, unreachable: false };
  const doc = new Y.Doc();
  const handlers = new Set<(ending: LiveEnding) => void>();
  const ended = (reason: string) => {
    if (ENDINGS.includes(reason)) for (const handler of handlers) handler(reason as LiveEnding);
  };
  const provider = new HocuspocusProvider({
    url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${API_BASE}/live`,
    name: opened.name,
    document: doc,
    token: "",
    onAuthenticationFailed: ({ reason }) => ended(reason),
    onClose: ({ event }) => ended(event.reason)
  });
  const destroy = () => {
    provider.destroy();
    doc.destroy();
  };
  const synced = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), CONNECT_WITHIN_MS);
    const settle = (value: boolean) => {
      clearTimeout(timer);
      resolve(value);
    };
    provider.on("synced", () => settle(true));
    provider.on("authenticationFailed", () => settle(false));
  });
  if (!synced) {
    destroy();
    return { session: null, unreachable: true };
  }
  return {
    session: {
      doc,
      provider,
      meta: doc.getMap(LIVE_META),
      onEnded(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      destroy
    },
    unreachable: false
  };
}
