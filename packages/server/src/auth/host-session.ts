import { createHash } from "node:crypto";
import type { HostSessionConfig } from "../config.js";
import { readCookie } from "./identity.js";
import { userFromProfile } from "./provision.js";
import type { User, UserStore } from "./users.js";

/** Longer than that, and someone waits for a page while the host decides. */
const ASK_WITHIN_MS = 5000;
/** A cookie the host turned down is asked about again after this, rather than on every request. */
const REFUSED_SECONDS = 10;
/** Enough for everyone on a busy site within one answer's time, and no more than a little memory. */
const REMEMBERED = 10_000;

type Log = (event: string, fields: Readonly<Record<string, unknown>>) => void;

/** A value at a path such as `data.user.id`, for hosts whose answers wrap what they say. */
function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);
}

/**
 * Who someone is, as the site this one lives beside says when asked with its own session cookie. Each answer counts for
 * a while, so the host is asked about each person now and then rather than on every request, and signing out there takes
 * that long to reach here. The cookies sent are only the ones named, and only ever to the address set up for it.
 */
export function createHostSessions(config: HostSessionConfig, deps: { readonly users: UserStore; readonly fetch?: typeof fetch; readonly now?: () => number; readonly log?: Log }) {
  const ask = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log: Log = deps.log ?? ((event, fields) => console.warn(JSON.stringify({ event, ...fields })));
  // The same subject at another host would be another person.
  const issuer = new URL(config.url).origin;
  const remembered = new Map<string, { readonly user: User | null; readonly until: number }>();
  const asking = new Map<string, Promise<User | null>>();

  /** For a host that says who someone is but not their address: unique, and plainly not a mailbox, so no mail goes to it. */
  const standInEmail = (subject: string) => `${encodeURIComponent(subject).toLowerCase()}@${new URL(config.url).hostname}.invalid`;

  const lookUp = async (cookie: string): Promise<{ user: User | null; seconds: number }> => {
    let response: Response;
    try {
      // Not followed: a host sends someone it does not know to its login, which says nothing about who they are.
      response = await ask(config.url, { headers: { cookie, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(ASK_WITHIN_MS) });
    } catch (error) {
      log("auth.host_session_unreachable", { message: error instanceof Error ? error.message : String(error) });
      return { user: null, seconds: 0 };
    }
    if (response.status >= 500) {
      log("auth.host_session_failed", { status: response.status });
      return { user: null, seconds: 0 };
    }
    if (!response.ok) return { user: null, seconds: REFUSED_SECONDS };
    const answer: unknown = await response.json().catch(() => null);
    const subject = at(answer, config.subjectClaim);
    if ((typeof subject !== "string" || !subject) && typeof subject !== "number") {
      log("auth.host_session_no_subject", { claim: config.subjectClaim });
      return { user: null, seconds: REFUSED_SECONDS };
    }
    const email = at(answer, config.emailClaim);
    const name = at(answer, config.nameClaim);
    const groups = at(answer, config.groupsClaim);
    const result = await userFromProfile(deps.users, { allowedDomains: [], adminGroup: config.adminGroup }, {
      issuer,
      subject: String(subject),
      email: typeof email === "string" && email ? email : standInEmail(String(subject)),
      // The host is who decides who people are here.
      emailVerified: true,
      displayName: typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : undefined,
      groups: Array.isArray(groups) ? groups.flatMap(group => (typeof group === "string" || typeof group === "number" ? [String(group)] : [])) : typeof groups === "string" ? [groups] : []
    });
    if ("error" in result) {
      log("auth.host_session_refused", { reason: result.error });
      return { user: null, seconds: REFUSED_SECONDS };
    }
    return { user: result, seconds: config.cacheSeconds };
  };

  return {
    /** The person the host says the request's cookies belong to, or `null` for nobody it knows. */
    async userOf(request: Request): Promise<User | null> {
      const sent = config.cookies.flatMap(name => {
        const value = readCookie(request, name);
        return value ? [`${name}=${value}`] : [];
      });
      if (sent.length === 0) return null;
      const cookie = sent.join("; ");
      // Kept by a hash, so what is in memory is no way in.
      const key = createHash("sha256").update(cookie).digest("hex");
      const known = remembered.get(key);
      if (known && known.until > now()) return known.user;
      const pending = asking.get(key);
      if (pending) return pending;
      const answer = lookUp(cookie).then(({ user, seconds }) => {
        if (remembered.size >= REMEMBERED) remembered.clear();
        if (seconds > 0) remembered.set(key, { user, until: now() + seconds * 1000 });
        else remembered.delete(key);
        return user;
      }).finally(() => asking.delete(key));
      asking.set(key, answer);
      return answer;
    },
    /** Where to sign in at the host, coming back to `address` afterwards. `null` when the host has no such page set up. */
    loginUrl(address: string): string | null {
      return config.loginUrl ? config.loginUrl.replace("{url}", encodeURIComponent(address)) : null;
    }
  };
}

export type HostSessions = ReturnType<typeof createHostSessions>;
