import type pg from "pg";

const WINDOW_MINUTES = 15;
const MAX_FAILURES = 10;

/** Counted in the database, so a guesser cannot get a fresh allowance from each replica. */
export function createLoginThrottle(pool: pg.Pool) {
  return {
    async blocked(key: string, limit = MAX_FAILURES): Promise<boolean> {
      const { rows } = await pool.query<{ failures: number }>(
        `SELECT failures FROM pandocs.login_attempts WHERE key = $1 AND window_start > now() - make_interval(mins => $2)`,
        [key, WINDOW_MINUTES]
      );
      return (rows[0]?.failures ?? 0) >= limit;
    },
    async fail(key: string): Promise<void> {
      await pool.query(
        `INSERT INTO pandocs.login_attempts (key, failures, window_start) VALUES ($1, 1, now())
         ON CONFLICT (key) DO UPDATE SET
           failures = CASE WHEN pandocs.login_attempts.window_start > now() - make_interval(mins => $2) THEN pandocs.login_attempts.failures + 1 ELSE 1 END,
           window_start = CASE WHEN pandocs.login_attempts.window_start > now() - make_interval(mins => $2) THEN pandocs.login_attempts.window_start ELSE now() END`,
        [key, WINDOW_MINUTES]
      );
    },
    /** For something that costs each time rather than only when it fails. Counting and checking are one step, so asking at once gets no more. */
    async spend(key: string, limit: number): Promise<boolean> {
      const { rows } = await pool.query<{ failures: number }>(
        `INSERT INTO pandocs.login_attempts (key, failures, window_start) VALUES ($1, 1, now())
         ON CONFLICT (key) DO UPDATE SET
           failures = CASE WHEN pandocs.login_attempts.window_start > now() - make_interval(mins => $2) THEN pandocs.login_attempts.failures + 1 ELSE 1 END,
           window_start = CASE WHEN pandocs.login_attempts.window_start > now() - make_interval(mins => $2) THEN pandocs.login_attempts.window_start ELSE now() END
         RETURNING failures`,
        [key, WINDOW_MINUTES]
      );
      return rows[0]!.failures <= limit;
    },
    async clear(key: string): Promise<void> {
      await pool.query(`DELETE FROM pandocs.login_attempts WHERE key = $1`, [key]);
    }
  };
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>;
