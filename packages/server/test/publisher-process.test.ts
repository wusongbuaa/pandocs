import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config.js";
import { startPublisherProcess } from "../src/publisher-process.js";

const BASE_ENV = { DATABASE_URL: "postgres://x", PANDOCS_URL: "http://x.test" };

describe("the publishing process", () => {
  let dir = "";
  const script = (code: string) => ["-e", code];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pandocs-process-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts with the role that says what it is for, and stops when told", async () => {
    const seen = join(dir, "seen");
    const running = startPublisherProcess({
      args: script(
        `require("fs").writeFileSync(${JSON.stringify(seen)}, process.env.PANDOCS_ROLES + "|" + process.env.OTHER); setInterval(() => {}, 1000);`
      ),
      env: { PATH: process.env.PATH, OTHER: "kept" },
      log: () => undefined
    });
    await vi.waitFor(() => expect(existsSync(seen)).toBe(true), { timeout: 5000, interval: 20 });
    expect(readFileSync(seen, "utf8")).toBe("publisher|kept");
    const { pid } = running;
    expect(pid).toBeGreaterThan(0);
    running.stop();
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 5000, interval: 20 });
  });

  it("comes back when it crashes, waiting longer each time", async () => {
    const events: Record<string, unknown>[] = [];
    const count = join(dir, "count");
    const running = startPublisherProcess({
      args: script(`const fs = require("fs"); fs.appendFileSync(${JSON.stringify(count)}, "x"); process.exit(1);`),
      env: { PATH: process.env.PATH },
      firstDelayMs: 10,
      log: event => events.push(event)
    });
    try {
      await vi.waitFor(() => expect(readFileSync(count, "utf8").length).toBeGreaterThanOrEqual(3), {
        timeout: 8000,
        interval: 20
      });
    } finally {
      running.stop();
    }
    const delays = events
      .filter(event => event.event === "publisher.process_exited")
      .map(event => event.restartInMs as number);
    expect(delays.slice(0, 2)).toEqual([20, 40]);
  });

  it("does not stay behind when the process that started it dies, or it would hold the lock", async () => {
    const pidFile = join(dir, "pid");
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require("child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(`
        require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        if (process.send) process.on("disconnect", () => process.exit(0));
        setInterval(() => {}, 1000);
      `)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      setInterval(() => {}, 1000);
    `
      ],
      { stdio: "ignore" }
    );
    await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0).toBe(true), {
      timeout: 5000,
      interval: 20
    });
    const child = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(child, 0)).not.toThrow();
    parent.kill("SIGKILL");
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 5000, interval: 20 });
  });
});

describe("the publisher role", () => {
  it("needs somewhere to publish to", () => {
    expect(() => readConfig({ ...BASE_ENV, PANDOCS_ROLES: "publisher" })).toThrow("PANDOCS_PUBLISH_DIR");
    const config = readConfig({
      ...BASE_ENV,
      PANDOCS_ROLES: "publisher",
      PANDOCS_PUBLISH_DIR: "/mnt/x",
      PANDOCS_PUBLISH_SPACES: "*"
    });
    expect([...config.roles]).toEqual(["publisher"]);
    expect(config.publish).toMatchObject({ dir: "/mnt/x", spaces: "*" });
  });

  it("has to be told which spaces, since anyone with the mount can read them", () => {
    expect(() => readConfig({ ...BASE_ENV, PANDOCS_PUBLISH_DIR: "/mnt/x" })).toThrow("PANDOCS_PUBLISH_SPACES");
    expect(
      readConfig({ ...BASE_ENV, PANDOCS_PUBLISH_DIR: "/mnt/x", PANDOCS_PUBLISH_SPACES: "a, b" }).publish?.spaces
    ).toEqual(["a", "b"]);
  });

  it("rejects a role it does not know", () => {
    expect(() => readConfig({ ...BASE_ENV, PANDOCS_ROLES: "web,nope" })).toThrow("unknown role");
  });
});
