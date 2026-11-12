import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";

/** Set `TEST_DATABASE_URL` to any server this role can create databases on. */
const SERVER_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";

/** A database of its own for each test file, so files can reset their schema without seeing each other. */
export function usePostgresFixture() {
  const name = `pandocs_test_${randomBytes(6).toString("hex")}`;
  const url = new URL(SERVER_URL);
  url.pathname = `/${name}`;
  const onAdminConnection = async (work: (client: pg.Client) => Promise<unknown>) => {
    const client = new pg.Client({ connectionString: SERVER_URL });
    await client.connect();
    try {
      await work(client);
    } finally {
      await client.end();
    }
  };
  beforeAll(() => onAdminConnection(client => client.query(`CREATE DATABASE ${name}`)));
  afterAll(() => onAdminConnection(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)));
  return { getConnectionString: () => url.toString() };
}
