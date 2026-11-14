import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** Bundled builds carry both files next to the entry point; from source they stay in their packages. */
function sqlOf(name: "schema.sql" | "auth.sql"): string {
  const bundled = fileURLToPath(new URL(`./sql/${name}`, import.meta.url));
  if (existsSync(bundled)) return readFileSync(bundled, "utf8");
  const source = name === "schema.sql" ? "../../core/sql/schema.sql" : "../sql/auth.sql";
  return readFileSync(fileURLToPath(new URL(source, import.meta.url)), "utf8");
}

/** Shorter than PostgreSQL's `deadlock_timeout` of a second, so a statement stuck behind requests gives way before anything gets killed. */
const LOCK_WITHIN = "200ms";
const ATTEMPTS = 60;
const LONGEST_PAUSE_MS = 3000;
const LOCK_NOT_AVAILABLE = "55P03";
const DEADLOCK_DETECTED = "40P01";

const wasApplied = async (database: pg.Pool | pg.PoolClient, version: string) => {
  const { rows } = await database.query(`SELECT to_regclass('pandocs.applied_schemas') IS NOT NULL AS known`);
  if (!rows[0].known) return false;
  return (await database.query(`SELECT 1 FROM pandocs.applied_schemas WHERE version = $1`, [version])).rowCount === 1;
};

/** A statement ends at a `;` that is not in a comment, a string or a function body. */
export function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  for (const match of sql.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$\w*\$)[\s\S]*?\1|;/gu)) {
    if (match[0] !== ";") continue;
    statements.push(sql.slice(start, match.index + 1).trim());
    start = match.index + 1;
  }
  const rest = sql.slice(start).trim();
  if (rest.replace(/--[^\n]*/gu, "").trim()) statements.push(rest);
  return statements;
}

async function runGivingWay(client: pg.PoolClient, statement: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.query(statement);
      return;
    } catch (error) {
      const { code } = error as { code?: string };
      if ((code !== LOCK_NOT_AVAILABLE && code !== DEADLOCK_DETECTED) || attempt === ATTEMPTS) throw error;
      console.warn(JSON.stringify({ event: "db.schema_waiting", attempt, statement: statement.slice(0, 80) }));
      await new Promise(done =>
        setTimeout(done, Math.min(LONGEST_PAUSE_MS, 50 * 2 ** attempt) * (0.5 + Math.random() / 2))
      );
    }
  }
}

/**
 * One statement at a time, so that nothing holds one table while it waits for another, which is how a request and this
 * could end up waiting on each other until PostgreSQL kills one. Every statement can be repeated, so stopping part way
 * leaves nothing broken, and whichever replica starts next carries on.
 */
async function apply(client: pg.PoolClient, sql: string, version: string): Promise<void> {
  await client.query(`SET lock_timeout = '${LOCK_WITHIN}'`);
  try {
    for (const statement of statementsOf(sql)) await runGivingWay(client, statement);
    await client.query(`INSERT INTO pandocs.applied_schemas (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [
      version
    ]);
  } finally {
    await client.query("RESET lock_timeout").catch(() => undefined);
  }
}

/**
 * Every replica comes through here when it starts, usually with nothing to do. Doing it anyway would lock tables under
 * people's requests on every restart, because even `ALTER TABLE ... IF NOT EXISTS` takes its lock before looking.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  const sql = `${sqlOf("schema.sql")}\n${sqlOf("auth.sql")}`;
  const version = createHash("sha256").update(sql).digest("hex");
  if (await wasApplied(pool, version)) return;
  const client = await pool.connect();
  try {
    // Replicas starting together would race on `CREATE TABLE IF NOT EXISTS`, so one runs it while the others wait.
    await client.query(`SELECT pg_advisory_lock(hashtext('pandocs:migrate'))`);
    if (!(await wasApplied(client, version))) await apply(client, sql, version);
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('pandocs:migrate'))`).catch(() => undefined);
    client.release();
  }
}

/** Whichever replica gets here first writes it; the others read the same value. */
export async function loadSigningSecret(pool: pg.Pool): Promise<string> {
  await pool.query(
    `INSERT INTO pandocs.server_secrets (name, value) VALUES ('login-state', $1) ON CONFLICT (name) DO NOTHING`,
    [randomBytes(32).toString("hex")]
  );
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM pandocs.server_secrets WHERE name = 'login-state'`
  );
  return rows[0]!.value;
}
