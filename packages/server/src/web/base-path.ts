import { t } from "@pandocs/i18n";
import { Hono } from "hono";

/** What runs the process asks these at its own address, wherever the site lives. */
const AT_THE_ROOT = new Set(["/healthz", "/readyz"]);

/**
 * Where a request goes inside: the same path without the site's, or `null` for one that is not this site's.
 * Apps look for how to sign in at the root of the host, with the site's path after what they ask for (RFC 8414, RFC
 * 9728), which reaches here if the load balancer sends those addresses too.
 */
export function insidePath(pathname: string, base: string): string | null {
  if (pathname === base || pathname.startsWith(`${base}/`)) return pathname.slice(base.length) || "/";
  if (AT_THE_ROOT.has(pathname)) return pathname;
  for (const known of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) {
    if (pathname === `${known}${base}` || pathname.startsWith(`${known}${base}/`))
      return `${known}${pathname.slice(known.length + base.length)}`;
  }
  return null;
}

/**
 * The site served below a path of another site's, such as `/docs`, which that site's load balancer sends here as it is.
 * Everything inside works with paths below it, as it does at the root: this takes the path off what comes in, and puts it
 * back on redirects within the site, which are written from the root.
 */
export function servedUnder(base: string, app: Hono): Hono {
  if (!base) return app;
  const outer = new Hono();
  outer.all("*", async c => {
    const url = new URL(c.req.url);
    if (url.pathname === "/") return c.redirect(`${base}/`);
    const inside = insidePath(url.pathname, base);
    if (inside === null) return c.text(t("No such page"), 404);
    url.pathname = inside;
    const { raw } = c.req;
    const request = new Request(url, {
      method: raw.method,
      headers: raw.headers,
      signal: raw.signal,
      ...(raw.body ? { body: raw.body, duplex: "half" } : {})
    } as RequestInit);
    const response = await app.fetch(request, c.env);
    const location = response.headers.get("location");
    if (!location?.startsWith("/") || location.startsWith("//")) return response;
    const headers = new Headers(response.headers);
    headers.set("location", `${base}${location}`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  return outer;
}
