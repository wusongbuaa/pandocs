import pg from "pg";

const RECONNECT_MS = 2000;
/** Notifications can be lost while reconnecting, so readers also look for themselves now and then. */
const FALLBACK_MS = 10_000;

/**
 * Wakes this process when anything changes, on any replica. `LISTEN` needs a connection of its own: a pooler in
 * transaction mode would drop it, so `PANDOCS_DATABASE_LISTEN_URL` can point straight at the database.
 */
export function createChangeListener(connectionString: string, onChange: () => void, options: { readonly fallbackMs?: number; readonly reconnectMs?: number } = {}) {
  let client: pg.Client | null = null;
  let stopped = false;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  const fallback = setInterval(onChange, options.fallbackMs ?? FALLBACK_MS);
  fallback.unref();

  const discard = (target: pg.Client) => {
    target.removeAllListeners();
    // A connection on its way out can still report errors, and an unheard one would end the process.
    target.on("error", () => undefined);
    void target.end().catch(() => undefined);
    if (client === target) client = null;
  };

  const lost = (target: pg.Client) => {
    discard(target);
    if (stopped || reconnect) return;
    reconnect = setTimeout(() => {
      reconnect = null;
      void connect();
    }, options.reconnectMs ?? RECONNECT_MS);
    reconnect.unref();
  };

  const connect = async () => {
    const next = new pg.Client({ connectionString, keepAlive: true });
    next.on("error", () => lost(next));
    next.on("end", () => lost(next));
    next.on("notification", onChange);
    try {
      await next.connect();
      await next.query("LISTEN pandocs_changes");
      client = next;
      // Whatever happened while no one was listening.
      onChange();
    } catch {
      lost(next);
    }
  };

  void connect();
  return {
    stop() {
      stopped = true;
      clearInterval(fallback);
      if (reconnect) clearTimeout(reconnect);
      if (client) discard(client);
    }
  };
}
