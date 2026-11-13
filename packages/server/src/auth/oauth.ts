import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { hashToken } from "./sessions.js";
import type { TokenScope, TokenStore } from "./tokens.js";

const CODE_TTL_SECONDS = 120;
export const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_DAYS = 90;
const UNUSED_CLIENT_DAYS = 7;
const random = () => randomBytes(32).toString("base64url");

export interface OAuthClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
}

export interface OAuthGrant {
  readonly id: string;
  readonly clientName: string;
  /** The command line acts as the person, everything else as an agent. */
  readonly kind: "user" | "agent";
  readonly scopes: readonly TokenScope[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scopes: readonly TokenScope[];
}

/**
 * The command line is the one app that comes with Pandocs. It signs a person in as themselves, where every other app is
 * an agent, since what it does is theirs: `commit` saves their edits. It can only ever come back to loopback, to a
 * process already running on the person's machine, and PKCE ties the code to the one that asked (RFC 8252, 8.6).
 */
export const CLI_CLIENT_ID = "pandocs-cli";
const kindOf = (clientId: string) => (clientId === CLI_CLIENT_ID ? "user" as const : "agent" as const);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Schemes that run something rather than go somewhere. */
const DANGEROUS_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "ftp:", "ws:", "wss:"]);

/** Web apps over https, native apps on their own loopback address or a scheme of their own, which is what clients use. */
export function validRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash || DANGEROUS_SCHEMES.has(parsed.protocol)) return false;
  return parsed.protocol !== "http:" || LOOPBACK.has(parsed.hostname);
}

/** A native app listening on loopback gets whatever port is free, so its registered port cannot be held to (RFC 8252). */
export function matchesRedirect(registered: readonly string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let given: URL;
  try {
    given = new URL(uri);
  } catch {
    return false;
  }
  if (given.protocol !== "http:" || !LOOPBACK.has(given.hostname)) return false;
  return registered.some(item => {
    const known = new URL(item);
    return known.protocol === "http:" && known.hostname === given.hostname && known.pathname === given.pathname && known.search === given.search;
  });
}

export const scopesFrom = (scope: string | null | undefined): TokenScope[] | null => {
  const asked = (scope ?? "read write").split(/\s+/u).filter(Boolean);
  if (asked.some(item => item !== "read" && item !== "write")) return null;
  return asked.includes("write") ? ["read", "write"] : ["read"];
};

