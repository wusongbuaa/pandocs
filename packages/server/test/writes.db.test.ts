import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();

describe("writing through the server", () => {
  let server: TestServer;
  let admin: Client;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
  });
  afterAll(() => server.close());

  it("answers a save with the new revision, so the next save can follow it", async () => {
    const { document } = (
      await admin.json("POST", "/api/v1/spaces/handbook/documents", { title: "页面", markdown: "第一版\n" })
    ).data;
    const saved = await admin.json(
      "PUT",
      `/api/v1/documents/${document.id}/content`,
      { markdown: "第二版\n", expectedRevision: 1 },
      { "idempotency-key": "save-following-1" }
    );
    expect(saved.status).toBe(200);
    expect(saved.data.revision.no).toBe(2);
    const replay = await admin.json(
      "PUT",
      `/api/v1/documents/${document.id}/content`,
      { markdown: "第二版\n", expectedRevision: 1 },
      { "idempotency-key": "save-following-1" }
    );
    expect(replay.response.headers.get("idempotent-replay")).toBe("true");
    expect(replay.data.revision.no).toBe(2);
  });
});
