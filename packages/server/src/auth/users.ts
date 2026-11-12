import type pg from "pg";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly groups: readonly string[];
  readonly status: "active" | "disabled";
  readonly hasPassword: boolean;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
}

export function mapUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    isAdmin: Boolean(row.is_admin),
    groups: (row.groups ?? []) as string[],
    status: row.status as User["status"],
    hasPassword: Boolean(row.password_hash),
    createdAt: new Date(row.created_at as string),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at as string) : null
  };
}

const escapeLike = (text: string) => text.replace(/[\\%_]/gu, "\\$&");

export function createUserStore(pool: pg.Pool) {
  const one = async (sql: string, values: unknown[]) => {
    const { rows } = await pool.query(sql, values);
    return rows[0] ? mapUser(rows[0]) : null;
  };
  return {
    async count(): Promise<number> {
      const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM pandocs.users`);
      return Number(rows[0]!.count);
    },
    findById: (id: string) => one(`SELECT * FROM pandocs.users WHERE id = $1`, [id]),
    findByEmail: (email: string) => one(`SELECT * FROM pandocs.users WHERE lower(email) = lower($1)`, [email]),
    async findForLogin(email: string): Promise<{ user: User; passwordHash: string | null } | null> {
      const { rows } = await pool.query(`SELECT * FROM pandocs.users WHERE lower(email) = lower($1)`, [email]);
      return rows[0] ? { user: mapUser(rows[0]), passwordHash: rows[0].password_hash as string | null } : null;
    },
    findByIdentity: (issuer: string, subject: string) => one(
      `SELECT u.* FROM pandocs.users u JOIN pandocs.user_identities i ON i.user_id = u.id WHERE i.issuer = $1 AND i.subject = $2`,
      [issuer, subject]
    ),
    async passwordHashOf(id: string): Promise<string | null> {
      const { rows } = await pool.query<{ password_hash: string | null }>(`SELECT password_hash FROM pandocs.users WHERE id = $1`, [id]);
      return rows[0]?.password_hash ?? null;
    },
    async create(input: { email: string; displayName: string; passwordHash?: string | null | undefined; isAdmin?: boolean | undefined; groups?: readonly string[] | undefined }): Promise<User> {
      const { rows } = await pool.query(
        `INSERT INTO pandocs.users (email, display_name, password_hash, is_admin, groups) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.email, input.displayName, input.passwordHash ?? null, input.isAdmin ?? false, input.groups ?? []]
      );
      return mapUser(rows[0]);
    },
    /** Only ever succeeds for one caller: the first account is the administrator, and two people can open the setup page at once. */
    async createFirstAdmin(input: { email: string; displayName: string; passwordHash: string | null; groups?: readonly string[] | undefined }): Promise<User | null> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('pandocs:first-admin'))`);
        const { rows: existing } = await client.query(`SELECT 1 FROM pandocs.users LIMIT 1`);
        if (existing[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        const { rows } = await client.query(
          `INSERT INTO pandocs.users (email, display_name, password_hash, is_admin, groups) VALUES ($1, $2, $3, true, $4) RETURNING *`,
          [input.email, input.displayName, input.passwordHash, input.groups ?? []]
        );
        await client.query("COMMIT");
        return mapUser(rows[0]);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async hasIdentity(id: string): Promise<boolean> {
      const { rows } = await pool.query(`SELECT 1 FROM pandocs.user_identities WHERE user_id = $1 LIMIT 1`, [id]);
      return rows.length > 0;
    },
    async linkIdentity(issuer: string, subject: string, userId: string): Promise<void> {
      await pool.query(`INSERT INTO pandocs.user_identities (issuer, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [issuer, subject, userId]);
    },
    async recordLogin(id: string): Promise<void> {
      await pool.query(`UPDATE pandocs.users SET last_login_at = now() WHERE id = $1`, [id]);
    },
    /** What the identity provider says wins on every login, so leaving a group there takes effect here. */
    async syncFromProvider(id: string, patch: { displayName?: string | undefined; groups: readonly string[]; isAdmin?: boolean | undefined }): Promise<User> {
      const { rows } = await pool.query(
        `UPDATE pandocs.users SET display_name = COALESCE($2, display_name), groups = $3, is_admin = COALESCE($4, is_admin), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, patch.displayName ?? null, patch.groups, patch.isAdmin ?? null]
      );
      return mapUser(rows[0]);
    },
    async update(id: string, patch: { displayName?: string | undefined; isAdmin?: boolean | undefined; status?: User["status"] | undefined; passwordHash?: string | undefined }): Promise<User | null> {
      return one(
        `UPDATE pandocs.users SET display_name = COALESCE($2, display_name), is_admin = COALESCE($3, is_admin), status = COALESCE($4, status), password_hash = COALESCE($5, password_hash), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, patch.displayName ?? null, patch.isAdmin ?? null, patch.status ?? null, patch.passwordHash ?? null]
      );
    },
    /**
     * The same, for a change that takes away someone's administrator rights or their account, which never leaves the site
     * with nobody who can run it. Two people taking each other's rights at once would each see the other still there, so
     * they go one at a time.
     */
    async updateKeepingAnAdministrator(id: string, patch: { isAdmin?: boolean | undefined; status?: User["status"] | undefined; displayName?: string | undefined; passwordHash?: string | undefined }): Promise<User | null | "last-administrator"> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('pandocs.users.administrators'))`);
        const { rows: target } = await client.query<{ is_admin: boolean; status: string }>(`SELECT is_admin, status FROM pandocs.users WHERE id = $1`, [id]);
        const { rows: others } = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM pandocs.users WHERE is_admin AND status = 'active' AND id <> $1`, [id]);
        if (target[0]?.is_admin && target[0].status === "active" && others[0]!.count === 0) {
          await client.query("ROLLBACK");
          return "last-administrator";
        }
        const { rows } = await client.query(
          `UPDATE pandocs.users SET display_name = COALESCE($2, display_name), is_admin = COALESCE($3, is_admin), status = COALESCE($4, status), password_hash = COALESCE($5, password_hash), updated_at = now() WHERE id = $1 RETURNING *`,
          [id, patch.displayName ?? null, patch.isAdmin ?? null, patch.status ?? null, patch.passwordHash ?? null]
        );
        await client.query("COMMIT");
        return rows[0] ? mapUser(rows[0]) : null;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async list(query: string | undefined, limit = 200): Promise<User[]> {
      const pattern = query?.trim() ? `%${escapeLike(query.trim())}%` : null;
      const { rows } = await pool.query(
        `SELECT * FROM pandocs.users WHERE ($1::text IS NULL OR display_name ILIKE $1 OR email ILIKE $1) ORDER BY created_at LIMIT $2`,
        [pattern, limit]
      );
      return rows.map(mapUser);
    },
    // Anyone can look people up here, so an address only finds someone whole: a part of one, such as the company's
    // domain, would list everyone and say what their addresses look like.
    async search(query: string, limit: number): Promise<{ id: string; name: string }[]> {
      const keyword = query.trim();
      if (!keyword) return [];
      const pattern = `%${escapeLike(keyword)}%`;
      const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, display_name AS name FROM pandocs.users WHERE status = 'active' AND (display_name ILIKE $1 OR lower(email) = lower($3)) ORDER BY display_name LIMIT $2`,
        [pattern, limit, keyword]
      );
      return rows;
    },
    async names(ids: readonly string[]): Promise<{ id: string; name: string }[]> {
      const known = ids.filter(id => /^[0-9a-f-]{36}$/iu.test(id));
      if (known.length === 0) return [];
      const { rows } = await pool.query<{ id: string; name: string }>(`SELECT id, display_name AS name FROM pandocs.users WHERE id = ANY($1::uuid[])`, [known]);
      return rows;
    }
  };
}

export type UserStore = ReturnType<typeof createUserStore>;
