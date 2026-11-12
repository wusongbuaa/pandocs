import type pg from "pg";
import { fromDatabase } from "../domain/errors.js";

export interface Queryable {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PandocsDb extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function createPandocsDb(pool: pg.Pool): PandocsDb {
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client as Queryable);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        // Checked first and then written, an address can still be taken by someone else in between.
        throw fromDatabase(error);
      } finally {
        client.release();
      }
    }
  };
}
