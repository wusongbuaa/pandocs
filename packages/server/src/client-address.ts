import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const LONGEST_ADDRESS = 64;

/**
 * Who is asking, for limits. A proxy adds the address it saw to the end of this header, and everything before that is
 * whatever the client wrote, so only the last entries can be believed: as many as there are proxies in front.
 */
export function clientAddress(c: Context, proxies: number): string {
  if (proxies > 0) {
    const forwarded = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
    const address = forwarded.at(-Math.min(proxies, forwarded.length));
    if (address) return address.slice(0, LONGEST_ADDRESS);
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
