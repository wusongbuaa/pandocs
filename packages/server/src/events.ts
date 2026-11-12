import type { PandocsServices, ChangeRow, Principal, SpaceAccess } from "@pandocs/core";
import { validCursor } from "@pandocs/core";
import { errorResponse } from "./api/responses.js";
import type { Identity } from "./auth/identity.js";
import { t } from "@pandocs/i18n";

const HEARTBEAT_MS = 25_000;
/** Frames written that a client has not read yet, past which it has stopped reading. */
const MOST_WAITING_FRAMES = 1000;
const RECHECK_MS = 60_000;
/** Enough for one person's tabs and tools, and a limit on what one leaked token can hold open. */
const MAX_STREAMS_PER_PRINCIPAL = 32;
/** Past this a client should compare a manifest instead of being told about each change. */
const MAX_REPLAY_PAGES = 20;
const encoder = new TextEncoder();

interface Subscriber {
  readonly credentials: Request;
  readonly space: string | undefined;
  readonly document: string | undefined;
  principal: Principal;
  access: SpaceAccess;
  checkedAt: number;
  send(row: ChangeRow): void;
  close(): void;
}

const frame = ({ restricted: _restricted, ...row }: ChangeRow) =>
  `id: ${row.cursor}\nevent: change\ndata: ${JSON.stringify(row)}\n\n`;
const RESET_FRAME = "event: reset\ndata: {}\n\n";

