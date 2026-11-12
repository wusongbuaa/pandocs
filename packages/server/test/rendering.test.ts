import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANONYMOUS_PRINCIPAL } from "@pandocs/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { absoluteLinks } from "../src/web/discovery.js";
import { prefersMarkdown } from "../src/web/pages.js";
import { createRenderPool, type RenderedPage, type RenderInput, type RenderPool } from "../src/web/render-pool.js";
import { assemblePage, createPageRendering, languageOfPage, locatePage } from "../src/web/rendering.js";
import { createStaticFiles } from "../src/web/static.js";

const tree = (...paths: string[]) => paths.map(path => ({ id: `id:${path}`, path }));
const SITE = { defaultLang: "zh", locales: [{ lang: "zh" }, { lang: "en" }] };
const list = {
  site: SITE,
  spaces: [
    { slug: "guide", tree: tree("start", "a/b", "中文页") },
    { slug: "home", tree: tree("index", "more") }
  ]
};

describe("which page an address is", () => {
  it("finds a document, in the language of its address", () => {
    expect(locatePage(list, "/guide/start")).toEqual({ kind: "document", id: "id:start", lang: null });
    expect(locatePage(list, "/guide/a/b")).toEqual({ kind: "document", id: "id:a/b", lang: null });
    expect(locatePage(list, "/en/guide/start")).toEqual({ kind: "document", id: "id:start", lang: "en" });
    expect(locatePage(list, "/guide/%E4%B8%AD%E6%96%87%E9%A1%B5")).toEqual({
      kind: "document",
      id: "id:中文页",
      lang: null
    });
    expect(locatePage(list, "/home/")).toEqual({ kind: "document", id: "id:index", lang: null });
  });

  it("leads the other ways of writing an address to the one a page has", () => {
    for (const [from, to] of [
      ["/guide/start/", "/guide/start"],
      ["/GUIDE/Start", "/guide/start"],
      ["/guide/start.html", "/guide/start"],
      ["/en/guide/start/", "/en/guide/start"],
      ["/home", "/home/"],
      ["/home/index", "/home/"],
      ["/guide", "/guide/"],
      ["/en", "/en/"],
      ["/guide/%E4%B8%AD%E6%96%87%E9%A1%B5/", "/guide/%E4%B8%AD%E6%96%87%E9%A1%B5"]
    ] as const)
      expect(locatePage(list, from), from).toEqual({ kind: "elsewhere", to, permanent: true });
  });

  it("does not lead an address in its one form anywhere, in any way of encoding it", () => {
    expect(locatePage(list, "/guide/%e4%b8%ad%e6%96%87%e9%a1%b5").kind).toBe("document");
    expect(locatePage(list, "/guide/").kind).toBe("other");
    expect(locatePage(list, "/en/").kind).toBe("other");
  });

  it("leads an address spelling out the site's own language to the one without it", () => {
    expect(locatePage(list, "/zh/guide/start")).toEqual({ kind: "elsewhere", to: "/guide/start", permanent: true });
    expect(locatePage(list, "/zh")).toEqual({ kind: "elsewhere", to: "/", permanent: true });
  });

  it("goes into the one space of a site, for now rather than for good", () => {
    expect(locatePage({ site: SITE, spaces: [list.spaces[0]!] }, "/")).toEqual({
      kind: "elsewhere",
      to: "/guide/",
      permanent: false
    });
    expect(locatePage(list, "/")).toEqual({ kind: "other" });
  });

  it("takes an address with a stray percent sign for one that leads nowhere, rather than failing", () => {
    expect(locatePage(list, "/guide/discount-50%").kind).toBe("unknown");
    expect(locatePage(list, "/guide/%E4%B8%AD%").kind).toBe("unknown");
  });

  it("knows a page that may have moved from one that was never there", () => {
    expect(locatePage(list, "/en/guide/gone/page")).toEqual({
      kind: "unknown",
      space: "guide",
      path: "gone/page",
      prefix: "/en"
    });
    expect(locatePage(list, "/nothing/here")).toEqual({ kind: "unknown", space: null, path: "here", prefix: "" });
    expect(locatePage(list, "/_/account")).toEqual({ kind: "other" });
    expect(locatePage(list, "/en/_/account")).toEqual({ kind: "other" });
  });
});

