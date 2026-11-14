// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browserAsks = (...languages: string[]) => {
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  Object.defineProperty(navigator, "language", { configurable: true, value: languages[0] });
};

/** Which language a page gets is settled when it loads, so each of these is a fresh load. */
async function load(path = "/handbook/guide") {
  vi.resetModules();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://docs.example.com${path}`);
  return import("../src/i18n");
}

beforeEach(() => {
  // Node's own `localStorage` hides the test environment's, and needs a file to work.
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key)
  });
});

afterEach(() => {
  browserAsks("zh-CN");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.cookie = "pandocs_language=; Path=/; Max-Age=0";
  delete document.documentElement.dataset.language;
});

describe("the language of a page", () => {
  it("is what the browser asks for, and English when that is neither language", async () => {
    browserAsks("en-US");
    expect((await load()).language).toBe("en");
    browserAsks("zh-TW", "en");
    expect((await load()).language).toBe("zh");
    browserAsks("de-DE", "fr");
    expect((await load()).language).toBe("en");
  });

  it("follows the language in the address over the browser", async () => {
    browserAsks("en-US");
    expect((await load("/zh/handbook/guide")).language).toBe("zh");
    browserAsks("zh-CN");
    expect((await load("/en/handbook/guide")).language).toBe("en");
    // A language with no interface text of its own leaves the browser to decide.
    expect((await load("/ja/handbook/guide")).language).toBe("zh");
  });

  it("follows what someone picked over both, until they stop picking", async () => {
    browserAsks("zh-CN");
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    (await load("/zh/handbook/guide")).chooseLanguage("en");
    expect(reload).toHaveBeenCalledTimes(1);
    expect((await load("/zh/handbook/guide")).language).toBe("en");
    (await load("/zh/handbook/guide")).chooseLanguage(null);
    expect(reload).toHaveBeenCalledTimes(2);
    expect((await load("/handbook/guide")).language).toBe("zh");
  });

  it("starts out in the language the server rendered the page in, whatever this browser would ask for", async () => {
    browserAsks("en-US");
    document.documentElement.dataset.language = "zh";
    const { language, resolveLanguage } = await load("/handbook/guide");
    expect(language).toBe("zh");
    // What moving to another page goes by.
    expect(resolveLanguage()).toBe("en");
  });

  it("is what the page embedding it says, and stays that way after a reload", async () => {
    browserAsks("en-US");
    expect((await load("/embed/helpdesk/handbook/guide?lang=zh")).language).toBe("zh");
    expect((await load("/embed/helpdesk/handbook/guide")).language).toBe("zh");
  });
});

describe("in English", () => {
  it("shows the text as written, without loading any translation", async () => {
    browserAsks("en-US");
    const { t } = await load();
    expect(t("Save")).toBe("Save");
    expect(t("Permanently deleted {0} {0|page|pages}", 1)).toBe("Permanently deleted 1 page");
    expect(t("Permanently deleted {0} {0|page|pages}", 3)).toBe("Permanently deleted 3 pages");
  });

  it("reads times the same way", async () => {
    browserAsks("en-US");
    await load();
    const { relativeTime } = await import("../src/ui/time");
    const local = (month: number, day: number, hour: number, minute: number, year = 2026) =>
      new Date(year, month - 1, day, hour, minute).toISOString();
    const now = new Date(2026, 10, 6, 10, 0);
    expect(relativeTime(local(11, 6, 9, 59), now)).toBe("1 min ago");
    expect(relativeTime(local(11, 6, 0, 5), now)).toBe("today 00:05");
    expect(relativeTime(local(11, 5, 17, 42), now)).toBe("yesterday 17:42");
    expect(relativeTime(local(10, 1, 9, 0), now)).toBe("Oct 1 09:00");
    expect(relativeTime(local(10, 1, 9, 0, 2025), now)).toBe("Oct 1, 2025 09:00");
  });

  it("gives the theme its English too, including on a page whose content is in Chinese", async () => {
    browserAsks("en-US");
    await load();
    const { default: text } = await import("../src/virtual/i18n-text");
    expect(text.outlineTitle!.zh).toBe("ON THIS PAGE");
    expect(text.outlineTitle!.en).toBe("ON THIS PAGE");
    expect(text.outlineTitle!.ja).toBe("目次");
  });
});

describe("in Chinese", () => {
  it("gives the theme its Chinese, including on a page whose content is in English", async () => {
    browserAsks("zh-CN");
    await load();
    const { default: text } = await import("../src/virtual/i18n-text");
    expect(text.outlineTitle!.en).toBe("目录");
  });

  it("has the block names and samples the editor shows", async () => {
    browserAsks("zh-CN");
    const { loadMessages, t } = await load();
    await loadMessages();
    const { defaultBlockRegistry } = await import("@pandocs/markdown");
    expect(t(defaultBlockRegistry.get("tip")!.summary)).toBe("提示块（提示）");
    expect(t(defaultBlockRegistry.get("mindmap")!.summary)).toBe("脑图，用标题和列表写层级");
    expect(t(defaultBlockRegistry.get("mindmap")!.example)).toContain("分支一");
  });
});

describe("the first chunk", () => {
  it("looks up no text while it loads, because that runs before any translation can have arrived", async () => {
    vi.resetModules();
    const lookUp = vi.fn((message: string) => message);
    vi.doMock("@pandocs/i18n", async importOriginal => ({ ...(await importOriginal<object>()), t: lookUp }));
    try {
      await import("../src/api/client");
      await import("../src/data/bootstrap");
      expect(lookUp).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@pandocs/i18n");
    }
  });
});

describe("what goes to the server", () => {
  it("asks for answers in the language of the page, which may not be the browser's", async () => {
    browserAsks("en-US");
    document.cookie = "pandocs_language=zh; Path=/";
    vi.resetModules();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/api/client");
    await api.get("site");
    await api.send("POST", "x", { body: {} });
    const headers = fetchMock.mock.calls.map(
      call => ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)["accept-language"]
    );
    expect(headers).toEqual(["zh", "zh"]);
  });
});
