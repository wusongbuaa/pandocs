// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followDocument, type LiveChange } from "../src/data/live";

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }
  addEventListener(name: string, listener: (event: Event) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, lastEventId: string, data: unknown = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { lastEventId, data: JSON.stringify(data) }));
  }
}

const setVisibility = (state: DocumentVisibilityState) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("following a page", () => {
  const latest = () => FakeEventSource.opened.at(-1)!;

  beforeEach(() => {
    FakeEventSource.opened = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hears what happens to the page, and asks for that page only", () => {
    const heard: (LiveChange | null)[] = [];
    const stop = followDocument("doc-1", change => heard.push(change));
    expect(latest().url).toBe("/api/v1/events?document=doc-1");
    latest().emit("change", "1.2", { kind: "discussion", revision: 3, deleted: false });
    expect(heard).toEqual([{ kind: "discussion", revision: 3, deleted: false }]);
    stop();
    expect(latest().closed).toBe(true);
  });

  it("holds no connection in the background, and comes back from where it was", () => {
    const stop = followDocument("doc-1", () => undefined);
    const first = latest();
    first.emit("ready", "1.5");
    setVisibility("hidden");
    expect(first.closed).toBe(true);
    expect(FakeEventSource.opened).toHaveLength(1);

    setVisibility("visible");
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(latest().url).toBe("/api/v1/events?document=doc-1&since=1.5");
    latest().emit("change", "1.9", { kind: "document", revision: 4, deleted: false });
    setVisibility("hidden");
    setVisibility("visible");
    expect(latest().url).toBe("/api/v1/events?document=doc-1&since=1.9");
    stop();
  });

  it("does not connect at all from a tab that opens in the background, until it shows", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const stop = followDocument("doc-1", () => undefined);
    expect(FakeEventSource.opened).toHaveLength(0);
    setVisibility("visible");
    expect(FakeEventSource.opened).toHaveLength(1);
    stop();
    setVisibility("hidden");
    setVisibility("visible");
    expect(FakeEventSource.opened).toHaveLength(1);
  });

  it("says to look again when too much went by to list", () => {
    const heard: (LiveChange | null)[] = [];
    const stop = followDocument("doc-1", change => heard.push(change));
    latest().emit("reset", "");
    expect(heard).toEqual([null]);
    stop();
  });

  it("leaves the page working where browsers have no live connection", () => {
    vi.stubGlobal("EventSource", undefined);
    const stop = followDocument("doc-1", () => undefined);
    stop();
    expect(FakeEventSource.opened).toHaveLength(0);
  });
});
