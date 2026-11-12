import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { LIVE_PULL, liveChannel, type PandocsServices, type Principal } from "@pandocs/core";
import { Hocuspocus, type Document, type onAuthenticatePayload } from "@hocuspocus/server";
import { WebSocketServer, type WebSocket } from "ws";
import { applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createLiveRelay } from "./relay.js";

export const LIVE_PATH = "/api/v1/live";
/** What a connection can send at once. Generous, as someone coming back after a long time offline sends all they did. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const STORE_AFTER_MS = 1500;
const STORE_AT_MOST_EVERY_MS = 8000;
const PING_MS = 30_000;
/** Anyone can open a connection, so a connection nobody has been let into for a while is closed. An editor asks right away. */
const ADMITTED_WITHIN_MS = 10_000;
const LOOK_AROUND_MS = 15_000;
/** Typing arrives in small pieces, and others do not need each one on its own. */
const RELAY_AFTER_MS = 40;
/** What PostgreSQL carries in a notification, less what these messages add. */
const MOST_RELAY_CHARS = 7800;
/** A page too much for a conversion will still be too much a moment later, and trying takes a lot of work. */
const RETRY_CATCHING_UP_AFTER_MS = 5 * 60 * 1000;

/** Applied without being stored or passed on again. */
const FROM_ELSEWHERE = { source: "local", skipStoreHooks: true } as const;
/** Changes from another replica are stored here too, in case that one goes away before it gets to. */
const FROM_OTHER_REPLICA = { source: "local", fromOtherReplica: true } as const;

interface Credentials {
  readonly cookie: string | null;
  readonly token: string;
}

interface LiveContext {
  principal: Principal;
  readonly credentials: Credentials;
  checkedAt: number;
  /** Says this connection has been let in somewhere, so it can stay. */
  readonly letIn?: () => void;
}

/** A draft someone is connected to here. */
interface OpenDraft {
  readonly documentId: string;
  readonly name: string;
  readonly document: Document;
  version: number;
  /** Someone connected here has changed it since it was last stored. */
  touched: boolean;
  contributors: Record<string, string>;
  updates: Uint8Array[];
  awareness: Set<number>;
  relayTimer: ReturnType<typeof setTimeout> | null;
  /** Too large to send, so others are told to read it once it is stored. */
  tellOthersAfterStoring: boolean;
}

/** The answer given to someone who may not come in, which the editor reads to know what to do. */
const refusal = (reason: "signed-out" | "forbidden" | "stale") => ({ reason, code: reason === "signed-out" ? 4401 : 4403 });

export interface LiveHubDeps {
  readonly services: PandocsServices;
  readonly authenticate: (request: Request) => Promise<{ readonly ok: true; readonly principal: Principal } | { readonly ok: false }>;
  readonly publicOrigin: string;
  /** The site's path below its host, such as `/docs`, which sockets arrive with. Empty at the root. */
  readonly basePath?: string;
  readonly listenUrl: string;
  readonly publish: (channel: string, payload: string) => Promise<unknown>;
  readonly recheckMs: number;
  readonly lookAroundMs?: number;
  readonly admittedWithinMs?: number;
}

/**
 * Keeps the people editing a page connected to each other, whichever replica they reached. Each replica holds a copy of
 * the drafts its people are in, adds what they type, and hands it on: to the others through the relay, right away, and to
 * the database within seconds, which is what counts.
 */