describe("the language of a page", () => {
  const ask = (headers: Record<string, string>, path = "/guide/start", site = "zh") =>
    languageOfPage(new Request(`http://x${path}`, { headers }), path, async () => site);

  it("is what someone chose, then the address, then what they ask for", async () => {
    expect(await ask({ cookie: "a=1; pandocs_language=en", "accept-language": "zh" }, "/zh/guide")).toBe("en");
    expect(await ask({ "accept-language": "en" }, "/zh/guide")).toBe("zh");
    expect(await ask({ "accept-language": "en-US,en;q=0.9" })).toBe("en");
    expect(await ask({ "accept-language": "de" })).toBe("en");
  });

  it("is what the site is written in for something asking for nothing, such as a search engine", async () => {
    expect(await ask({})).toBe("zh");
    expect(await ask({}, "/guide/start", "en")).toBe("en");
    expect(await ask({}, "/guide/start", "fr")).toBe("en");
    expect(await ask({ cookie: "pandocs_language=fr" })).toBe("zh");
  });
});

describe("the links in a page's Markdown", () => {
  const page = "https://docs.example/guide/start";
  const rewritten = (markdown: string) =>
    absoluteLinks(markdown, page, "https://docs.example/api/v1/spaces/guide/assets");

  it("says in full where the files blocks stand for are, and leaves the rest of the line alone", () => {
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(rewritten(`::openapi{src="assets/${hash}.yaml"}`)).toBe(
      `::openapi{src="https://docs.example/api/v1/spaces/guide/assets/${hash}"}`
    );
    expect(rewritten(`::file[The src="x" file]{src="assets/${hash}.pdf"}`)).toContain(
      `{src="https://docs.example/api/v1/spaces/guide/assets/${hash}"}`
    );
    expect(rewritten(`::compare[Caption]{before="assets/${hash}.png" after="https://elsewhere.example/b.png"}`)).toBe(
      `::compare[Caption]{before="https://docs.example/api/v1/spaces/guide/assets/${hash}" after="https://elsewhere.example/b.png"}`
    );
    expect(rewritten('Text mentioning src="assets/x.png" stays as it is')).toBe(
      'Text mentioning src="assets/x.png" stays as it is'
    );
    expect(rewritten('```\n::file[x]{src="assets/x.png"}\n```')).toBe('```\n::file[x]{src="assets/x.png"}\n```');
  });

  it("say where they lead in full", () => {
    expect(rewritten('See [next](./next.md), [up](../up) and [root](/other/page "Other").')).toBe(
      'See [next](https://docs.example/guide/next.md), [up](https://docs.example/up) and [root](https://docs.example/other/page "Other").'
    );
    expect(rewritten('[ref]: ./next.md "Next"')).toBe('[ref]: https://docs.example/guide/next.md "Next"');
  });

  it("lead to an image where it can be fetched", () => {
    const hash = "a".repeat(64);
    expect(rewritten(`![a picture](assets/${hash}.png)`)).toBe(
      `![a picture](https://docs.example/api/v1/spaces/guide/assets/${hash})`
    );
  });

  it("stay as they are when they already work anywhere", () => {
    for (const line of [
      "[a](https://other.example/x)",
      "[a](mailto:me@example.test)",
      "[a](#section)",
      "[a](//cdn.example/x)",
      "[^1]: A note in plain words"
    ])
      expect(rewritten(line)).toBe(line);
  });

  it("are left alone in code", () => {
    const code = "```md\n[a](./b.md)\n```\n\n~~~\n[c](./d.md)\n```\n~~~\n\nUse `[e](./f.md)` for that, or [g](./h.md).";
    expect(rewritten(code)).toBe(
      "```md\n[a](./b.md)\n```\n\n~~~\n[c](./d.md)\n```\n~~~\n\nUse `[e](./f.md)` for that, or [g](https://docs.example/guide/h.md)."
    );
  });
});

describe("asking for Markdown", () => {
  it("counts when it comes before HTML", () => {
    for (const accept of [
      "text/markdown",
      "text/markdown, text/html",
      "text/plain, text/markdown",
      "text/html;q=0.8, text/markdown;q=0.9"
    ])
      expect(prefersMarkdown(accept), accept).toBe(true);
    for (const accept of [
      null,
      "",
      "*/*",
      "text/html",
      "text/html, text/markdown",
      "text/markdown;q=0.5, text/html",
      "text/markdown;q=0"
    ])
      expect(prefersMarkdown(accept), String(accept)).toBe(false);
  });
});

