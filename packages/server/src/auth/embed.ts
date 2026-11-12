import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";

export const EMBED_SECRET_PREFIX = "pda_";
export const GUEST_TOKEN_PREFIX = "pdg_";
const DEFAULT_TTL_SECONDS = 60 * 60;
export const MAX_TTL_SECONDS = 12 * 60 * 60;
/** Often enough that "last used" means something, without a write on every session. */
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export type EmbedStatus = "active" | "disabled";

export interface EmbedApp {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly status: EmbedStatus;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/** What a token says. `ticket` is the read-only kind that can travel in an address, for images and event streams. */
export interface GuestClaims {
  readonly kind: "session" | "ticket";
  readonly app: string;
  readonly sub: string;
  readonly name: string;
  readonly groups: readonly string[];
  /** Seconds since the epoch. */
  readonly exp: number;
}

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

const mapApp = (row: Record<string, unknown>): EmbedApp => ({
  id: String(row.id),
  slug: String(row.slug),
  name: String(row.name),
  allowedOrigins: row.allowed_origins as string[],
  status: row.status as EmbedStatus,
  createdAt: row.created_at as Date,
  lastUsedAt: (row.last_used_at as Date | null) ?? null
});

/** A plain origin, or one level of wildcard, since that is all `frame-ancestors` understands and all anyone needs. */
export const validOrigin = (origin: string) => /^https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?$/iu.test(origin);

/**
 * Tokens sign what they say instead of being looked up, so a page of many requests costs no extra queries beyond checking
 * the app is still active. They are short-lived for the same reason: there is no list to take one off. Disabling the app
 * is the way to stop them all at once.
 */
export function createEmbedApps(pool: pg.Pool, signingSecret: string) {
  // Its own key, so a token here can never pass for anything else this server signs.
  const key = createHmac("sha256", signingSecret).update("pandocs-guest-token-v1").digest();

  const sign = (claims: GuestClaims): string => {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${GUEST_TOKEN_PREFIX}${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  };

  return {
    async list(): Promise<EmbedApp[]> {
      const { rows } = await pool.query(`SELECT * FROM pandocs.embed_apps ORDER BY created_at`);
      return rows.map(mapApp);
    },
    async bySlug(slug: string): Promise<EmbedApp | null> {
      const { rows } = await pool.query(`SELECT * FROM pandocs.embed_apps WHERE slug = $1`, [slug]);
      return rows[0] ? mapApp(rows[0]) : null;
    },
    /** The secret exists only in this answer. */
    async create(input: { slug: string; name: string; allowedOrigins: readonly string[] }): Promise<{ app: EmbedApp; secret: string } | null> {
      const secret = `${EMBED_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
      const { rows } = await pool.query(
        `INSERT INTO pandocs.embed_apps (slug, name, secret_hash, allowed_origins) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING RETURNING *`,
        [input.slug, input.name, hashSecret(secret), input.allowedOrigins]
      );
      return rows[0] ? { app: mapApp(rows[0]), secret } : null;
    },
    async update(slug: string, patch: { name?: string | undefined; allowedOrigins?: readonly string[] | undefined; status?: EmbedStatus | undefined }): Promise<EmbedApp | null> {
      const { rows } = await pool.query(
        `UPDATE pandocs.embed_apps SET name = COALESCE($2, name), allowed_origins = COALESCE($3, allowed_origins), status = COALESCE($4, status) WHERE slug = $1 RETURNING *`,
        [slug, patch.name ?? null, patch.allowedOrigins ?? null, patch.status ?? null]
      );
      return rows[0] ? mapApp(rows[0]) : null;
    },
    async rotateSecret(slug: string): Promise<string | null> {
      const secret = `${EMBED_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
      const { rowCount } = await pool.query(`UPDATE pandocs.embed_apps SET secret_hash = $2 WHERE slug = $1`, [slug, hashSecret(secret)]);
      return rowCount ? secret : null;
    },
    async remove(slug: string): Promise<boolean> {
      const { rowCount } = await pool.query(`DELETE FROM pandocs.embed_apps WHERE slug = $1`, [slug]);
      return Boolean(rowCount);
    },
    async bySecret(secret: string): Promise<EmbedApp | null> {
      const { rows } = await pool.query(`SELECT * FROM pandocs.embed_apps WHERE secret_hash = $1 AND status = 'active'`, [hashSecret(secret)]);
      if (!rows[0]) return null;
      const app = mapApp(rows[0]);
      if (!app.lastUsedAt || Date.now() - app.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
        await pool.query(`UPDATE pandocs.embed_apps SET last_used_at = now() WHERE id = $1`, [app.id]);
      }
      return app;
    },
    issue(app: EmbedApp, user: { id: string; displayName: string; groups?: readonly string[] | undefined }, ttlSeconds = DEFAULT_TTL_SECONDS): { token: string; expiresAt: Date } {
      const exp = Math.floor(Date.now() / 1000) + Math.min(ttlSeconds, MAX_TTL_SECONDS);
      return { token: sign({ kind: "session", app: app.slug, sub: user.id, name: user.displayName, groups: user.groups ?? [], exp }), expiresAt: new Date(exp * 1000) };
    },
    /** The same claims and lifetime, in the form that may appear in an address. */
    ticketFor(claims: GuestClaims): string {
      return sign({ ...claims, kind: "ticket" });
    },
    verify(token: string): GuestClaims | null {
      if (!token.startsWith(GUEST_TOKEN_PREFIX)) return null;
      const [payload = "", signature = ""] = token.slice(GUEST_TOKEN_PREFIX.length).split(".");
      const expected = createHmac("sha256", key).update(payload).digest();
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as GuestClaims;
        return claims.exp > Date.now() / 1000 ? claims : null;
      } catch {
        return null;
      }
    }
  };
}

export type EmbedApps = ReturnType<typeof createEmbedApps>;