/** One read of the log per wake-up, however many people are connected: thousands of open pages must not mean thousands of queries. */
export function createEventHub(deps: {
  readonly identity: Identity;
  readonly services: PandocsServices;
  readonly recheckMs?: number;
}) {
  const { identity, services } = deps;
  const recheckMs = deps.recheckMs ?? RECHECK_MS;
  const subscribers = new Set<Subscriber>();
  let cursor: string | null = null;
  let running = false;
  let again = false;

  const deliver = async (subscriber: Subscriber, rows: readonly ChangeRow[]) => {
    // A stream outlives the login that opened it, so it answers to the same checks a new request would.
    if (Date.now() - subscriber.checkedAt >= recheckMs) {
      const auth = await identity.authenticate(subscriber.credentials);
      if (!auth.ok) {
        subscriber.close();
        return;
      }
      subscriber.principal = auth.principal;
      subscriber.access = await services.changes.access(auth.principal, subscriber.space);
      subscriber.checkedAt = Date.now();
    }
    const wanted = subscriber.document ? rows.filter(row => row.documentId === subscriber.document) : rows;
    for (const row of await services.changes.visibleTo(subscriber.principal, wanted, subscriber.access))
      subscriber.send(row);
  };

  const pump = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      cursor ??= await services.changes.watermark();
      for (
        let rows = await services.changes.settledSince(cursor);
        rows.length > 0;
        rows = await services.changes.settledSince(cursor)
      ) {
        cursor = rows.at(-1)!.cursor;
        // A client that gets dropped here reconnects with where it was, and misses nothing.
        await Promise.all(
          [...subscribers].map(subscriber => deliver(subscriber, rows).catch(() => subscriber.close()))
        );
      }
    } finally {
      running = false;
      if (again) {
        again = false;
        void pump().catch(logFailure);
      }
    }
  };

  const logFailure = (error: unknown) =>
    console.error(
      JSON.stringify({ event: "events.pump_failed", message: error instanceof Error ? error.message : "" })
    );

  return {
    wake() {
      void pump().catch(logFailure);
    },
    get connected() {
      return subscribers.size;
    },
    /** Ends every stream, so that a process shutting down is not held open by them. Clients reconnect to another replica. */
    stop() {
      for (const subscriber of [...subscribers]) subscriber.close();
    },
    /** `GET /api/v1/events`: what changed, as it happens, limited to what this person can read. Reconnecting with `Last-Event-ID` misses nothing. */
    async handle(request: Request): Promise<Response> {
      const auth = await identity.authenticate(request);
      if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message);
      // The stream tells of pages by their addresses, and a share link is for its own pages only.
      if (auth.principal.shared) return errorResponse(404, "NOT_FOUND", t("No such space"));
      const url = new URL(request.url);
      const space = url.searchParams.get("space") ?? undefined;
      const document = url.searchParams.get("document") ?? undefined;
      const since = request.headers.get("last-event-id") ?? url.searchParams.get("since");
      if (since !== null && !validCursor(since))
        return errorResponse(422, "PARAM_INVALID", t("since should be an event id"));
      if (
        [...subscribers].filter(subscriber => subscriber.principal.id === auth.principal.id).length >=
        MAX_STREAMS_PER_PRINCIPAL
      ) {
        return errorResponse(429, "TOO_MANY_STREAMS", t("Too many event streams are open"));
      }
      const access = await services.changes.access(auth.principal, space);
      if (space && access.readable.size === 0) return errorResponse(404, "NOT_FOUND", t("No such space"));
      if (document) {
        try {
          await services.documents.read(auth.principal, document, { scope: { scope: "outline" } });
        } catch {
          return errorResponse(404, "NOT_FOUND", t("No such document"));
        }
      }
      // Before joining, or rows from now until the first wake-up would fall between the two.
      cursor ??= await services.changes.watermark();
      const start = since ?? (await services.changes.watermark());
      const credentials = new Request(request.url, { headers: request.headers });
      let subscriber: Subscriber | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let open = true;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (text: string) => {
            if (!open) return;
            // A client that stopped reading would have everything kept here for it until it went away. It can come back
            // from the last event it saw, so it is let go instead.
            if ((controller.desiredSize ?? 0) < -MOST_WAITING_FRAMES) {
              close();
              return;
            }
            controller.enqueue(encoder.encode(text));
          };
          const close = () => {
            if (!open) return;
            open = false;
            if (subscriber) subscribers.delete(subscriber);
            if (heartbeat) clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              // Already gone with the client.
            }
          };
          // Gives a client that has seen nothing yet a place to come back to.
          write(`id: ${start}\nevent: ready\ndata: {}\n\n`);
          // Joined before replaying, so nothing falls between the two. What arrives meanwhile waits, so a client sees rows in order and once.
          let held: ChangeRow[] | null = since === null ? null : [];
          // The hub may only reach these rows after the replay has sent them.
          const replayed = new Set<string>();
          const send = (row: ChangeRow) => {
            if (held) {
              held.push(row);
            } else if (!replayed.has(row.cursor)) {
              // The hub works in order, so one row beyond the replay means it has passed all of it.
              replayed.clear();
              write(frame(row));
            }
          };
          subscriber = {
            credentials,
            space,
            document,
            principal: auth.principal,
            access,
            checkedAt: Date.now(),
            send,
            close
          };
          subscribers.add(subscriber);
          heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);
          heartbeat.unref();
          if (since === null) return;
          try {
            let position = since;
            for (let page = 0; ; page += 1) {
              if (page === MAX_REPLAY_PAGES) {
                write(RESET_FRAME);
                break;
              }
              const { changes, next, reset } = await services.changes.since(auth.principal, { since: position, space });
              if (page === 0 && reset) write(RESET_FRAME);
              for (const row of changes) {
                replayed.add(row.cursor);
                if (!document || row.documentId === document) write(frame(row));
              }
              if (next === position) break;
              position = next;
            }
            const waiting = held ?? [];
            held = null;
            for (const row of waiting) if (!replayed.has(row.cursor)) write(frame(row));
          } catch {
            close();
          }
        },
        cancel() {
          open = false;
          if (subscriber) subscribers.delete(subscriber);
          if (heartbeat) clearInterval(heartbeat);
        }
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no"
        }
      });
    }
  };
}

export type EventHub = ReturnType<typeof createEventHub>;