const TEMPLATE =
  '<!doctype html><html lang="en"><head><title>Docs</title></head><body><div id="root"><!--pandocs-page--><div class="boot"></div><!--/pandocs-page--></div><!--pandocs-state--></body></html>';
const RENDERED: RenderedPage = {
  html: "<main>$& $1 text</main>",
  headTags: "<title>A $' title</title>",
  htmlAttrs: ' lang="zh"',
  status: 200
};

describe("putting a page together", () => {
  it("leaves one with nothing rendered for the browser, saying what language to start in", () => {
    expect(assemblePage(TEMPLATE, "zh", null, { origin: "o", answers: {} })).toBe(
      TEMPLATE.replace("<html", '<html data-language="zh"')
    );
  });

  it("puts what was rendered in place of what shows while the app loads", () => {
    const html = assemblePage(TEMPLATE, "en", RENDERED, { origin: "o", answers: {} });
    expect(html).toContain('<html data-language="en" lang="zh">');
    // These look like replacement patterns, and are the content of the page.
    expect(html).toContain("<title>A $' title</title>");
    expect(html).toContain('<div id="root"><main>$& $1 text</main></div>');
    expect(html).not.toContain("boot");
  });

  it("links the styles of formulas only for a page that has some", () => {
    const template = TEMPLATE.replace("</head>", '<meta name="pandocs-math-styles" content="/assets/k.css"></head>');
    expect(assemblePage(template, "en", RENDERED, { origin: "o", answers: {} })).not.toContain("k.css");
    expect(
      assemblePage(template, "en", { ...RENDERED, html: '<span class="katex">x</span>' }, { origin: "o", answers: {} })
    ).toContain('<link rel="stylesheet" crossorigin href="/assets/k.css">');
  });

  it("cannot be ended early by what a document says", () => {
    const answers = {
      doc: { status: 200, payload: { data: { markdown: "</script><script>alert(1)</script><!-- $& -->" } } }
    };
    const html = assemblePage(TEMPLATE, "en", RENDERED, { origin: "o", answers });
    expect(html.match(/<script/gu)).toHaveLength(1);
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
    const state = /<script id="pandocs-state" type="application\/json">([^]*)<\/script>/u.exec(html)![1]!;
    expect(JSON.parse(state)).toEqual({ origin: "o", answers });
  });
});

