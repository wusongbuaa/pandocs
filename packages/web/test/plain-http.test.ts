// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import { slugForNewPage } from "../src/data/paths";

/** What a browser leaves out on a page that is neither HTTPS nor localhost, such as a site on a local network. */
const onPlainHttp = () => vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });

afterEach(() => vi.unstubAllGlobals());

describe("a site on plain HTTP", () => {
  it("can still save, each time with a key of its own", async () => {
    onPlainHttp();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.send("PUT", "documents/a/content", { idempotent: true, body: {} });
    await api.send("PUT", "documents/a/content", { idempotent: true, body: {} });
    const keys = fetchMock.mock.calls.map(call => ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)["idempotency-key"]!);
    expect(keys[0]!.length).toBeGreaterThanOrEqual(8);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("can still make a short address for a new page", () => {
    onPlainHttp();
    expect(slugForNewPage("退货流程")).toMatch(/^[0-9a-f]{8}$/u);
    expect(slugForNewPage("Returns")).toBeUndefined();
  });

  it("is not relied on to have what only secure pages get", () => {
    const files = (directory: string): string[] => readdirSync(directory).flatMap(name => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/u.test(name) ? [path] : [];
    });
    const using = files(join(import.meta.dirname, "../src")).filter(path => /crypto\.(randomUUID|subtle)|navigator\.clipboard/u.test(readFileSync(path, "utf8")));
    expect(using).toEqual([]);
  });
});
