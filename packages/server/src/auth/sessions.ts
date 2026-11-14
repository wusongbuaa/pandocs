import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { mapUser, type User } from "./users.js";

const SESSION_DAYS = 30;
/** Renewing on every request would write to the database on every request. */
const RENEW_AFTER_MS = 60 * 60 * 1000;

export const SESSION_COOKIE = "pandocs_session";
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 3600;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export function createSessionStore(pool: pg.Pool) {
  return {
    async create(userId: string): Promise<string> {
      const token = newToken();
      await pool.query(
        `INSERT INTO pandocs.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
        [hashToken(token), userId, SESSION_DAYS]
      );
      return token;
    },
    async userOf(token: string): Promise<User | null> {
      const hash = hashToken(token);
      const { rows } = await pool.query(
        `SELECT u.*, s.last_seen_at AS session_seen_at FROM pandocs.sessions s JOIN pandocs.users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
        [hash]
      );
      if (!rows[0]) return null;
      if (Date.now() - new Date(rows[0].session_seen_at as string).getTime() > RENEW_AFTER_MS) {
        await pool.query(
          `UPDATE pandocs.sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE token_hash = $1`,
          [hash, SESSION_DAYS]
        );
      }
      return mapUser(rows[0]);
    },
    async destroy(token: string): Promise<void> {
      await pool.query(`DELETE FROM pandocs.sessions WHERE token_hash = $1`, [hashToken(token)]);
    },
    async destroyOthers(userId: string, keep: string): Promise<void> {
      await pool.query(`DELETE FROM pandocs.sessions WHERE user_id = $1 AND token_hash <> $2`, [
        userId,
        hashToken(keep)
      ]);
    },
    async destroyAllFor(userId: string): Promise<void> {
      await pool.query(`DELETE FROM pandocs.sessions WHERE user_id = $1`, [userId]);
    },
    async sweep(): Promise<void> {
      await pool.query(`DELETE FROM pandocs.sessions WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM pandocs.login_attempts WHERE window_start < now() - interval '1 day'`);
      await pool.query(`DELETE FROM pandocs.password_links WHERE expires_at <= now()`);
    }
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
