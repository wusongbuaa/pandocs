import { pandocsRouteTable, publicRouteTable } from "@pandocs/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { createRateLimiter } from "../src/public-access.js";
import { PUBLIC_URL, signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const WRITES_FOR_VISITORS = ["PATCH documents/:id/feedback/:feedback", "POST ask", "POST ask/:id/rating", "POST documents/:id/feedback", "POST stats/searches", "POST stats/views"];
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

describe("public spaces", () => {
  let server: TestServer;
  let admin: Client;
  let visitor: Client;
  let openPage = "";
  let lockedPage = "";
  let closedPage = "";
  let openImage = "";
  let lockedImage = "";
  let unusedImage = "";

  const api = (path: string) => visitor.json("GET", `/api/v1/${path}`);
  const upload = async (space: string, bytes: Uint8Array, name: string) => {
    const response = await admin.request(`/api/v1/spaces/${space}/assets?filename=${name}`, { method: "POST", headers: { "content-type": "image/png" }, body: bytes as BodyInit });
    return ((await response.json()) as { data: { sha256: string; path: string } }).data;
  };
  /** Answers for visitors are shared for a few seconds, and knowing which spaces are public is too. */
  const realNow = Date.now.bind(Date);
  let ahead = 0;
  const later = () => {
    ahead += 10_000;
    vi.spyOn(Date, "now").mockReturnValue(realNow() + ahead);
  };
  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString());
    admin = await signInFirstAdmin(server);
    visitor = server.client();
    for (const [slug, name] of [["shop", "书店"], ["inside", "内部"]] as const) {
      await admin.json("POST", "/api/v1/spaces", { slug, name, defaultRole: "viewer" });
    }
    const image = await upload("shop", PNG, "open.png");
    const secret = await upload("shop", new Uint8Array([...PNG, 1]), "secret.png");
    unusedImage = (await upload("shop", new Uint8Array([...PNG, 2]), "unused.png")).sha256;
    openImage = image.sha256;
    lockedImage = secret.sha256;
    openPage = (await admin.json("POST", "/api/v1/spaces/shop/documents", { title: "退货", slug: "returns", markdown: `# 退货\n\n七天内可以退货。\n\n![图](${image.path})\n` })).data.document.id;
    lockedPage = (await admin.json("POST", "/api/v1/spaces/shop/documents", { title: "内部价", slug: "cost", markdown: `进货价保密。\n\n![图](${secret.path})\n`, restricted: true })).data.document.id;
    closedPage = (await admin.json("POST", "/api/v1/spaces/inside/documents", { title: "内部", slug: "note", markdown: "只给同事看\n" })).data.document.id;
    await admin.json("POST", `/api/v1/documents/${openPage}/threads`, { anchor: { kind: "quote", quote: "七天" }, body: "内部讨论：是不是太短了" });
  });
  afterAll(() => server.close());

  describe("before anything is public", () => {
    it("is as closed as a site with no such thing", async () => {
      for (const path of ["bootstrap", "blocks", "site", "spaces", "search?q=退货", `documents/${openPage}`, "llms.txt"]) {
        expect((await api(path)).status, path).toBe(401);
      }
      for (const path of ["/", "/shop/returns", "/nothing"]) {
        const page = await visitor.request(path);
        expect(page.status, path).toBe(302);
        expect(page.headers.get("location")).toContain("/login");
      }
      expect((await visitor.request("/shop/returns.md")).status).toBe(401);
    });
  });

  describe("turning it on", () => {
    it("takes someone administering that space, and is on the record", async () => {
      await admin.json("POST", "/api/v1/admin/users", { email: "member@example.test", displayName: "同事", password: "member-password-1" });
      const member = server.client();
      await member.form("/login", { email: "member@example.test", password: "member-password-1", next: "/" });
      const { id } = (await member.json("GET", "/api/v1/account")).data;
      await admin.json("PUT", "/api/v1/spaces/shop/members", { subject: `user:${id}`, role: "editor" });
      expect((await member.json("PATCH", "/api/v1/spaces/shop", { publicRead: true })).status).toBe(403);
      expect((await admin.json("GET", "/api/v1/spaces/shop")).data.publicRead).toBe(false);

      const opened = await admin.json("PATCH", "/api/v1/spaces/shop", { publicRead: true });
      expect(opened.status).toBe(200);
      expect(opened.data.publicRead).toBe(true);
      const { data: audit } = await admin.json("GET", "/api/v1/spaces/shop/audit");
      expect((audit.items ?? audit).map((event: { action: string }) => event.action)).toContain("space.public");
      later();
    });
  });

  describe("what a visitor can read", () => {
    it("sees the site as it is for them: public spaces and the pages in them", async () => {
      later();
      const { status, data } = await api("bootstrap");
      expect(status).toBe(200);
      expect(data.me).toMatchObject({ anonymous: true, isAdmin: false, scopes: ["read"] });
      expect(data.spaces.map((space: { slug: string }) => space.slug)).toEqual(["shop"]);
      expect(data.spaces[0].tree.map((node: { path: string }) => node.path)).toEqual(["returns"]);
      expect((await api("spaces")).data.map((space: { slug: string }) => space.slug)).toEqual(["shop"]);
      expect((await api("spaces/shop/tree")).data.map((node: { path: string }) => node.path)).toEqual(["returns"]);
      expect((await api("spaces/shop")).data).toMatchObject({ role: "viewer", publicRead: true });
    });

    it("reads a page, without who wrote it or what they said", async () => {
      await admin.json("PUT", `/api/v1/documents/${openPage}/editing`, {});
      const { status, data } = await api(`documents/${openPage}`);
      expect(status).toBe(200);
      expect(data.markdown).toContain("七天内可以退货");
      expect(data.revision).toMatchObject({ no: 1, actorId: "", actorName: "", message: "" });
      expect(data.editing).toBeNull();
      expect(data.document.editingName).toBeNull();
      const raw = JSON.stringify(data);
      expect(raw).not.toContain("站长");

      const plain = await visitor.request(`/api/v1/documents/${openPage}/content`);
      expect(await plain.text()).toContain("七天内可以退货");
      expect((await visitor.request("/shop/returns.md")).status).toBe(200);
      expect(await (await visitor.request("/shop/llms.txt")).text()).toContain("退货");
    });

    it("finds public pages by searching, and nothing else", async () => {
      expect((await api("search?q=退货")).data.map((hit: { id: string }) => hit.id)).toEqual([openPage]);
      expect((await api("search?q=进货价")).data).toEqual([]);
      expect((await api("search?q=只给同事看")).data).toEqual([]);
    });

    it("gets the images public pages show, and no other upload", async () => {
      const shown = await visitor.request(`/api/v1/spaces/shop/assets/${openImage}`);
      expect(shown.status).toBe(200);
      expect(shown.headers.get("content-type")).toBe("image/png");
      expect((await visitor.request(`/api/v1/spaces/shop/assets/${lockedImage}`)).status).toBe(404);
      expect((await visitor.request(`/api/v1/spaces/shop/assets/${unusedImage}`)).status).toBe(404);
      // Someone signed in still gets what they could before.
      expect((await admin.request(`/api/v1/spaces/shop/assets/${unusedImage}`)).status).toBe(200);
    });

    it("cannot reach restricted pages, other spaces or earlier versions", async () => {
      expect((await api(`documents/${lockedPage}`)).status).toBe(404);
      expect((await api(`documents/${closedPage}`)).status).toBe(404);
      expect((await api("spaces/inside")).status).toBe(404);
      expect((await api("spaces/inside/tree")).status).toBe(404);
      expect((await api(`documents/${openPage}?revision=1`)).status).toBe(404);
      expect((await visitor.request(`/api/v1/documents/${openPage}/content?revision=1`)).status).toBe(404);
      expect((await visitor.request("/shop/cost.md")).status).toBe(404);
      expect((await visitor.request("/inside/note.md")).status).toBe(404);
    });

    it("tells crawlers what there is to read, and only that", async () => {
      const robots = await (await visitor.request("/robots.txt")).text();
      expect(robots).toContain(`Sitemap: ${PUBLIC_URL}/sitemap.xml`);
      expect(robots).toContain("Disallow: /_/");
      const sitemap = await visitor.request("/sitemap.xml");
      expect(sitemap.headers.get("content-type")).toContain("application/xml");
      const xml = await sitemap.text();
      expect(xml).toContain(`<loc>${PUBLIC_URL}/shop/returns</loc><lastmod>`);
      for (const hidden of ["cost", "inside", "note"]) expect(xml).not.toContain(hidden);
    });

    describe("leaving something behind", () => {
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) => visitor.request(`/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

      it("can vote on a public page, and count reading it", async () => {
        expect((await post(`documents/${openPage}/feedback`, { kind: "helpful" })).status).toBe(201);
        expect((await post("stats/views", { document: openPage })).status).toBe(200);
        expect((await post("stats/searches", { term: "退货", results: 1 })).status).toBe(200);
      });

      it("cannot on anything else", async () => {
        for (const doc of [lockedPage, closedPage]) {
          expect((await post(`documents/${doc}/feedback`, { kind: "helpful" })).status).toBe(404);
          expect((await post("stats/views", { document: doc })).status).toBe(404);
        }
      });

      it("cannot be made to from another site", async () => {
        const answer = await post(`documents/${openPage}/feedback`, { kind: "helpful" }, { "sec-fetch-site": "cross-site" });
        expect(answer.status).toBe(401);
      });

      it("can ask only on a site that offers it, which this one has no model for", async () => {
        const { status, error } = await visitor.json("POST", "/api/v1/ask", { question: "?" });
        expect(status).toBe(503);
        expect(error.code).toBe("LLM_UNAVAILABLE");
      });

      it("has limits of its own", () => {
        const access = server.runtime.publicAccess;
        const address = "198.51.100.7";
        expect(Array.from({ length: 31 }, () => access.allowRequest(address, "/api/v1/documents/x/feedback")).filter(Boolean)).toHaveLength(30);
        expect(Array.from({ length: 21 }, () => access.allowRequest(address, "/api/v1/ask")).filter(Boolean)).toHaveLength(20);
        expect(access.allowRequest(address, "/api/v1/stats/views")).toBe(true);
      });
    });

    describe("over MCP, with no token", () => {
      const rpc = async (method: string, params: unknown = {}) => {
        const response = await visitor.request("/mcp/public", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
        });
        return (await response.json()) as { result: { tools: { name: string }[]; structuredContent: { data?: any; error?: { code: string } }; isError?: boolean } };
      };

      it("offers reading and saying what is wrong, and nothing else", async () => {
        const { result } = await rpc("tools/list");
        expect(result.tools.map(tool => tool.name).sort()).toEqual(["doc_blocks", "doc_get", "doc_list", "doc_report", "doc_search", "doc_spaces"]);
      });

      it("reads a public page, without who wrote it", async () => {
        await admin.json("PUT", `/api/v1/documents/${openPage}/editing`, {});
        const { result } = await rpc("tools/call", { name: "doc_get", arguments: { doc: openPage } });
        expect(result.structuredContent.data.markdown).toContain("七天内可以退货");
        expect(result.structuredContent.data.revision).toMatchObject({ actorName: "", message: "" });
        expect(result.structuredContent.data.editing).toBeNull();
        expect(JSON.stringify(result.structuredContent.data)).not.toContain("站长");
      });

      it("finds and lists what is public, and no more", async () => {
        const spaces = await rpc("tools/call", { name: "doc_spaces", arguments: {} });
        expect(spaces.result.structuredContent.data.map((space: { slug: string }) => space.slug)).toEqual(["shop"]);
        const hits = await rpc("tools/call", { name: "doc_search", arguments: { query: "退货" } });
        expect(hits.result.structuredContent.data.map((hit: { id: string }) => hit.id)).toEqual([openPage]);
        expect((await rpc("tools/call", { name: "doc_search", arguments: { query: "只给同事看" } })).result.structuredContent.data).toEqual([]);
      });

      it("does not reach anything else, by id or by an earlier version", async () => {
        for (const doc of [lockedPage, closedPage]) {
          const { result } = await rpc("tools/call", { name: "doc_get", arguments: { doc } });
          expect(result.isError).toBe(true);
          expect(result.structuredContent.error?.code).toBe("NOT_FOUND");
        }
        const earlier = await rpc("tools/call", { name: "doc_get", arguments: { doc: openPage, revision: 1 } });
        expect(earlier.result.isError).toBe(true);
      });

      it("takes a report of what is wrong with a public page, and no other", async () => {
        const { result } = await rpc("tools/call", { name: "doc_report", arguments: { doc: openPage, problem: "The period looks wrong." } });
        expect(result.structuredContent.data.id).toBeTruthy();
        const [report] = (await admin.json("GET", "/api/v1/spaces/shop/feedback")).data;
        expect(report).toMatchObject({ kind: "report", audience: "agent", reporter: null, body: "The period looks wrong." });
        for (const doc of [lockedPage, closedPage]) expect((await rpc("tools/call", { name: "doc_report", arguments: { doc, problem: "x" } })).result.isError).toBe(true);
      });

      it("refuses tools that are not on the list", async () => {
        const { result } = await rpc("tools/call", { name: "thread_list", arguments: { doc: openPage } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("是不是太短了");
      });
    });
  });

  describe("what stays closed to a visitor", () => {
    const concrete = (pattern: string) => pattern
      .replace(":space", "shop")
      .replace(":id", openPage)
      .replace(":lang", "en")
      .replace(":no", "1")
      .replace(":file", "x")
      .replace(":name", "x")
      .replace("*", "x");

    it("is every read of the API not meant for them, including any added later", async () => {
      const allowed = new Set(publicRouteTable);
      const closed = pandocsRouteTable.filter(route => route.method === "GET" && !allowed.has(`GET ${route.pattern}`));
      expect(closed.length).toBeGreaterThan(20);
      for (const route of closed) {
        const { status, error } = await api(concrete(route.pattern));
        expect(status, route.pattern).toBe(401);
        expect(error.code).toBe("UNAUTHENTICATED");
      }
    });

    it("names only routes that exist", () => {
      const served = new Set(pandocsRouteTable.map(route => `${route.method} ${route.pattern}`));
      expect(publicRouteTable.filter(route => !served.has(route))).toEqual([]);
      // Every way someone with no login can leave anything behind, spelled out so that adding one takes a decision.
      expect(publicRouteTable.filter(route => !route.startsWith("GET ")).sort()).toEqual(WRITES_FOR_VISITORS);
    });

    it("is everything that changes something", async () => {
      for (const route of pandocsRouteTable.filter(item => item.method !== "GET" && !WRITES_FOR_VISITORS.includes(`${item.method} ${item.pattern}`))) {
        const answer = await visitor.json(route.method, `/api/v1/${concrete(route.pattern)}`, {});
        expect(answer.status, `${route.method} ${route.pattern}`).toBe(401);
      }
    });

    it("includes discussions, live events, accounts and MCP", async () => {
      expect((await api(`documents/${openPage}/threads`)).status).toBe(401);
      expect((await api(`documents/${openPage}/proposals`)).status).toBe(401);
      expect((await api(`documents/${openPage}/revisions`)).status).toBe(401);
      expect((await api("spaces/shop/manifest")).status).toBe(401);
      expect((await api("spaces/shop/export")).status).toBe(401);
      expect((await api("events")).status).toBe(401);
      expect((await api("account")).status).toBe(401);
      expect((await api("admin/users")).status).toBe(401);
      expect((await visitor.json("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    });

    it("does not treat a wrong credential as no credential", async () => {
      const wrong = await visitor.json("GET", "/api/v1/spaces/shop", undefined, { authorization: "Bearer pd_not_real" });
      expect(wrong.status).toBe(401);
      expect(wrong.error.code).toBe("TOKEN_INVALID");
    });

    it("lets a login that ran out go on as a visitor", async () => {
      const lapsed = server.client();
      lapsed.cookies.set("pandocs_session", "not-a-session");
      expect((await lapsed.json("GET", "/api/v1/spaces/shop")).status).toBe(200);
      expect((await lapsed.json("GET", "/api/v1/me")).status).toBe(401);
    });
  });

  describe("people who are signed in", () => {
    it("can read a public space with no role in it, and comment only with one", async () => {
      await admin.json("POST", "/api/v1/spaces", { slug: "open-only", name: "只公开", defaultRole: "none" });
      const page = (await admin.json("POST", "/api/v1/spaces/open-only/documents", { title: "一页", slug: "page", markdown: "正文\n" })).data.document.id;
      await admin.json("POST", "/api/v1/admin/users", { email: "other@example.test", displayName: "别的同事", password: "other-password-12" });
      const other = server.client();
      await other.form("/login", { email: "other@example.test", password: "other-password-12", next: "/" });
      expect((await other.json("GET", `/api/v1/documents/${page}`)).status).toBe(404);
      await admin.json("PATCH", "/api/v1/spaces/open-only", { publicRead: true });
      const read = await other.json("GET", `/api/v1/documents/${page}`);
      expect(read.status).toBe(200);
      expect(read.data.revision.actorName).toBe("站长");
      expect((await other.json("POST", `/api/v1/documents/${page}/threads`, { anchor: { kind: "document" }, body: "看看" })).status).toBe(403);
      await admin.json("PATCH", "/api/v1/spaces/open-only", { publicRead: false });
    });

    it("still see restricted pages only if they could", async () => {
      expect((await admin.json("GET", `/api/v1/documents/${lockedPage}`)).status).toBe(200);
    });
  });

  describe("pages", () => {
    it("answers any address with a page, which is where a closed one and a missing one look the same, and the app's own pages need a login", async () => {
      later();
      for (const path of ["/", "/shop", "/shop/returns", "/shop/does-not-exist", "/inside", "/inside/note", "/no-such-space/page"]) {
        const page = await visitor.request(path);
        expect(page.status, path).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
      }
      for (const path of ["/_/account", "/_/spaces/shop/settings"]) {
        const page = await visitor.request(path);
        expect(page.status, path).toBe(302);
        expect(page.headers.get("location")).toContain("/login?next=");
      }
    });

    it("follows the site's languages", async () => {
      later();
      await admin.json("PATCH", "/api/v1/site", { defaultLang: "zh", locales: [{ lang: "zh", label: "中文" }, { lang: "en", label: "English" }] });
      vi.restoreAllMocks();
      later();
      expect((await visitor.request("/en/shop/returns")).status).toBe(200);
      expect((await visitor.request("/en")).status).toBe(200);
      expect((await visitor.request("/en/_/account")).status).toBe(302);
    });
  });

  describe("turning it off", () => {
    it("closes pages at once, and the rest within seconds", async () => {
      await admin.json("PATCH", "/api/v1/spaces/shop", { publicRead: false });
      expect((await api(`documents/${openPage}`)).status).toBe(404);
      expect((await visitor.request(`/api/v1/spaces/shop/assets/${openImage}`)).status).toBe(404);
      later();
      expect((await api("bootstrap")).status).toBe(401);
      const page = await visitor.request("/shop/returns");
      expect(page.status).toBe(302);
      await admin.json("PATCH", "/api/v1/spaces/shop", { publicRead: true });
      const { data: audit } = await admin.json("GET", "/api/v1/spaces/shop/audit");
      expect((audit.items ?? audit).map((event: { action: string }) => event.action)).toContain("space.private");
    });
  });

  describe("keeping one visitor from taking too much", () => {
    it("shares the expensive answers between visitors", async () => {
      later();
      const spy = vi.spyOn(server.runtime.services.site, "get");
      const first = await api("bootstrap");
      const calls = spy.mock.calls.length;
      const second = await api("bootstrap");
      expect(second.data).toEqual(first.data);
      expect(spy.mock.calls.length).toBe(calls);
    });

    it("asks them to slow down past a limit", async () => {
      later();
      vi.spyOn(server.runtime.publicAccess, "allowRequest").mockReturnValue(false);
      const limited = await api("spaces");
      expect(limited.status).toBe(429);
      expect(limited.error.code).toBe("RATE_LIMITED");
      expect(limited.response.headers.get("retry-after")).toBe("60");
      // Someone signed in is not a visitor.
      expect((await admin.json("GET", "/api/v1/spaces")).status).toBe(200);
    });

    it("counts per address, and starts over each window", () => {
      const limiter = createRateLimiter(2, 1000);
      expect([limiter.allow("a", 0), limiter.allow("a", 1), limiter.allow("a", 2)]).toEqual([true, true, false]);
      expect(limiter.allow("b", 3)).toBe(true);
      expect(limiter.allow("a", 1000)).toBe(true);
    });
  });
});

describe("a site that rules public spaces out", () => {
  let server: TestServer;
  let admin: Client;
  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString(), { PANDOCS_PUBLIC_SPACES: "false" });
    await server.pool.query("DROP SCHEMA pandocs CASCADE");
    await server.close();
    server = await startServer(postgres.getConnectionString(), { PANDOCS_PUBLIC_SPACES: "false" });
    admin = await signInFirstAdmin(server);
  });
  afterAll(() => server.close());

  it("refuses to open one, and stays closed even if one somehow is", async () => {
    await admin.json("POST", "/api/v1/spaces", { slug: "shut", name: "关着", defaultRole: "viewer" });
    const refused = await admin.json("PATCH", "/api/v1/spaces/shut", { publicRead: true });
    expect(refused.status).toBe(403);
    expect(refused.error.code).toBe("PUBLIC_SPACES_DISABLED");
    await server.pool.query(`UPDATE pandocs.spaces SET public_read = true WHERE slug = 'shut'`);
    const visitor = server.client();
    expect((await visitor.json("GET", "/api/v1/spaces/shut")).status).toBe(401);
    expect((await visitor.request("/shut")).status).toBe(302);
  });
});