const verifierMatches = (verifier: string, challenge: string) => {
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export function createOAuthStore(pool: pg.Pool, tokens: TokenStore) {
  const issue = async (userId: string, clientId: string, clientName: string, scopes: readonly TokenScope[]) => tokens.create(userId, { name: clientName, kind: kindOf(clientId), scopes, expiresInSeconds: ACCESS_TTL_SECONDS, origin: "oauth" });

  /** Ends a grant, and its live access token with it. */
  const withdraw = async (grantId: string): Promise<boolean> => {
    const { rows } = await pool.query<{ access_token_id: string | null }>(`DELETE FROM pandocs.oauth_grants WHERE id = $1 RETURNING access_token_id`, [grantId]);
    if (!rows[0]) return false;
    if (rows[0].access_token_id) await pool.query(`UPDATE pandocs.api_tokens SET revoked_at = now() WHERE id = $1`, [rows[0].access_token_id]);
    return true;
  };

  /** A code or refresh token shown again after it was spent: whoever holds the grant now may not be the app. */
  const spentAgain = async (hash: string): Promise<void> => {
    const { rows } = await pool.query<{ grant_id: string }>(`SELECT grant_id FROM pandocs.oauth_spent WHERE token_hash = $1 AND expires_at > now()`, [hash]);
    if (rows[0]) await withdraw(rows[0].grant_id);
  };
  const spend = (hash: string, grantId: string) => pool.query(
    `INSERT INTO pandocs.oauth_spent (token_hash, grant_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3)) ON CONFLICT (token_hash) DO NOTHING`,
    [hash, grantId, REFRESH_TTL_DAYS]
  );

  return {
    async registerClient(input: { clientName: string; redirectUris: readonly string[] }): Promise<OAuthClient> {
      const clientId = `pdc_${randomBytes(16).toString("base64url")}`;
      await pool.query(`INSERT INTO pandocs.oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)`, [clientId, input.clientName, input.redirectUris]);
      return { clientId, clientName: input.clientName, redirectUris: input.redirectUris };
    },
    async client(clientId: string): Promise<OAuthClient | null> {
      const { rows } = await pool.query<{ client_id: string; client_name: string; redirect_uris: string[] }>(`SELECT * FROM pandocs.oauth_clients WHERE client_id = $1`, [clientId]);
      return rows[0] ? { clientId: rows[0].client_id, clientName: rows[0].client_name, redirectUris: rows[0].redirect_uris } : null;
    },
    async issueCode(input: { clientId: string; userId: string; redirectUri: string; codeChallenge: string; scopes: readonly TokenScope[] }): Promise<string> {
      const code = random();
      await pool.query(
        `INSERT INTO pandocs.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
        [hashToken(code), input.clientId, input.userId, input.redirectUri, input.codeChallenge, input.scopes, CODE_TTL_SECONDS]
      );
      return code;
    },
    /**
     * A code works once. Deleting it first means a failed attempt uses it up too, so it cannot be guessed at. One that
     * worked and comes back again takes the tokens it was exchanged for with it (RFC 6749, 4.1.2).
     */
    async exchangeCode(input: { code: string; clientId: string; redirectUri: string; verifier: string }): Promise<IssuedTokens | null> {
      const codeHash = hashToken(input.code);
      const { rows } = await pool.query<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: TokenScope[] }>(
        `DELETE FROM pandocs.oauth_codes WHERE code_hash = $1 AND expires_at > now() RETURNING *`,
        [codeHash]
      );
      const row = rows[0];
      if (!row) {
        await spentAgain(codeHash);
        return null;
      }
      if (row.client_id !== input.clientId || row.redirect_uri !== input.redirectUri || !verifierMatches(input.verifier, row.code_challenge)) return null;
      const client = await this.client(input.clientId);
      if (!client) return null;
      const refreshToken = random();
      const access = await issue(row.user_id, client.clientId, client.clientName, row.scopes);
      const { rows: granted } = await pool.query<{ id: string }>(
        `INSERT INTO pandocs.oauth_grants (client_id, user_id, scopes, refresh_hash, access_token_id, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id`,
        [input.clientId, row.user_id, row.scopes, hashToken(refreshToken), access.record.id, REFRESH_TTL_DAYS]
      );
      await spend(codeHash, granted[0]!.id);
      return { accessToken: access.token, refreshToken, scopes: row.scopes };
    },
    /**
     * The refresh token changes each time, and the access token it replaces stops working. Swapped in one statement, so
     * it can only be spent once. A spent one coming back means it was copied: the app and whoever copied it cannot be
     * told apart, so the grant ends for both, and the app asks the person again (RFC 9700, 4.14.2).
     */
    async refresh(input: { refreshToken: string; clientId: string }): Promise<IssuedTokens | null> {
      const spentHash = hashToken(input.refreshToken);
      const refreshToken = random();
      const { rows } = await pool.query<{ id: string; user_id: string; scopes: TokenScope[]; access_token_id: string | null; client_id: string; client_name: string }>(
        `UPDATE pandocs.oauth_grants g SET refresh_hash = $3, last_used_at = now(), expires_at = now() + make_interval(days => $4)
         FROM pandocs.oauth_clients c, pandocs.users u
         WHERE g.refresh_hash = $1 AND g.client_id = $2 AND g.expires_at > now() AND c.client_id = g.client_id AND u.id = g.user_id AND u.status = 'active'
         RETURNING g.id, g.user_id, g.scopes, g.access_token_id, c.client_id, c.client_name`,
        [spentHash, input.clientId, hashToken(refreshToken), REFRESH_TTL_DAYS]
      );
      const row = rows[0];
      if (!row) {
        await spentAgain(spentHash);
        return null;
      }
      await spend(spentHash, row.id);
      if (row.access_token_id) await pool.query(`UPDATE pandocs.api_tokens SET revoked_at = now() WHERE id = $1`, [row.access_token_id]);
      const access = await issue(row.user_id, row.client_id, row.client_name, row.scopes);
      await pool.query(`UPDATE pandocs.oauth_grants SET access_token_id = $2 WHERE id = $1`, [row.id, access.record.id]);
      return { accessToken: access.token, refreshToken, scopes: row.scopes };
    },
    async grants(userId: string): Promise<OAuthGrant[]> {
      const { rows } = await pool.query<{ id: string; client_id: string; client_name: string; scopes: TokenScope[]; created_at: Date; last_used_at: Date }>(
        `SELECT g.id, c.client_id, c.client_name, g.scopes, g.created_at, g.last_used_at FROM pandocs.oauth_grants g JOIN pandocs.oauth_clients c ON c.client_id = g.client_id
         WHERE g.user_id = $1 AND g.expires_at > now() ORDER BY g.last_used_at DESC`,
        [userId]
      );
      return rows.map(row => ({ id: row.id, clientName: row.client_name, kind: kindOf(row.client_id), scopes: row.scopes, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
    },
    /** Takes the live access token with it, so a person who disconnects an app sees it stop now rather than within the hour. */
    async revokeGrant(userId: string, id: string): Promise<boolean> {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM pandocs.oauth_grants WHERE id = $1 AND user_id = $2`, [id, userId]);
      return rows[0] ? withdraw(rows[0].id) : false;
    },
    /**
     * An app letting go of its own grant, by its refresh token or its current access token (RFC 7009). Either ends the
     * whole grant. Nothing is said about a token that does not fit, so this cannot be used to test tokens.
     */
    async revokeToken(input: { token: string; clientId: string }): Promise<void> {
      const hash = hashToken(input.token);
      const { rows } = await pool.query<{ id: string }>(
        `SELECT g.id FROM pandocs.oauth_grants g LEFT JOIN pandocs.api_tokens t ON t.id = g.access_token_id
         WHERE g.client_id = $2 AND (g.refresh_hash = $1 OR t.token_hash = $1)`,
        [hash, input.clientId]
      );
      if (rows[0]) await withdraw(rows[0].id);
    },
    /** Registering takes no login, so anything never used does not get to stay. */
    async sweep(): Promise<void> {
      await pool.query(`DELETE FROM pandocs.oauth_codes WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM pandocs.oauth_spent WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM pandocs.oauth_grants WHERE expires_at <= now()`);
      await pool.query(
        `DELETE FROM pandocs.oauth_clients c WHERE c.created_at < now() - make_interval(days => $1) AND c.client_id <> $2
         AND NOT EXISTS (SELECT 1 FROM pandocs.oauth_grants g WHERE g.client_id = c.client_id)`,
        [UNUSED_CLIENT_DAYS, CLI_CLIENT_ID]
      );
    }
  };
}

export type OAuthStore = ReturnType<typeof createOAuthStore>;
