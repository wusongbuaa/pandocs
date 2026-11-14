import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { createChangeListener, createPublisher, runPublisher } from "../src/app.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const SPACE = "shop";
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  )
);

describe("publishing spaces to a shared directory", () => {
  let server: TestServer;
  let admin: Client;
  let dir: string;
  let spaceNumber = 0;
  let space = SPACE;

  const publisher = (spaces: readonly string[] | "*" = [space], packIntervalMs = 0) =>
    createPublisher({ services: server.runtime.services, dir, spaces, packIntervalMs, log: () => undefined });
  const at = (...parts: string[]) => join(dir, space, ...parts);
  const read = (...parts: string[]) => readFileSync(at(...parts), "utf8");
  const manifest = () =>
    JSON.parse(read(".pandocs/MANIFEST.json")) as {
      cursor: string;
      files: { path: string; sha256: string; title?: string }[];
    };
  const create = async (slug: string, markdown = `${slug} 的内容\n`, extra: object = {}) => {
    const result = await admin.json("POST", `/api/v1/spaces/${space}/documents`, {
      title: slug,
      slug,
      markdown,
      ...extra
    });
    expect(result.status).toBe(201);
    return result.data.document as { id: string; path: string };
  };
  const save = (id: string, markdown: string, expectedRevision: number) =>
    admin.json(
      "PUT",
      `/api/v1/documents/${id}/content`,
      { markdown, expectedRevision },
      { "idempotency-key": crypto.randomUUID() }
    );

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
  });
  afterAll(() => server.close());
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pandocs-publish-"));
    space = `${SPACE}${(spaceNumber += 1)}`;
    expect(
      (await admin.json("POST", "/api/v1/spaces", { slug: space, name: "书店", defaultRole: "viewer" })).status
    ).toBe(201);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes pages as files, with what readers need to find their way around", async () => {
    await create("开始");
    await create("子页", "子页的内容\n", { parentPath: "开始" });
    const upload = await admin.request(`/api/v1/spaces/${space}/assets?filename=a.png`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    });
    const image = ((await upload.json()) as { data: { path: string } }).data.path;
    await create("有图", `![图](${image})\n`);

    expect(await publisher().publish(space)).toMatchObject({ written: 4, removed: 0 });
    expect(read("开始.md")).toBe("开始 的内容\n");
    expect(read("开始/子页.md")).toBe("子页的内容\n");
    expect(new Uint8Array(readFileSync(at(image)))).toEqual(PNG);
    expect(manifest().files.map(file => file.path)).toEqual(["开始.md", "开始/子页.md", "有图.md", image]);
    expect(read("llms.txt")).toContain("- [子页](开始/子页.md)");
    expect(read(".pandocs/README.md")).toContain("Do not write here");
    const current = JSON.parse(read(".pandocs/CURRENT"));
    expect(current).toMatchObject({ cursor: manifest().cursor, files: 4 });
    expect(
      read(".pandocs/CHANGES.ndjson")
        .trim()
        .split("\n")
        .map(line => JSON.parse(line).path)
    ).toContain("开始.md");
    expect(readdirSync(at()).filter(name => name.startsWith(".tmp"))).toEqual([]);
  });

  it("has a pack that ordinary tools can unpack, with its own manifest", async () => {
    await create("一页");
    await publisher().publish(space);
    const out = mkdtempSync(join(tmpdir(), "pandocs-pack-"));
    try {
      const unpacked = spawnSync("tar", ["-xzf", at(".pandocs/pack.tar.gz"), "-C", out]);
      expect(unpacked.stderr.toString()).toBe("");
      expect(readFileSync(join(out, "一页.md"), "utf8")).toBe("一页 的内容\n");
      expect(
        JSON.parse(readFileSync(join(out, ".pandocs/MANIFEST.json"), "utf8")).files.map(
          (file: { path: string }) => file.path
        )
      ).toEqual(["一页.md"]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("replaces only what changed, and someone reading the old file keeps a whole old file", async () => {
    const changed = await create("会变");
    await create("不变");
    const round = publisher();
    await round.publish(space);
    const untouched = statSync(at("不变.md")).ino;
    const reader = await open(at("会变.md"), "r");
    try {
      await save(changed.id, "新的内容\n", 1);
      expect(await round.publish(space)).toMatchObject({ written: 1, removed: 0 });
      expect(read("会变.md")).toBe("新的内容\n");
      expect(statSync(at("不变.md")).ino).toBe(untouched);
      expect(await reader.readFile("utf8")).toBe("会变 的内容\n");
    } finally {
      await reader.close();
    }
    expect(read(".pandocs/CHANGES.ndjson").trim().split("\n").at(-1)).toContain("会变.md");
  });

  it("does nothing at all when nothing changed", async () => {
    await create("一页");
    const round = publisher();
    await round.publish(space);
    const before = readFileSync(at(".pandocs/CURRENT"));
    // A wake-up can still be finishing what the commit started, and that is not what this is about.
    let stamp = 0;
    await expect
      .poll(
        async () => {
          const before = statSync(at(".pandocs/CURRENT")).mtimeMs;
          await new Promise(done => setTimeout(done, 400));
          stamp = statSync(at(".pandocs/CURRENT")).mtimeMs;
          return stamp === before;
        },
        { timeout: 10_000 }
      )
      .toBe(true);
    expect(await round.publish(space)).toMatchObject({ written: 0, removed: 0 });
    expect(readFileSync(at(".pandocs/CURRENT"))).toEqual(before);
    expect(statSync(at(".pandocs/CURRENT")).mtimeMs).toBe(stamp);
  });

  it("follows a new title, even though no file changed", async () => {
    const page = await create("原名");
    const round = publisher();
    await round.publish(space);
    expect((await admin.json("PATCH", `/api/v1/documents/${page.id}`, { title: "新标题" })).status).toBe(200);
    await round.publish(space);
    expect(manifest().files[0]!.title).toBe("新标题");
    expect(read("llms.txt")).toContain("[新标题]");
  });

  it("removes deleted pages and the folders they leave empty, and moves moved ones", async () => {
    const parent = await create("上级");
    const child = await create("下级", "下级的内容\n", { parentPath: "上级" });
    const moved = await create("要搬");
    const round = publisher();
    await round.publish(space);

    expect((await admin.json("DELETE", `/api/v1/documents/${child.id}`)).status).toBe(200);
    expect((await admin.json("POST", `/api/v1/documents/${moved.id}/move`, { slug: "搬好了" })).status).toBe(200);
    expect(await round.publish(space)).toMatchObject({ written: 1, removed: 2 });
    expect(existsSync(at("上级"))).toBe(false);
    expect(existsSync(at("上级.md"))).toBe(true);
    expect(existsSync(at("要搬.md"))).toBe(false);
    expect(read("搬好了.md")).toBe("要搬 的内容\n");
    expect(manifest().files.map(file => file.path)).toEqual(["上级.md", "搬好了.md"]);
    expect(parent.path).toBe("上级");
  });

  it("never writes restricted pages or their images, and takes a page away when it becomes restricted", async () => {
    const upload = await admin.request(`/api/v1/spaces/${space}/assets?filename=s.png`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    });
    const image = ((await upload.json()) as { data: { path: string } }).data.path;
    await create("受限", `秘密 ![图](${image})\n`, { restricted: true });
    const later = await create("后来才受限");
    const round = publisher();
    await round.publish(space);
    expect(existsSync(at("受限.md"))).toBe(false);
    expect(existsSync(at(image))).toBe(false);
    expect(read("llms.txt")).not.toContain("[受限]");
    expect(existsSync(at("后来才受限.md"))).toBe(true);

    expect((await admin.json("PATCH", `/api/v1/documents/${later.id}`, { restricted: true })).status).toBe(200);
    await round.publish(space);
    expect(existsSync(at("后来才受限.md"))).toBe(false);
    expect(manifest().files).toEqual([]);
  });

  it("does not write outside its directory, even if a bad path got into the database", async () => {
    const page = await create("正常");
    await server.pool.query(`UPDATE pandocs.documents SET path = '../逃出去' WHERE id = $1`, [page.id]);
    await publisher().publish(space);
    expect(existsSync(join(dir, "逃出去.md"))).toBe(false);
    await server.pool.query(`UPDATE pandocs.documents SET path = '.pandocs/README' WHERE id = $1`, [page.id]);
    await publisher().publish(space);
    expect(read(".pandocs/README.md")).toContain("Do not write here");
  });

  describe("recovering", () => {
    it("rebuilds a directory that was wiped", async () => {
      await create("一页");
      const round = publisher();
      await round.publish(space);
      rmSync(at(), { recursive: true });
      await round.publish(space);
      expect(read("一页.md")).toBe("一页 的内容\n");
    });

    it("on a full check, brings back what went missing and clears what a crash left", async () => {
      await create("丢了");
      await create("还在", "还在的内容\n", {});
      const round = publisher();
      await round.publish(space);
      rmSync(at("丢了.md"));
      writeFileSync(at(".tmp-abc123"), "half");
      mkdirSync(at("多余"));
      writeFileSync(at("多余/文件.md"), "不该在这");
      writeFileSync(at(".pandocs/.tmp-def456"), "half");

      expect(await round.publish(space)).toMatchObject({ written: 0 });
      expect(existsSync(at("丢了.md"))).toBe(false);

      expect(await round.publish(space, { verify: true })).toMatchObject({ written: 1 });
      expect(read("丢了.md")).toBe("丢了 的内容\n");
      expect(existsSync(at(".tmp-abc123"))).toBe(false);
      expect(existsSync(at("多余"))).toBe(false);
      expect(existsSync(at(".pandocs/.tmp-def456"))).toBe(false);
      expect(existsSync(at(".pandocs/pack.tar.gz"))).toBe(true);
    });

    it("puts back a file someone wrote over, the next time it looks at the files", async () => {
      await create("改了");
      await create("没改");
      const round = publisher();
      await round.publish(space, { verify: true });
      writeFileSync(at("改了.md"), "改了 的内容\n被别人改过\n");
      expect(await round.publish(space)).toMatchObject({ written: 0 });
      expect(await round.publish(space, { verify: true })).toMatchObject({ written: 1 });
      expect(read("改了.md")).toBe("改了 的内容\n");
      expect(read("没改.md")).toBe("没改 的内容\n");
      expect(await round.publish(space, { verify: true })).toMatchObject({ written: 0 });
    });

    it("leaves alone a directory it did not make", async () => {
      await create("一页");
      mkdirSync(at());
      writeFileSync(at("别人的文件.txt"), "别动");
      const other = join(dir, "另一个目录");
      mkdirSync(other);
      writeFileSync(join(other, "文件.txt"), "别动");
      await publisher().publishAll({ verify: true });
      expect(read("别人的文件.txt")).toBe("别动");
      expect(read("一页.md")).toBe("一页 的内容\n");
      expect(readFileSync(join(other, "文件.txt"), "utf8")).toBe("别动");
    });

    it("removes a space that was deleted or taken off the list, and no other", async () => {
      await create("一页");
      const removed = space;
      const kept = `${SPACE}${(spaceNumber += 1)}`;
      await admin.json("POST", "/api/v1/spaces", { slug: kept, name: "留下", defaultRole: "viewer" });
      await admin.json("POST", `/api/v1/spaces/${kept}/documents`, { title: "留下", slug: "留下", markdown: "留下\n" });
      const all = publisher("*");
      await all.publishAll();
      expect(existsSync(join(dir, removed, "一页.md"))).toBe(true);
      expect(existsSync(join(dir, kept, "留下.md"))).toBe(true);

      // Taken off the list: a copy anyone with the mount can read has to go when someone decides so.
      await publisher([kept]).publishAll();
      expect(existsSync(join(dir, removed))).toBe(false);
      expect(existsSync(join(dir, kept, "留下.md"))).toBe(true);

      await publisher("*").publishAll();
      expect(existsSync(join(dir, removed, "一页.md"))).toBe(true);
      expect((await admin.json("DELETE", `/api/v1/spaces/${removed}`)).status).toBe(200);
      await publisher("*").publishAll();
      expect(existsSync(join(dir, removed))).toBe(false);
      expect(existsSync(join(dir, kept, "留下.md"))).toBe(true);
    });
  });

  it("writes a new pack only when one is due", async () => {
    const page = await create("一页");
    const round = publisher([space], 60_000);
    await round.publish(space);
    const first = readFileSync(at(".pandocs/pack.tar.gz"));
    await save(page.id, "改过\n", 1);
    await round.publish(space);
    expect(read("一页.md")).toBe("改过\n");
    expect(readFileSync(at(".pandocs/pack.tar.gz"))).toEqual(first);
  });

  describe("running on its own", () => {
    const connection = () => postgres.getConnectionString();

    it("wakes on a commit and has the file there about a second later", async () => {
      await create("跟着变");
      const page = (await admin.json("GET", `/api/v1/spaces/${space}/resolve?path=跟着变`)).data;
      const runner = runPublisher({
        connectionString: connection(),
        services: server.runtime.services,
        publisher: publisher("*"),
        debounceMs: 10,
        leadRetryMs: 0
      });
      const listener = createChangeListener(connection(), runner.wake, { fallbackMs: 3_600_000 });
      try {
        await vi.waitFor(() => expect(read("跟着变.md")).toBe("跟着变 的内容\n"), { timeout: 10_000, interval: 50 });
        const saved = Date.now();
        await save(page.id, "第二版\n", 1);
        await vi.waitFor(() => expect(read("跟着变.md")).toBe("第二版\n"), { timeout: 5000, interval: 20 });
        expect(Date.now() - saved).toBeLessThan(2000);
        // Discussions never touch the files, and do not make it work for nothing.
        const stamp = statSync(at(".pandocs/CURRENT")).mtimeMs;
        await admin.json("POST", `/api/v1/documents/${page.id}/threads`, {
          anchor: { kind: "document" },
          body: "看一下"
        });
        await new Promise(done => setTimeout(done, 300));
        expect(statSync(at(".pandocs/CURRENT")).mtimeMs).toBe(stamp);
      } finally {
        listener.stop();
        runner.stop();
      }
    });

    it("lets one replica work, and the next take over when it goes", async () => {
      await create("一页");
      const secondDir = mkdtempSync(join(tmpdir(), "pandocs-publish-"));
      const first = runPublisher({
        connectionString: connection(),
        services: server.runtime.services,
        publisher: publisher("*"),
        leadRetryMs: 0
      });
      const second = runPublisher({
        connectionString: connection(),
        services: server.runtime.services,
        publisher: createPublisher({
          services: server.runtime.services,
          dir: secondDir,
          spaces: "*",
          log: () => undefined
        }),
        leadRetryMs: 0
      });
      try {
        await first.settle();
        expect(first.leading).toBe(true);
        await second.settle();
        expect(second.leading).toBe(false);
        expect(existsSync(at("一页.md"))).toBe(true);
        expect(existsSync(join(secondDir, space, "一页.md"))).toBe(false);

        first.stop();
        await vi.waitFor(
          async () => {
            await second.settle();
            expect(second.leading).toBe(true);
          },
          { timeout: 5000, interval: 50 }
        );
        // Whoever takes over compares everything, because no one was watching in between.
        await vi.waitFor(() => expect(existsSync(join(secondDir, space, "一页.md"))).toBe(true), {
          timeout: 5000,
          interval: 50
        });
      } finally {
        first.stop();
        second.stop();
        rmSync(secondDir, { recursive: true, force: true });
      }
    });

    it("tries again after a round fails", async () => {
      const page = await create("一页");
      const blocked = join(dir, "not-a-directory");
      writeFileSync(blocked, "这是个文件，写不进去");
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const runner = runPublisher({
        connectionString: connection(),
        services: server.runtime.services,
        publisher: createPublisher({
          services: server.runtime.services,
          dir: blocked,
          spaces: "*",
          log: () => undefined
        }),
        leadRetryMs: 0
      });
      try {
        await runner.settle();
        expect(logged.mock.calls.some(([line]) => String(line).includes("publisher.round_failed"))).toBe(true);
        expect(page.path).toBe("一页");
      } finally {
        runner.stop();
        logged.mockRestore();
      }
    });
  });
});

describe("the wake-up from the database", () => {
  const connection = () => postgres.getConnectionString();
  let server: TestServer;
  let admin: Client;
  beforeAll(async () => {
    server = await startServer(connection());
    admin = await signInFirstAdmin(server).catch(() => server.client());
  });
  afterAll(() => server.close());

  it("comes back after losing its connection", async () => {
    let wakes = 0;
    const listener = createChangeListener(
      connection(),
      () => {
        wakes += 1;
      },
      { fallbackMs: 3_600_000, reconnectMs: 20 }
    );
    try {
      await vi.waitFor(() => expect(wakes).toBeGreaterThan(0), { timeout: 5000, interval: 20 });
      const { rows } = await server.pool.query<{ killed: boolean }>(
        `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE query = 'LISTEN pandocs_changes' AND pid <> pg_backend_pid()`
      );
      expect(rows.length).toBeGreaterThan(0);
      await new Promise(done => setTimeout(done, 200));
      const before = wakes;
      await server.pool.query(`SELECT pg_notify('pandocs_changes', 'test')`);
      await vi.waitFor(() => expect(wakes).toBeGreaterThan(before), { timeout: 5000, interval: 20 });
    } finally {
      listener.stop();
    }
    expect(admin).toBeTruthy();
  });

  it("looks for itself now and then, in case a notification never came", async () => {
    let wakes = 0;
    const listener = createChangeListener(
      connection(),
      () => {
        wakes += 1;
      },
      { fallbackMs: 30 }
    );
    try {
      await vi.waitFor(() => expect(wakes).toBeGreaterThan(3), { timeout: 5000, interval: 20 });
    } finally {
      listener.stop();
    }
  });
});
