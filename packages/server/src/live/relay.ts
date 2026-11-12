import pg from "pg";

const RECONNECT_MS = 2000;

/**
 * Tells other replicas what happens in a draft, through PostgreSQL, so that a deployment needs nothing else to scale out.
 * Only replicas with that draft open hear about it. What goes through here is only ever a shortcut: everything is also
 * written to the database, where a replica that missed something finds it.
 */
export function createLiveRelay(deps: { readonly connectionString: string; readonly publish: (channel: string, payload: string) => Promise<unknown>; readonly onReconnect: () => void }) {
  const handlers = new Map<string, (payload: string) => void>();
  let client: pg.Client | null = null;
  let connecting: Promise<void> | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const discard = (target: pg.Client) => {
    target.removeAllListeners();
    // A connection on its way out can still report errors, and an unheard one would end the process.
    target.on("error", () => undefined);
    void target.end().catch(() => undefined);
    if (client === target) client = null;
  };

  const lost = (target: pg.Client) => {
    discard(target);
    if (stopped || retry || handlers.size === 0) return;
    retry = setTimeout(() => {
      retry = null;
      void connect().then(deps.onReconnect, () => undefined);
    }, RECONNECT_MS);
    retry.unref();
  };

  const connect = () => {
    connecting ??= (async () => {
      const next = new pg.Client({ connectionString: deps.connectionString, keepAlive: true });
      next.on("error", () => lost(next));
      next.on("end", () => lost(next));
      next.on("notification", message => handlers.get(message.channel)?.(message.payload ?? ""));
      try {
        await next.connect();
        for (const channel of handlers.keys()) await next.query(`LISTEN "${channel}"`);
        client = next;
      } catch (error) {
        lost(next);
        throw error;
      }
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  return {
    /** Listens before returning. If that cannot happen right now, whoever asked still works, and hears of things more slowly. */
    async join(channel: string, handler: (payload: string) => void): Promise<void> {
      handlers.set(channel, handler);
      if (stopped) return;
      try {
        if (connecting) await connecting;
        if (client) await client.query(`LISTEN "${channel}"`);
        else await connect();
      } catch {
        // Trying again is in hand, and it listens for everything then.
      }
    },
    async leave(channel: string): Promise<void> {
      handlers.delete(channel);
      await client?.query(`UNLISTEN "${channel}"`).catch(() => undefined);
    },
    publish: (channel: string, payload: string) => deps.publish(channel, payload),
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      handlers.clear();
      if (client) discard(client);
    }
  };
}

export type LiveRelay = ReturnType<typeof createLiveRelay>;
