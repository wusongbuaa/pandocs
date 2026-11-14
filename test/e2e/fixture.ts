import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page
} from "@playwright/test";
import {
  createPandocsDb,
  createPandocsHandler,
  createPandocsServices,
  createLocalAssetStore,
  siteStyles,
  zh as coreZh,
  type PandocsPorts,
  type Principal
} from "@pandocs/core";
import { applyPandocsSchema } from "@pandocs/core/migrate";
import { addMessages, inLanguage, pickLanguage } from "@pandocs/i18n";
import { zh as markdownZh } from "@pandocs/markdown/zh";
import pg from "pg";
import { describe } from "vitest";
import type { Identity } from "../../packages/server/src/auth/identity.js";
import { createChangeListener } from "../../packages/server/src/change-listener.js";
import { createLiveCodecPort } from "../../packages/server/src/live/codec.js";
import { createLiveHub } from "../../packages/server/src/live/hub.js";
import { createEventHub } from "../../packages/server/src/events.js";
import "../../packages/server/src/language.js";
import { insidePath } from "../../packages/server/src/web/base-path.js";
import { CSP_HEADER, pageCsp } from "../../packages/server/src/web/csp.js";
import { createPageRendering, languageOfPage } from "../../packages/server/src/web/rendering.js";
import { placeBelow } from "../../packages/server/src/web/static.js";

/** Which engine the flows run in: Chromium, or `PANDOCS_E2E_ENGINE=firefox` or `webkit` for the others. */
export const engineName = (process.env.PANDOCS_E2E_ENGINE ?? "chromium") as "chromium" | "firefox" | "webkit";

/** Only Chromium lets a test give a page the clipboard to read, so the others leave out what checks what was copied. */
export const canReadClipboard = engineName === "chromium";

export const launchBrowser = (): Promise<Browser> =>
  ({ chromium, firefox, webkit })[engineName].launch(
    engineName === "chromium" && process.env.PANDOCS_E2E_BROWSER_CHANNEL
      ? { channel: process.env.PANDOCS_E2E_BROWSER_CHANNEL }
      : {}
  );

/** The Enter that picks a word in an input method, as Safari sends it: after the composition has ended, with key code 229. */
export const enterForWord = (target: Locator) =>
  target.evaluate(element => {
    const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { get: () => 229 });
    element.dispatchEvent(event);
  });

/** Needs a browser and a built app, so it runs on request: `pnpm test:e2e`. */
export const pandocsDescribe = process.env.PANDOCS_E2E === "1" ? describe : describe.skip;

for (const messages of [markdownZh, coreZh]) addMessages("zh", messages);

const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "packages/web/dist");
const BASE = "/api/v1";
const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".png": "image/png"
};

const person = (id: string, displayName: string, isAdmin = false): Principal => ({
  id,
  kind: "user",
  displayName,
  groups: isAdmin ? ["host-admin"] : [],
  isAdmin,
  scopes: ["read", "write"],
  channel: "web"
});

/** Picking from a dropdown the way a person does: open it, then choose what it lists. */
export async function choose(dropdown: Locator, option: string): Promise<void> {
  await dropdown.click();
  await dropdown.page().getByRole("option", { name: option, exact: true }).click();
}

export const PEOPLE = {
  admin: person("e2e-admin", "管理员", true),
  editor: person("e2e-editor", "编辑者"),
  commenter: person("e2e-commenter", "评论者"),
  reader: person("e2e-reader", "读者")
} as const;

export type PersonName = keyof typeof PEOPLE;

const read = (request: IncomingMessage) =>
  new Promise<Buffer>((done, fail) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => done(Buffer.concat(chunks)));
    request.on("error", fail);
  });

/**
 * The built app and the real service, without the host around them: the person comes from a cookie instead of a login.
 * The page carries the same policy the host sends, so anything it would block fails here too. With `base`, the site lives
 * below that path, the way it does behind another site's load balancer, and anything asked for outside it is noted.
 */
