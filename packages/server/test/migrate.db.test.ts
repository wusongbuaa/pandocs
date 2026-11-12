import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { migrate, statementsOf } from "../src/migrate.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();

describe("starting a replica while others are serving", () => {
  let server: TestServer;
  let admin: Client;
  let starting: pg.Pool;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    starting = new pg.Pool({ connectionString: postgres.getConnectionString(), max: 2 });
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "Shop", defaultRole: "viewer" });
  });
  afterAll(async () => {
    await starting.end();
    await server.close();
  });

  /** People saving pages throughout, and how each of their saves went. */
  const whileSaving = async (prefix: string, work: () => Promise<void>) => {
    const outcomes = new Map<string, number>();
    let running = true;
    const saving = async (slug: string) => {
      const { data } = await admin.json("POST", "/api/v1/spaces/shop/documents", {
        title: slug,
        slug,
        markdown: "first\n"
      });
      const id = data.document.id as string;
      let revision = data.revision.no as number;
      while (running) {
        const saved = await admin.json(
          "PUT",
          `/api/v1/documents/${id}/content`,
          { markdown: `round ${revision}\n`, expectedRevision: revision },
          { "idempotency-key": randomUUID() }
        );
        const key = String(saved.status);
        outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
        if (saved.status === 200) revision = saved.data.revision.no as number;
      }
    };
    const writers = ["a", "b", "c", "d"].map(name => saving(`${prefix}-${name}`));
    try {
      await work();
    } finally {
      running = false;
      await Promise.all(writers);
    }
    return outcomes;
  };

  it("does not get in the way of anyone saving", async () => {
    const outcomes = await whileSaving("restart", async () => {
      for (let start = 0; start < 40; start += 1) await migrate(starting);
    });
    expect([...outcomes.keys()]).toEqual(["200"]);
  }, 120_000);

  it("leaves the tables alone when the schema has not changed", async () => {
    const reading = await starting.connect();
    try {
      await reading.query("BEGIN");
      await reading.query("LOCK TABLE pandocs.spaces, pandocs.documents IN ACCESS EXCLUSIVE MODE");
      // With those held, anything wanting them would never finish.
      await migrate(server.pool);
    } finally {
      await reading.query("ROLLBACK");
      reading.release();
    }
  }, 20_000);

  it("gives way to people saving when the schema has changed, and nobody's save is lost to it", async () => {
    const outcomes = await whileSaving("change", async () => {
      for (let release = 0; release < 25; release += 1) {
        await starting.query("DELETE FROM pandocs.applied_schemas");
        await migrate(starting);
      }
    });
    expect([...outcomes.keys()]).toEqual(["200"]);
  }, 120_000);

  it("waits for a table that stays busy, then gets on with it", async () => {
    await starting.query("DELETE FROM pandocs.applied_schemas");
    const busy = await starting.connect();
    await busy.query("BEGIN");
    await busy.query("SELECT 1 FROM pandocs.documents LIMIT 1");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const applied = migrate(server.pool);
    await vi.waitFor(() => expect(warned).toHaveBeenCalled(), { timeout: 10_000 });
    await busy.query("ROLLBACK");
    busy.release();
    await applied;
    warned.mockRestore();
    expect((await server.pool.query("SELECT 1 FROM pandocs.applied_schemas")).rowCount).toBe(1);
  }, 30_000);
});

describe("splitting a schema into statements", () => {
  it("only splits where a statement really ends", () => {
    const sql = [
      "-- a comment; with a semicolon",
      "CREATE TABLE a (b text DEFAULT 'one; two', c text DEFAULT 'it''s; fine');",
      '/* more; of them */ CREATE TABLE "odd;name" (d int);',
      "CREATE FUNCTION e() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;",
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;",
      "-- nothing after this"
    ].join("\n");
    const statements = statementsOf(sql);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain("'it''s; fine');");
    expect(statements[1]).toContain('"odd;name" (d int);');
    expect(statements[2]).toContain("RETURN NEW; END; $$ LANGUAGE plpgsql;");
    expect(statements[3]).toMatch(/^CREATE FUNCTION f.*sql;$/u);
  });

  it("keeps a last statement with nothing to end it, rather than losing it", () => {
    expect(statementsOf("SELECT 1; SELECT 2")).toEqual(["SELECT 1;", "SELECT 2"]);
  });
});
