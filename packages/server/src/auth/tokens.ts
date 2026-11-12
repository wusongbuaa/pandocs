import type pg from "pg";
import { hashToken, newToken } from "./sessions.js";
import { mapUser, type User } from "./users.js";

export const TOKEN_PREFIX = "pd_";
const LAST_USED_RESOLUTION_MS = 60_000;

export type TokenScope = "read" | "write";
export type TokenKind = "user" | "agent";

export interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly kind: TokenKind;
  readonly scopes: readonly TokenScope[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
}

const mapToken = (row: Record<string, unknown>): ApiToken => ({
  id: String(row.id),
  name: String(row.name),
  kind: row.kind as TokenKind,
  scopes: row.scopes as TokenScope[],
  createdAt: new Date(row.created_at as string),
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : null,
  expiresAt: row.expires_at ? new Date(row.expires_at as string) : null
});

export function createTokenStore(pool: pg.Pool) {
  return {
    /** The only time the token itself exists outside its holder's hands: just its hash is kept. */
    async create(
      userId: string,
      input: {
        name: string;
        kind: TokenKind;
        scopes: readonly TokenScope[];
        expiresInDays?: number | undefined;
        expiresInSeconds?: number | undefined;
        origin?: "manual" | "oauth" | undefined;
      }
    ): Promise<{ token: string; record: ApiToken }> {
      const token = `${TOKEN_PREFIX}${newToken()}`;
      const { rows } = await pool.query(
        `INSERT INTO pandocs.api_tokens (token_hash, user_id, name, kind, scopes, origin, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(secs => $7::int) END) RETURNING *`,
        [
          hashToken(token),
          userId,
          input.name,
          input.kind,
          input.scopes,
          input.origin ?? "manual",
          input.expiresInSeconds ?? (input.expiresInDays === undefined ? null : input.expiresInDays * 86_400)
        ]
      );
      return { token, record: mapToken(rows[0]) };
    },
    async list(userId: string): Promise<ApiToken[]> {
      const { rows } = await pool.query(
        `SELECT * FROM pandocs.api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND origin = 'manual' ORDER BY created_at DESC`,
        [userId]
      );
      return rows.map(mapToken);
    },
    async revoke(userId: string, id: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE pandocs.api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [id, userId]
      );
      return Boolean(rowCount);
    },
    async authenticate(token: string): Promise<{ user: User; token: ApiToken } | null> {
      if (!token.startsWith(TOKEN_PREFIX)) return null;
      const { rows } = await pool.query(
        `SELECT t.*, u.id AS owner_id, u.email, u.display_name, u.password_hash, u.is_admin, u.groups, u.status, u.created_at AS owner_created_at, u.last_login_at
         FROM pandocs.api_tokens t JOIN pandocs.users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.status = 'active'`,
        [hashToken(token)]
      );
      const row = rows[0];
      if (!row) return null;
      const record = mapToken(row);
      if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
        await pool.query(`UPDATE pandocs.api_tokens SET last_used_at = now() WHERE id = $1`, [record.id]);
      }
      return { user: mapUser({ ...row, id: row.owner_id, created_at: row.owner_created_at }), token: record };
    }
  };
}

export type TokenStore = ReturnType<typeof createTokenStore>;