export function createLiveHub(deps: LiveHubDeps) {
  const { services } = deps;
  const replica = randomBytes(6).toString("base64url");
  const open = new Map<string, OpenDraft>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let draining = false;
  let catchingUp = false;
  let catchUpAgain = false;
  const leaveUntil = new Map<string, number>();
  let lookAround: ReturnType<typeof setInterval> | null = null;

  const idOf = (name: string) => name.split(".")[0] ?? "";

  const relay = createLiveRelay({
    connectionString: deps.listenUrl,
    publish: deps.publish,
    onReconnect: () => void lookAroundNow().catch(() => undefined)
  });

  const principalOf = async ({ cookie, token }: Credentials): Promise<Principal> => {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const auth = await deps.authenticate(new Request(new URL(LIVE_PATH, deps.publicOrigin), { headers }));
    if (!auth.ok) throw refusal("signed-out");
    return auth.principal;
  };

  const admitted = async (principal: Principal, name: string) => {
    try {
      return await services.live.admit(principal, name);
    } catch (error) {
      throw refusal((error as { code?: string }).code === "LIVE_DRAFT_STALE" ? "stale" : "forbidden");
    }
  };

  const publish = (draft: OpenDraft, kind: string, data = "") => relay.publish(liveChannel(draft.documentId), `${replica}|${kind}|${data}`).catch(() => undefined);

  const flushRelay = (draft: OpenDraft) => {
    draft.relayTimer = null;
    if (draft.updates.length > 0) {
      const encoded = Buffer.from(Y.mergeUpdates(draft.updates)).toString("base64");
      draft.updates = [];
      if (encoded.length <= MOST_RELAY_CHARS) {
        void publish(draft, "u", encoded);
      } else {
        draft.tellOthersAfterStoring = true;
        void storeNow(draft)?.catch(() => undefined);
      }
    }
    if (draft.awareness.size > 0) {
      publishAwareness(draft, [...draft.awareness]);
      draft.awareness = new Set();
    }
  };

  /** Who is here and where, in as many messages as the relay needs: it carries only so much at once. */
  const publishAwareness = (draft: OpenDraft, clients: readonly number[]) => {
    const encoded = Buffer.from(encodeAwarenessUpdate(draft.document.awareness, [...clients])).toString("base64");
    if (encoded.length <= MOST_RELAY_CHARS) {
      void publish(draft, "a", encoded);
    } else if (clients.length > 1) {
      const half = Math.ceil(clients.length / 2);
      publishAwareness(draft, clients.slice(0, half));
      publishAwareness(draft, clients.slice(half));
    } else {
      // One person's state alone too long to carry, which only a client sending nonsense makes.
      console.warn(JSON.stringify({ event: "live.awareness_too_long", document: draft.documentId, chars: encoded.length }));
    }
  };

  const scheduleRelay = (draft: OpenDraft) => {
    draft.relayTimer ??= setTimeout(() => flushRelay(draft), RELAY_AFTER_MS);
  };

  const pull = async (draft: OpenDraft) => {
    const stored = await services.live.read(draft.documentId);
    if (!stored || stored.version === draft.version) return;
    Y.applyUpdate(draft.document, stored.state, FROM_ELSEWHERE);
    draft.version = stored.version;
  };

  const onRelayed = (draft: OpenDraft, payload: string) => {
    if (payload === LIVE_PULL) {
      void pull(draft).catch(() => undefined);
      return;
    }
    const [from, kind, data = ""] = payload.split("|");
    if (from === replica) return;
    if (kind === "p") void pull(draft).catch(() => undefined);
    else if (kind === "u") Y.applyUpdate(draft.document, Buffer.from(data, "base64"), FROM_OTHER_REPLICA);
    else if (kind === "a") applyAwarenessUpdate(draft.document.awareness, Buffer.from(data, "base64"), FROM_OTHER_REPLICA);
    else if (kind === "h") {
      // A replica has just opened this draft, and wants to know what has been typed that is not written down yet, and who is here.
      draft.tellOthersAfterStoring = true;
      void storeNow(draft)?.catch(() => undefined);
      if (draft.document.awareness.getStates().size > 0) publishAwareness(draft, [...draft.document.awareness.getStates().keys()]);
    }
  };

  const store = async (draft: OpenDraft) => {
    const { touched, contributors } = draft;
    draft.touched = false;
    draft.contributors = {};
    try {
      const version = await services.live.write(draft.documentId, draft.name, stored => {
        Y.applyUpdate(draft.document, stored, FROM_ELSEWHERE);
        return Y.encodeStateAsUpdate(draft.document);
      }, { touched, contributors });
      if (version === null) sendAway(draft);
      else draft.version = version;
    } catch (error) {
      draft.touched ||= touched;
      draft.contributors = { ...contributors, ...draft.contributors };
      throw error;
    }
    if (draft.tellOthersAfterStoring) {
      draft.tellOthersAfterStoring = false;
      await publish(draft, "p");
    }
  };

  /** The draft was started again or removed while people were here. The editor knows what to do about that. */
  const sendAway = (draft: OpenDraft) => {
    for (const connection of draft.document.getConnections()) connection.close(refusal("stale"));
  };

  const storeNow = (draft: OpenDraft) => hocuspocus.storeDocumentHooks(draft.document, {
    instance: hocuspocus,
    clientsCount: draft.document.getConnectionsCount(),
    document: draft.document,
    lastContext: {},
    lastTransactionOrigin: FROM_ELSEWHERE,
    documentName: draft.name
  }, true);

  /** Takes in versions made while people have this open, from wherever they came. */
  const catchUp = async () => {
    if (open.size === 0) return;
    if (catchingUp) {
      catchUpAgain = true;
      return;
    }
    catchingUp = true;
    try {
      for (const documentId of await services.live.behind([...open.keys()])) {
        const draft = open.get(documentId);
        if (!draft || (leaveUntil.get(documentId) ?? 0) > Date.now()) continue;
        try {
          // So that what it merges with is what people have typed up to now.
          await storeNow(draft);
          const caught = await services.live.catchUp(documentId);
          if (caught) {
            Y.applyUpdate(draft.document, caught.change, FROM_ELSEWHERE);
            draft.version = caught.version;
          }
          leaveUntil.delete(documentId);
        } catch (error) {
          leaveUntil.set(documentId, Date.now() + RETRY_CATCHING_UP_AFTER_MS);
          console.error(JSON.stringify({ event: "live.catch_up_failed", documentId, message: error instanceof Error ? error.message : "" }));
        }
      }
    } finally {
      catchingUp = false;
      if (catchUpAgain) {
        catchUpAgain = false;
        void catchUp().catch(() => undefined);
      }
    }
  };

  /** For what the relay did not say, and to mark what is still in use. */
  const lookAroundNow = async () => {
    if (open.size === 0) return;
    const seen = await services.live.stillOpen([...open.keys()]);
    for (const draft of open.values()) {
      const stored = seen.get(draft.documentId);
      if (stored?.name !== draft.name) sendAway(draft);
      else if (stored.version !== draft.version) await pull(draft);
    }
    await catchUp();
  };

  const hocuspocus = new Hocuspocus<LiveContext>({
    name: `pandocs-${replica}`,
    debounce: STORE_AFTER_MS,
    maxDebounce: STORE_AT_MOST_EVERY_MS,
    async onAuthenticate({ token, documentName, requestHeaders, context }: onAuthenticatePayload) {
      const credentials: Credentials = { cookie: requestHeaders.get("cookie"), token };
      const principal = await principalOf(credentials);
      await admitted(principal, documentName);
      (context as LiveContext).letIn?.();
      return { principal, credentials, checkedAt: Date.now() };
    },
    // Connections outlive the login that opened them, so they answer to the same checks a new request would.
    async beforeHandleMessage({ context, documentName }) {
      if (Date.now() - context.checkedAt < deps.recheckMs) return;
      context.checkedAt = Date.now();
      context.principal = await principalOf(context.credentials);
      await admitted(context.principal, documentName);
    },
    async onLoadDocument({ documentName, document }) {
      const documentId = idOf(documentName);
      const draft: OpenDraft = { documentId, name: documentName, document, version: 0, touched: false, contributors: {}, updates: [], awareness: new Set(), relayTimer: null, tellOthersAfterStoring: false };
      // Before reading, or what is written between the two would be missed.
      await relay.join(liveChannel(documentId), payload => onRelayed(draft, payload));
      const stored = await services.live.read(documentId);
      if (!stored) {
        await relay.leave(liveChannel(documentId));
        throw refusal("stale");
      }
      draft.version = stored.version;
      open.set(documentId, draft);
      void publish(draft, "h");
      lookAround ??= setInterval(() => void lookAroundNow().catch(() => undefined), deps.lookAroundMs ?? LOOK_AROUND_MS);
      lookAround.unref();
      return stored.state;
    },
    async onChange({ documentName, update, transactionOrigin, context }) {
      const draft = open.get(idOf(documentName));
      if (!draft || (transactionOrigin as { source?: string } | null)?.source !== "connection") return;
      draft.touched = true;
      const principal = (context as LiveContext | undefined)?.principal;
      if (principal) draft.contributors[principal.id] = principal.displayName;
      draft.updates.push(update);
      scheduleRelay(draft);
    },
    async onAwarenessUpdate({ documentName, added, updated, removed, transactionOrigin }) {
      const draft = open.get(idOf(documentName));
      if (!draft || transactionOrigin === FROM_OTHER_REPLICA) return;
      for (const client of [...added, ...updated, ...removed]) draft.awareness.add(client);
      scheduleRelay(draft);
    },
    async onStoreDocument({ documentName }) {
      const draft = open.get(idOf(documentName));
      if (draft) await store(draft);
    },
    async afterUnloadDocument({ documentName }) {
      const documentId = idOf(documentName);
      const draft = open.get(documentId);
      if (draft?.name !== documentName) return;
      if (draft.relayTimer) {
        clearTimeout(draft.relayTimer);
        flushRelay(draft);
      }
      open.delete(documentId);
      await relay.leave(liveChannel(documentId));
      if (open.size === 0 && lookAround) {
        clearInterval(lookAround);
        lookAround = null;
      }
    }
  });

  const attach = (socket: WebSocket, incoming: IncomingMessage) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
    const deadline = setTimeout(() => socket.terminate(), deps.admittedWithinMs ?? ADMITTED_WITHIN_MS);
    deadline.unref();
    const connection = hocuspocus.handleConnection(socket, new Request(new URL(incoming.url ?? LIVE_PATH, deps.publicOrigin), { headers }), { letIn: () => clearTimeout(deadline) } as LiveContext);
    // Someone reading along sends nothing, and that should not look like having gone away.
    const ping = setInterval(() => socket.ping(), PING_MS);
    ping.unref();
    socket.on("pong", () => connection.touch());
    socket.on("message", (data: Buffer) => connection.handleMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
    socket.on("close", (code, reason) => {
      clearInterval(ping);
      clearTimeout(deadline);
      connection.handleClose({ code, reason: reason.toString() });
    });
    socket.on("error", () => socket.terminate());
  };

  /** A browser brings the cookie along wherever the page asking is from, and says where that is: on this address, or on the one the site calls its own. */
  const fromAnotherSite = ({ headers }: IncomingMessage) => {
    const site = headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") return true;
    const { origin } = headers;
    if (!origin || origin === deps.publicOrigin) return false;
    return !URL.canParse(origin) || new URL(origin).host !== headers.host;
  };

  const refuse = (socket: Duplex, status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  return {
    /** For a server's `upgrade` event, where anything thrown ends the whole process, and anyone can send any address. */
    handleUpgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer): void {
      // From here the HTTP server no longer looks after this socket, and whoever is on the other end can reset it at any moment.
      socket.on("error", () => socket.destroy());
      const url = incoming.url ?? "/";
      if (!URL.canParse(url, deps.publicOrigin) || new URL(url, deps.publicOrigin).pathname !== `${deps.basePath ?? ""}${LIVE_PATH}`) refuse(socket, "404 Not Found");
      else if (draining) refuse(socket, "503 Service Unavailable");
      else if (fromAnotherSite(incoming)) refuse(socket, "403 Forbidden");
      else {
        sockets.handleUpgrade(incoming, socket, head, connected => {
          try {
            attach(connected, incoming);
          } catch {
            connected.terminate();
          }
        });
      }
    },
    /** A page has changed, or may have. */
    wake(): void {
      void catchUp().catch(() => undefined);
    },
    /** Sends nobody away yet, and takes in nobody new, so that a load balancer can move them. */
    drain(): void {
      draining = true;
    },
    get connections() {
      return hocuspocus.getConnectionsCount();
    },
    get drafts() {
      return open.size;
    },
    /** Writes down what it holds and lets everyone go. They reconnect to another replica, with nothing lost. */
    async stop(): Promise<void> {
      draining = true;
      if (lookAround) clearInterval(lookAround);
      await Promise.all([...open.values()].map(draft => storeNow(draft).catch(() => undefined)));
      hocuspocus.closeConnections();
      for (const client of sockets.clients) client.terminate();
      relay.stop();
    }
  };
}

export type LiveHub = ReturnType<typeof createLiveHub>;
