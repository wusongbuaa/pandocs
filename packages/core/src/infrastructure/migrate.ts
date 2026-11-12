import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SCHEMA_PATH = fileURLToPath(new URL("../../sql/schema.sql", import.meta.url));

/** Idempotent, and independent of the host's migration chain so the product can leave with its data. */
export async function applyPandocsSchema(connectionString: string): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, "utf8");
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

/** An environment that runs with a separate database user has to give it access to the new schema. */
export async function grantPandocsSchema(connectionString: string, quotedRole: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await pool.query(`GRANT USAGE ON SCHEMA pandocs TO ${quotedRole}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pandocs TO ${quotedRole}`);
    await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pandocs TO ${quotedRole}`);
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA pandocs GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quotedRole}`
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA pandocs GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${quotedRole}`
    );
  } finally {
    await pool.end();
  }
}