describe("what renders pages", () => {
  it("is not handed out as a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pandocs-static-"));
    mkdirSync(join(dir, "ssr"));
    writeFileSync(join(dir, "ssr/worker.mjs"), "// on the server only");
    writeFileSync(join(dir, "kept.js"), "// for browsers");
    const files = createStaticFiles(dir, { cacheHtml: false });
    expect(await files.serve("/ssr/worker.mjs", "")).toBeNull();
    expect(await files.serve("/ssr/../ssr/worker.mjs", "")).toBeNull();
    expect(await files.serve("/kept.js", "")).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Stands in for the web app's build: what it does depends on the address, and it counts. */
const WORKER = `
import { parentPort, workerData } from "node:worker_threads";
let count = 0;
parentPort.on("message", async ({ id, input }) => {
  count += 1;
  const reply = page => parentPort.postMessage({ id, page, heapBytes: input.url === "/large" ? 1024 ** 3 : 1024 });
  // A development server's file watcher talks on the same channel.
  if (input.url === "/chatty") parentPort.postMessage({ "watch:import": "file:///app.ts" });
  if (input.url === "/fail") return parentPort.postMessage({ id, error: "it failed" });
  if (input.url === "/crash") process.exit(3);
  if (input.url === "/slow") await new Promise(done => setTimeout(done, 300));
  if (input.url === "/stuck") while (true) ;
  reply({ html: workerData.language + ":" + input.url + ":" + count, headTags: "", htmlAttrs: "", status: input.url === "/missing" ? 404 : 200 });
});
`;

describe("the threads that render pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "pandocs-render-"));
  const workerFile = join(dir, "worker.mjs");
  writeFileSync(workerFile, WORKER);
  const pools: RenderPool[] = [];
  const log = vi.fn();
  const pool = (options: { waitMs?: number; limitMs?: number; idleMs?: number; threads?: number } = {}) => {
    const created = createRenderPool(workerFile, { log, threads: 1, ...options });
    pools.push(created);
    return created;
  };
  const input = (url: string, extra: unknown = null): RenderInput => ({
    url,
    origin: "http://x",
    answers: { extra: { status: 200, payload: extra } }
  });

  afterEach(() => {
    for (const created of pools.splice(0)) created.stop();
    log.mockClear();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("renders a page, in that language, and says when it is missing", async () => {
    const renderer = pool();
    expect((await renderer.render("zh", input("/a")))?.html).toBe("zh:/a:1");
    expect((await renderer.render("en", input("/a")))?.html).toBe("en:/a:1");
    expect((await renderer.render("en", input("/missing")))?.status).toBe(404);
  });

  it("takes no notice of messages that are not an answer, such as those of a development server", async () => {
    const renderer = pool();
    expect((await renderer.render("en", input("/chatty")))?.html).toBe("en:/chatty:1");
    expect(log).not.toHaveBeenCalled();
  });

  it("renders the same input once, however many ask at the same time", async () => {
    const renderer = pool();
    const pages = await Promise.all([
      renderer.render("en", input("/a")),
      renderer.render("en", input("/a")),
      renderer.render("en", input("/a"))
    ]);
    expect(pages.map(page => page?.html)).toEqual(["en:/a:1", "en:/a:1", "en:/a:1"]);
    expect((await renderer.render("en", input("/a")))?.html).toBe("en:/a:1");
    // Anything that changes what goes in is another page.
    expect((await renderer.render("en", input("/a", "changed")))?.html).toBe("en:/a:2");
  });

  it("gives up on a page that fails, says why, and leaves it alone for a while", async () => {
    const renderer = pool();
    expect(await renderer.render("en", input("/fail"))).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "web.render_failed",
      expect.objectContaining({ url: "/fail", error: "it failed" })
    );
    expect(await renderer.render("en", input("/fail"))).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect((await renderer.render("en", input("/fine")))?.html).toBe("en:/fine:2");
  });

  it("starts another thread when one dies", async () => {
    const renderer = pool();
    expect(await renderer.render("en", input("/crash"))).toBeNull();
    expect((await renderer.render("en", input("/after")))?.html).toBe("en:/after:1");
  });

  it("does not make anyone wait past the limit, and has the page ready for the next person", async () => {
    const renderer = pool({ waitMs: 50 });
    expect(await renderer.render("en", input("/slow"))).toBeNull();
    await new Promise(done => setTimeout(done, 400));
    expect((await renderer.render("en", input("/slow")))?.html).toBe("en:/slow:1");
  });

  it("lets a thread with nothing to do go, and starts another when there is", async () => {
    const renderer = pool({ idleMs: 50 });
    expect((await renderer.render("en", input("/a")))?.html).toBe("en:/a:1");
    expect((await renderer.render("en", input("/b")))?.html).toBe("en:/b:2");
    await new Promise(done => setTimeout(done, 200));
    expect((await renderer.render("en", input("/c")))?.html).toBe("en:/c:1");
  });

  it("starts over after a page left a thread large, without losing that page", async () => {
    const renderer = pool();
    expect((await renderer.render("en", input("/large")))?.html).toBe("en:/large:1");
    expect((await renderer.render("en", input("/after")))?.html).toBe("en:/after:1");
    expect(log).not.toHaveBeenCalled();
  });

  it("stops a render that never ends, and carries on", async () => {
    const renderer = pool({ waitMs: 2000, limitMs: 100 });
    expect(await renderer.render("en", input("/stuck"))).toBeNull();
    expect(log).toHaveBeenCalledWith("web.render_failed", expect.objectContaining({ url: "/stuck" }));
    expect((await renderer.render("en", input("/after")))?.html).toBe("en:/after:1");
  }, 10_000);
});

describe("answering for a page", () => {
  const dir = mkdtempSync(join(tmpdir(), "pandocs-web-"));
  mkdirSync(join(dir, "ssr"));
  writeFileSync(join(dir, "ssr/worker.mjs"), WORKER);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bootstrap = {
    site: { defaultLang: "en", locales: [{ lang: "en" }] },
    spaces: [
      { slug: "guide", tree: tree("start") },
      { slug: "more", tree: [] }
    ]
  };

  const rendering = (
    api: (path: string) => { status: number; data?: unknown },
    options: { enabled?: boolean; webDir?: string } = {}
  ) => {
    const asked: string[] = [];
    const created = createPageRendering({
      webDir: options.webDir ?? dir,
      enabled: options.enabled ?? true,
      origin: "http://x",
      log: () => undefined,
      api: async request => {
        const path = new URL(request.url).pathname.slice("/api/v1/".length) + new URL(request.url).search;
        asked.push(path);
        const { status, data } = api(path);
        return new Response(
          JSON.stringify(status === 200 ? { data } : { error: { code: "NOT_FOUND", message: "no" } }),
          { status }
        );
      }
    });
    return {
      created,
      asked,
      answer: (pathname: string, search = "") =>
        created.answer(TEMPLATE, { pathname, search }, ANONYMOUS_PRINCIPAL, "en")
    };
  };
  const site = (path: string) =>
    path === "bootstrap"
      ? { status: 200, data: bootstrap }
      : path.startsWith("documents/")
        ? { status: 200, data: {} }
        : { status: 404 };

  it("renders from the answers it collected, and sends them along", async () => {
    const { created, asked, answer } = rendering(site);
    const outcome = await answer("/guide/start");
    expect(asked).toEqual(["bootstrap", "documents/id:start"]);
    expect(outcome).toMatchObject({ kind: "page", status: 200 });
    if (outcome.kind === "page") {
      expect(outcome.html).toContain("en:/guide/start:");
      expect(outcome.html).toContain('"documents/id:start"');
    }
    created.stop();
  });

  it("passes on a page's real address with the query, without rendering anything", async () => {
    const { created, asked, answer } = rendering(site);
    expect(await answer("/guide/start/", "?view=source")).toEqual({
      kind: "redirect",
      to: "/guide/start?view=source",
      status: 301
    });
    expect(asked).toEqual(["bootstrap"]);
    created.stop();
  });

  it("follows a page that moved, and otherwise lets the theme say there is nothing", async () => {
    const moved = rendering(path =>
      path.includes("resolve") ? { status: 200, data: { path: "new/place", redirected: true } } : site(path)
    );
    const stale = rendering(path =>
      path.includes("resolve") ? { status: 200, data: { path: "old", redirected: false } } : site(path)
    );
    // Where it was asked for, so sending anyone there would never end.
    expect(await stale.answer("/guide/old")).toMatchObject({ kind: "page" });
    stale.created.stop();
    expect(await moved.answer("/guide/old", "?x=1")).toEqual({
      kind: "redirect",
      to: "/guide/new/place?x=1",
      status: 301
    });
    moved.created.stop();
    const gone = rendering(site);
    const outcome = await gone.answer("/guide/old");
    expect(outcome).toMatchObject({ kind: "page", status: 200 });
    if (outcome.kind === "page") expect(outcome.html).not.toContain("resolve");
    gone.created.stop();
  });

  it("leaves a very long document to the browser", async () => {
    const { created, answer } = rendering(path =>
      path.startsWith("documents/") ? { status: 200, data: { markdown: "x".repeat(300 * 1024) } } : site(path)
    );
    const outcome = await answer("/guide/start");
    expect(outcome).toEqual({ kind: "page", status: 200, html: TEMPLATE.replace("<html", '<html data-language="en"') });
    created.stop();
  });

  it("leaves it all to the browser when it is turned off, not built, or cannot get its first answer", async () => {
    const shell = { kind: "page", status: 200, html: TEMPLATE.replace("<html", '<html data-language="en"') };
    const off = rendering(site, { enabled: false });
    expect(await off.answer("/guide/start")).toEqual(shell);
    expect(off.asked).toEqual([]);
    const unbuilt = rendering(site, { webDir: join(dir, "nowhere") });
    expect(await unbuilt.answer("/guide/start")).toEqual(shell);
    const broken = rendering(() => ({ status: 500 }));
    expect(await broken.answer("/guide/start")).toEqual(shell);
  });
});