export async function startPandocs(
  connectionString: string,
  ports: Partial<PandocsPorts> = {},
  options: { readonly base?: string } = {}
) {
  const base = options.base ?? "";
  const policy = pageCsp(base);
  const outside: string[] = [];
  execFileSync("pnpm", ["--filter", "@pandocs/web", "build"], { cwd: ROOT, stdio: "ignore" });
  const resetPool = new pg.Pool({ connectionString, max: 1 });
  await resetPool.query("DROP SCHEMA IF EXISTS pandocs CASCADE");
  await resetPool.end();
  await applyPandocsSchema(connectionString);

  const pool = new pg.Pool({ connectionString, max: 8 });
  const assetRoot = mkdtempSync(join(tmpdir(), "pandocs-e2e-"));
  // The flows run the way editing works alone, as when a connection cannot get through. Setting this runs them all with people sharing a draft.
  const liveCodec = process.env.PANDOCS_E2E_LIVE === "1" ? createLiveCodecPort() : null;
  const services = createPandocsServices({
    db: createPandocsDb(pool),
    ports: { assets: createLocalAssetStore(assetRoot), ...(liveCodec ? { liveCodec } : {}), ...ports }
  });
  const handler = createPandocsHandler(services, { basePath: BASE });
  // The same live events as the server, with the person coming from the same cookie as everything else here.
  const identity = {
    authenticate: async (request: Request) => {
      const name = /(?:^|;\s*)e2e_user=(\w+)/u.exec(request.headers.get("cookie") ?? "")?.[1] as PersonName | undefined;
      return name && PEOPLE[name]
        ? { ok: true, principal: PEOPLE[name] }
        : { ok: false, status: 401, code: "UNAUTHENTICATED", message: "未登录" };
    }
  } as unknown as Identity;
  const hub = createEventHub({ identity, services });
  const live = createLiveHub({
    services,
    authenticate: request => identity.authenticate(request) as never,
    publicOrigin: "http://pandocs.test",
    basePath: base,
    listenUrl: connectionString,
    publish: (channel, payload) => pool.query("SELECT pg_notify($1, $2)", [channel, payload]),
    recheckMs: 30_000
  });
  const listener = createChangeListener(
    connectionString,
    () => {
      hub.wake();
      live.wake();
    },
    { fallbackMs: 3_600_000 }
  );
  const cspReports: string[] = [];
  const html = placeBelow(await readFile(join(DIST, "index.html"), "utf8"), base);
  const rendering = createPageRendering({
    webDir: DIST,
    enabled: true,
    origin: "http://pandocs.test",
    base,
    api: handler,
    log: (event, fields) => {
      console.error(event, fields);
    }
  });

  const respond = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, "http://pandocs.test");
    if (base) {
      const inside = insidePath(url.pathname, base);
      if (inside === null) {
        outside.push(url.pathname);
        response.writeHead(404).end();
        return;
      }
      url.pathname = inside;
    }
    if (url.pathname === `${BASE}/openapi.yaml`) {
      response
        .writeHead(200, { "content-type": "application/yaml" })
        .end(await readFile(join(import.meta.dirname, "../../docs/api/openapi.yaml")));
      return;
    }
    if (url.pathname.startsWith(BASE)) {
      const name = /(?:^|;\s*)e2e_user=(\w+)/u.exec(request.headers.cookie ?? "")?.[1] as PersonName | undefined;
      if (!name || !PEOPLE[name]) {
        response
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "未登录" } }));
        return;
      }
      if (url.pathname === `${BASE}/events`) {
        const events = await hub.handle(
          new Request(url, {
            headers: Object.entries(request.headers).flatMap(([key, value]): [string, string][] =>
              typeof value === "string" ? [[key, value]] : []
            )
          })
        );
        response.writeHead(events.status, Object.fromEntries(events.headers));
        const body = Readable.fromWeb(events.body as never);
        request.on("close", () => body.destroy());
        body.on("error", () => undefined);
        body.pipe(response);
        return;
      }
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const result = await handler(
        new Request(url, {
          method: request.method!,
          headers: Object.entries(request.headers).flatMap(([key, value]): [string, string][] =>
            typeof value === "string" ? [[key, value]] : []
          ),
          ...(hasBody ? { body: new Uint8Array(await read(request)) } : {})
        }),
        PEOPLE[name]
      );
      response
        .writeHead(result.status, Object.fromEntries(result.headers))
        .end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    if (url.pathname === "/api/csp-report") {
      cspReports.push((await read(request)).toString());
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/site.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(siteStyles(await services.site.get()));
      return;
    }
    const file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    const asset = file.startsWith(DIST) && extname(file) ? await readFile(file).catch(() => null) : null;
    if (asset) {
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(asset);
      return;
    }
    // The same pages as the real server. An embedded one holds nothing itself, and gets its token from its host once it runs.
    const name = /(?:^|;\s*)e2e_user=(\w+)/u.exec(request.headers.cookie ?? "")?.[1] as PersonName | undefined;
    if (!name || !PEOPLE[name] || url.pathname.startsWith("/embed/")) {
      response.writeHead(200, { "content-type": TYPES[".html"]!, [CSP_HEADER]: policy }).end(html);
      return;
    }
    const asked = new Request(url, {
      headers: Object.entries(request.headers).flatMap(([key, value]): [string, string][] =>
        typeof value === "string" ? [[key, value]] : []
      )
    });
    const language = await languageOfPage(asked, url.pathname, async () => (await services.site.get()).defaultLang);
    const outcome = await rendering.answer(html, url, PEOPLE[name], language);
    if (outcome.kind === "redirect") response.writeHead(outcome.status, { location: `${base}${outcome.to}` }).end();
    else
      response.writeHead(outcome.status, { "content-type": TYPES[".html"]!, [CSP_HEADER]: policy }).end(outcome.html);
  };
  const server = createServer((request, response) => {
    inLanguage(pickLanguage(request.headers["accept-language"]), () => respond(request, response)).catch(error => {
      console.error(error);
      response.writeHead(500).end();
    });
  });
  server.on("upgrade", live.handleUpgrade);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const browser: Browser = await launchBrowser();
  const contexts: BrowserContext[] = [];
  /** Anywhere a page came out different in the browser from how the server rendered it, for all the flows that open pages here. */
  const mismatches: string[] = [];

  /** A signed-in tab. Scripts or dialogs a page should never run fail the test that caused them. */
  const open = async (name: PersonName, path: string, locale = "zh-CN"): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale,
      ...(canReadClipboard ? { permissions: ["clipboard-read", "clipboard-write"] } : {})
    });
    contexts.push(context);
    await context.addCookies([{ name: "e2e_user", value: name, url: origin }]);
    const page = await context.newPage();
    page.on("console", message => {
      if (message.text().includes("did not match what the server rendered"))
        mismatches.push(`${path}: ${message.text()}`);
    });
    await page.goto(`${origin}${base}${path}`);
    await page
      .waitForFunction(() => document.documentElement.dataset.live === "", null, { timeout: 15_000 })
      .catch(() => undefined);
    return page;
  };

  const api = async (
    name: PersonName,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) => {
    const response = await handler(
      new Request(`${origin}${BASE}/${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      PEOPLE[name]
    );
    const payload = (await response.json().catch(() => null)) as { data?: any; error?: any } | null;
    return { status: response.status, data: payload?.data, error: payload?.error };
  };

  const upload = async (name: PersonName, space: string, filename: string, bytes: Buffer): Promise<string> => {
    const response = await handler(
      new Request(`${origin}${BASE}/spaces/${space}/assets?filename=${encodeURIComponent(filename)}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(bytes)
      }),
      PEOPLE[name]
    );
    return ((await response.json()) as { data: { path: string } }).data.path;
  };

  return {
    origin,
    api,
    upload,
    open,
    cspReports,
    /** What the browser asked for outside the site's path, which nothing should. */
    outside,
    /** Imports of files convert in the background, and there is no worker running here. */
    async settleImports() {
      while (await services.ingest.tick()) {
        /* until there are none left */
      }
      while (await services.bulkImports.tick()) {
        /* until there are none left */
      }
    },
    /** The same goes for looking at repositories. */
    async settleGitSync() {
      while (await services.gitSync.tick()) {
        /* until there are none left */
      }
    },
    async close() {
      await Promise.all(contexts.map(context => context.close()));
      await browser.close();
      listener.stop();
      hub.stop();
      await live.stop();
      rendering.stop();
      await new Promise(done => server.close(done));
      await pool.end();
      rmSync(assetRoot, { recursive: true, force: true });
      if (mismatches.length > 0)
        throw new Error(`Pages did not match what the server rendered:\n${mismatches.join("\n")}`);
    }
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
}

/** A picture with a real size, for flows that click on an image or compare two. */
export function testPicture(red: number, green: number, blue: number, width = 960, height = 480): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, at) => [red, green, blue][at % 3]!)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", pixels),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** Drags across words with the mouse, the way someone selects them. */
export async function selectWords(page: Page, words: string): Promise<void> {
  const box = await page.evaluate(wanted => {
    const walker = document.createTreeWalker(document.querySelector("[data-pandocs-body]")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.nodeValue!.indexOf(wanted);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    }
    return null;
  }, words);
  if (!box) throw new Error(`页面上没有这段文字：${words}`);
  await page.mouse.move(box.left + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, box.y, { steps: 8 });
  await page.mouse.up();
}
