// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";

describe("an answer that arrives a piece at a time", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips a piece it cannot read and keeps the rest", async () => {
    const frames = ['data: {"text":"one"}\n\n', "data: {broken\n\n", 'data: {"text":"two"}\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }))
    );
    const seen: unknown[] = [];
    await api.stream("ask", {}, event => seen.push(event), new AbortController().signal);
    expect(seen).toEqual([{ text: "one" }, { text: "two" }]);
  });
});
