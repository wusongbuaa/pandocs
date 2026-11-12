import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";

/**
 * Longer than the idle timeout of any load balancer in front, which is 60 seconds for most. Otherwise a balancer can send
 * a request down a connection just as this side closes it, and someone gets a 502 for no reason.
 */
const KEEP_ALIVE_MS = 65_000;

/** Leaves the global `Request` and `Response` alone, so the libraries in this process all see the same classes. */
export function listen(app: Hono, options: { hostname: string; port: number }, onListening?: (info: AddressInfo) => void) {
  const server = serve({ fetch: app.fetch, hostname: options.hostname, port: options.port, overrideGlobalObjects: false }, onListening) as Server;
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 1000;
  let draining = false;
  // Listens first, so the header is there before anything is sent.
  server.prependListener("request", (_request, response) => {
    if (draining) response.setHeader("Connection", "close");
  });
  return Object.assign(server, {
    /**
     * Keeps answering, but tells each client to use a new connection afterwards, which a load balancer sends elsewhere.
     * Closing with connections still in use would break a request that happens to be on its way down one.
     */
    drain() {
      draining = true;
    }
  });
}

export type Listening = ReturnType<typeof listen>;
