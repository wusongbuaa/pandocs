import type { PandocsServices } from "@pandocs/core";

/** Turning a space private takes effect at once anyway, since each request checks it. This only decides whether to look. */
const SLUGS_TTL_MS = 5000;
const WINDOW_MS = 60_000;
/** A page takes a dozen requests or so, and a whole office can share an address. */
const REQUESTS_PER_WINDOW = 600;
/** Searching is by far the most expensive thing someone with no login can ask for. */
const SEARCHES_PER_WINDOW = 120;
const HOUR_MS = 3_600_000;
/** Each one is a call to a model the site pays for, on a site that has chosen to allow it. There is a limit for all visitors together as well. */
const QUESTIONS_PER_HOUR = 20;
/** More than anyone has to say, and few enough that nobody fills up someone's notifications. */
const FEEDBACK_PER_HOUR = 30;
const MANAGE_SEGMENT = "_";

/**
 * Keeps one visitor from taking a replica down. It counts per replica, so the real limit grows with them, and anything
 * more determined is for a CDN or a firewall in front.
 */
export function createRateLimiter(limit: number, windowMs = WINDOW_MS) {
  let window = 0;
  let counts = new Map<string, number>();
  return {
    allow(key: string, now = Date.now()): boolean {
      const current = Math.floor(now / windowMs);
      if (current !== window) {
        window = current;
        counts = new Map();
      }
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count <= limit;
    }
  };
}

/** What someone with no login can get to. With no public spaces it is nothing at all, and the site behaves as a closed one. */
export function createPublicAccess(deps: { readonly services: PandocsServices; readonly enabled: boolean }) {
  const { services, enabled } = deps;
  let cached: { until: number; slugs: ReadonlySet<string> } | null = null;
  const requests = createRateLimiter(REQUESTS_PER_WINDOW);
  const searches = createRateLimiter(SEARCHES_PER_WINDOW);
  const questions = createRateLimiter(QUESTIONS_PER_HOUR, HOUR_MS);
  const feedback = createRateLimiter(FEEDBACK_PER_HOUR, HOUR_MS);

  const slugs = async (): Promise<ReadonlySet<string>> => {
    if (!enabled) return new Set();
    if (cached && cached.until > Date.now()) return cached.slugs;
    const found = new Set(await services.spaces.publicSlugs());
    cached = { until: Date.now() + SLUGS_TTL_MS, slugs: found };
    return found;
  };

  return {
    /** Whether anyone with no login should be answered at all. */
    async open(): Promise<boolean> {
      return (await slugs()).size > 0;
    },
    /**
     * Whether this page address may be served to someone with no login. On a site with something public, what they cannot
     * see gets the same answer as what is not there, so nothing tells a closed space from no space. Only the app's own
     * pages need a login whatever is in them.
     */
    async allowsPage(pathname: string): Promise<boolean> {
      if ((await slugs()).size === 0) return false;
      const [first, second] = pathname.split("/").filter(Boolean);
      if (first === MANAGE_SEGMENT) return false;
      if (second !== MANAGE_SEGMENT) return true;
      const { locales, defaultLang } = await services.site.get();
      return !locales.some(({ lang }) => lang === first && lang !== defaultLang);
    },
    allowRequest(address: string, pathname: string): boolean {
      if (!requests.allow(address)) return false;
      if (pathname.endsWith("/search")) return searches.allow(address);
      if (pathname.endsWith("/ask")) return questions.allow(address);
      if (/\/feedback(?:\/|$)/u.test(pathname)) return feedback.allow(address);
      return true;
    }
  };
}

export type PublicAccess = ReturnType<typeof createPublicAccess>;
