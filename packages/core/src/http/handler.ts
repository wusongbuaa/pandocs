import { createHash } from "node:crypto";
import { t } from "@pandocs/i18n";
import { describeBlocks, editOpSchema, type ReadScope } from "@pandocs/markdown";
import { z } from "zod";
import type { PandocsServices } from "../app.js";
import { fromDatabase, PandocsError, invalid, notFound } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import { MAX_ASSET_BYTES } from "../application/assets.js";
import { AUDIT_CATEGORIES, type AuditQuery } from "../application/audit-log.js";
import { validCursor } from "../application/changes.js";
import { askInput } from "../application/ask.js";
import { changeSetInput, changeSetPageInput, reviewInput } from "../application/change-sets.js";
import { UUID } from "../application/context.js";
import { documentLabels, type DocumentView } from "../application/documents.js";
import { feedbackBody, feedbackInput } from "../application/feedback.js";
import { shareLinkInput } from "../application/share-links.js";
import { gitSyncInput } from "../application/git-sync.js";
import { siteSettingsSchema } from "../application/site.js";
import { audienceOf } from "../application/stats.js";
import { templateInput } from "../application/templates.js";
import { webhookInput } from "../application/webhooks.js";
import type { AnchorInput } from "../application/threads.js";
import { ASSIST_ACTIONS } from "../ports.js";
import { describeTools, pandocsTools, fromTemplate, withoutPeople } from "./tools.js";

const JSON_LIMIT = 8 * 1024 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

interface RouteContext {
  readonly request: Request;
  readonly principal: Principal;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly services: PandocsServices;
  text(): Promise<string>;
  json<Schema extends z.ZodType>(schema: Schema): Promise<z.output<Schema>>;
}

type RouteResult = Response | { readonly data: unknown; readonly status?: number; readonly raw?: unknown };
type RouteHandler = (context: RouteContext) => Promise<RouteResult>;

interface Route {
  readonly method: string;
  readonly pattern: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

const ok = (data: unknown, status = 200, raw?: unknown): RouteResult => ({ data, status, raw });

/** Not `instanceof`: HTTP libraries replace the global `Response`, and then `Response.json()` makes objects the global does not claim. */
const isResponse = (result: RouteResult): result is Response =>
  Object.prototype.toString.call(result) === "[object Response]";

/** The theme asks for `search_index[.lang].hash.json` under its public path; the hash only tells a new index from an old one. */
const SEARCH_INDEX_FILE = /^search_index(?:\.([a-z]{2}))?\.[a-f0-9]+\.json$/u;

async function visibleSpaces(services: PandocsServices, principal: Principal) {
  const [spaces, { defaultLang }] = await Promise.all([services.spaces.list(principal), services.site.get()]);
  // A translation into the language pages are written in is left from before the site changed its language, and names nothing.
  const translated = (titles: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(titles).filter(([lang]) => lang !== defaultLang));
  return Promise.all(
    spaces.map(async space => ({
      ...space,
      tree: (await services.documents.tree(principal, space.slug)).map(node => ({
        ...node,
        titles: translated(node.titles)
      }))
    }))
  );
}

/** One request for what the app needs before its first render: its routes and sidebars are built from this. */
async function bootstrapFor(services: PandocsServices, principal: Principal) {
  // The favicon is already in the page, and the custom CSS in its stylesheet; the settings page reads both from `site`.
  const [{ customCss: _customCss, favicon: _favicon, ...site }, spaces] = await Promise.all([
    services.site.get(),
    visibleSpaces(services, principal)
  ]);
  // Saving a translation makes no new version, so its time has to change the search index's address too.
  const { rows } = await services.context.db.query<{ latest: string | null }>(
    `SELECT max(updated_at)::text AS latest FROM pandocs.document_translations`
  );
  const fingerprint = `${spaces.flatMap(space => space.tree.map(node => `${node.id}:${node.currentRevisionNo}`)).join()}|${rows[0]?.latest ?? ""}`;
  return {
    me: {
      id: principal.id,
      displayName: principal.displayName,
      kind: principal.kind,
      isAdmin: principal.isAdmin,
      scopes: principal.scopes,
      ...(principal.anonymous ? { anonymous: true } : {})
    },
    site,
    spaces,
    searchIndexHash: createHash("sha256").update(fingerprint).digest("hex").slice(0, 12),
    fullTextOnServer: await services.documents.fullTextOnServer(spaces.map(space => space.id)),
    ai: {
      configured: Boolean(services.context.ports.llm),
      ask: !principal.shared && services.ask.available(principal, site.askForVisitors)
    },
    shareLinks: services.shareLinks.available,
    passwordLogin: services.context.ports.passwordLogin !== false
  };
}

function insightDays(query: URLSearchParams): number {
  const days = optionalInt(query.get("days"), "days") ?? 30;
  if (days > 365) throw invalid("PARAM_INVALID", t("days can be at most 365"));
  return days;
}

function changeSetStatus(query: URLSearchParams): "open" | "merged" | "closed" | undefined {
  const parsed = z
    .enum(["open", "merged", "closed"])
    .optional()
    .safeParse(query.get("status") ?? undefined);
  if (!parsed.success) throw invalid("PARAM_INVALID", t("status should be open, merged or closed"));
  return parsed.data;
}

function feedbackStatus(query: URLSearchParams): "open" | "resolved" | "all" {
  const parsed = z.enum(["open", "resolved", "all"]).safeParse(query.get("status") ?? "open");
  if (!parsed.success) throw invalid("PARAM_INVALID", t("status should be open, resolved or all"));
  return parsed.data;
}

function draftLang(query: URLSearchParams): string {
  const lang = query.get("lang") ?? "";
  if (lang && !/^[a-z]{2}$/u.test(lang))
    throw invalid("PARAM_INVALID", t("lang should be a two-letter lowercase language code"));
  return lang;
}

const text200 = (body: string) =>
  new Response(body, { headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });

const auditCategory = z.enum(AUDIT_CATEGORIES).optional();

function auditQuery(query: URLSearchParams): AuditQuery {
  const parsed = auditCategory.safeParse(query.get("category") ?? undefined);
  if (!parsed.success) throw invalid("PARAM_INVALID", t("category is not a known category"));
  const before = query.get("before");
  if (before !== null && !/^\d{1,18}$/u.test(before))
    throw invalid("PARAM_INVALID", t("before should be the id of the last entry on the previous page"));
  return { category: parsed.data, before: before ?? undefined, limit: optionalInt(query.get("limit"), "limit") };
}

function route(method: string, pattern: string, handler: RouteHandler): Route {
  return { method, pattern, segments: pattern.split("/").filter(Boolean), handler };
}

const UUID_PARAMS = ["id", "page", "feedback", "delivery"] as const;
/** A page is at most 2 MiB, and no draft of one has more characters than that has bytes. */
const MOST_DRAFT_CHARS = 2 * 1024 * 1024;

function matchRoute(routes: readonly Route[], method: string, parts: readonly string[]) {
  let pathExists = false;
  for (const candidate of routes) {
    const last = candidate.segments.at(-1);
    const wildcard = last === "*";
    if (wildcard ? parts.length < candidate.segments.length - 1 : parts.length !== candidate.segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < candidate.segments.length; i += 1) {
      const segment = candidate.segments[i]!;
      if (segment === "*") {
        params.rest = parts.slice(i).join("/");
        break;
      }
      if (segment.startsWith(":")) params[segment.slice(1)] = parts[i]!;
      else if (segment !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    pathExists = true;
    if (candidate.method === method) return { route: candidate, params };
  }
  return { route: null, params: {}, pathExists };
}

const intParam = (value: string | null | undefined, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw invalid("PARAM_INVALID", t("{0} must be a positive integer", name));
  return parsed;
};

const optionalInt = (value: string | null, name: string) => (value === null ? undefined : intParam(value, name));

/** Blocks either side of a keyword match, as many as the MCP tool takes. */
const contextParam = (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 5)
    throw invalid("PARAM_INVALID", t("{0} must be a whole number from {1} to {2}", "context", 0, 5));
  return parsed;
};

function scopeFrom(query: URLSearchParams): ReadScope {
  const scope = query.get("scope");
  switch (scope) {
    case null:
    case "full":
      return { scope: "full" };
    case "outline":
      return { scope: "outline" };
    case "section":
      return { scope: "section", section: query.get("section") ?? "" };
    case "range":
      return { scope: "range", start: query.get("start") ?? "", end: query.get("end") ?? "" };
    case "keyword":
      return {
        scope: "keyword",
        keyword: query.get("keyword") ?? "",
        ...(query.get("context") ? { context: contextParam(query.get("context")!) } : {})
      };
    default:
      throw invalid("SCOPE_INVALID", t("Unsupported scope {0}", scope));
  }
}

const roleEnum = z.enum(["viewer", "commenter", "editor", "admin"]);
const mentionsSchema = z
  .array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict())
  .max(50)
  .optional();
const anchorSchema: z.ZodType<AnchorInput> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      start: z.number().int().min(0),
      end: z.number().int().positive(),
      exact: z.string().max(4000).optional(),
      revision: z.number().int().positive().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("quote"),
      quote: z.string().min(1).max(4000),
      occurrence: z.number().int().positive().optional(),
      revision: z.number().int().positive().optional()
    })
    .strict(),
  z.object({ kind: z.literal("section"), section: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal("block"), ref: z.string().min(1), revision: z.number().int().positive().optional() })
    .strict(),
  z.object({ kind: z.literal("document") }).strict()
]) as z.ZodType<AnchorInput>;

/** A title or a name: spaces, tabs and line breaks in it read as one space, and there has to be something besides. */
const nameText = (most: number) =>
  z
    .string()
    .transform(value => value.replace(/\s+/gu, " ").trim())
    .pipe(z.string().min(1).max(most));
const SPACE_SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
/** What the database keeps a page's order in. */
const sortOrder = z
  .number()
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);

const contentSchema = z
  .object({
    markdown: z.string(),
    expectedRevision: z.number().int().positive(),
    message: z.string().max(500).optional(),
    merge: z.boolean().optional(),
    fromLiveDraft: z.boolean().optional(),
    strict: z.boolean().optional(),
    title: nameText(200).optional()
  })
  .strict();
const opsSchema = z
  .object({
    ops: z.array(editOpSchema).min(1).max(100),
    expectedRevision: z.number().int().positive(),
    message: z.string().max(500).optional(),
    strict: z.boolean().optional()
  })
  .strict();

/** Writes that change a document need a retry-safe key; a replay returns the first answer. */
function idempotent(handler: RouteHandler): RouteHandler {
  return async context => {
    const { request, principal, services } = context;
    const key = request.headers.get("idempotency-key") ?? request.headers.get("x-idempotency-key");
    if (!key || key.length < 8 || key.length > 200)
      throw new PandocsError(400, "IDEMPOTENCY_KEY_REQUIRED", t("Writing to a document needs an Idempotency-Key"));
    const hash = createHash("sha256")
      .update(`${request.method} ${new URL(request.url).pathname} ${await context.text()}`)
      .digest("hex");
    const db = services.context.db;
    // The key is claimed before anything runs, so that a second request with it, even one at the same moment, never runs
    // it again. A claim left by a process that died part of the way is taken over after a while.
    const { rows: claimed } = await db.query(
      `INSERT INTO pandocs.idempotency_keys (principal_id, key, request_hash, status, response) VALUES ($1, $2, $3, 0, 'null')
       ON CONFLICT (principal_id, key) DO UPDATE SET created_at = now()
         WHERE idempotency_keys.status = 0 AND idempotency_keys.request_hash = EXCLUDED.request_hash AND idempotency_keys.created_at < now() - interval '5 minutes'
       RETURNING 1`,
      [principal.id, key, hash]
    );
    if (!claimed[0]) {
      const { rows } = await db.query<{ request_hash: string; status: number; response: unknown }>(
        `SELECT request_hash, status, response FROM pandocs.idempotency_keys WHERE principal_id = $1 AND key = $2`,
        [principal.id, key]
      );
      if (rows[0] && rows[0].request_hash !== hash)
        throw new PandocsError(409, "IDEMPOTENCY_KEY_REUSED", t("This Idempotency-Key was used for another request"));
      if (!rows[0] || rows[0].status === 0)
        throw new PandocsError(
          409,
          "IDEMPOTENCY_KEY_IN_USE",
          t("A request with this Idempotency-Key is still being handled. Try again in a moment.")
        );
      return Response.json(rows[0].response, {
        status: rows[0].status,
        headers: { ...NO_STORE, "Idempotent-Replay": "true" }
      });
    }
    // What did not happen may be asked for again with the same key.
    const release = () =>
      db.query(`DELETE FROM pandocs.idempotency_keys WHERE principal_id = $1 AND key = $2 AND status = 0`, [
        principal.id,
        key
      ]);
    let result: Awaited<ReturnType<RouteHandler>>;
    try {
      result = await handler(context);
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
    if (isResponse(result)) {
      await release();
      return result;
    }
    const status = result.status ?? 200;
    const body = envelope(result.data);
    await db.query(
      `UPDATE pandocs.idempotency_keys SET status = $3, response = $4 WHERE principal_id = $1 AND key = $2`,
      [principal.id, key, status, JSON.stringify(body)]
    );
    return Response.json(body, { status, headers: NO_STORE });
  };
}

const envelope = (data: unknown) => ({ version: 1, data });

/**
 * What someone with no login may reach, which is only ever reading pages. Anything not listed stays closed, including
 * routes added later: discussions and history can hold what a page's authors never meant to publish.
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "GET blocks",
  "GET bootstrap",
  "GET search",
  "GET static/:file",
  "GET llms.txt",
  "GET llms-full.txt",
  "GET spaces",
  "GET spaces/:space",
  "GET spaces/:space/tree",
  "GET spaces/:space/resolve",
  "GET spaces/:space/llms.txt",
  "GET spaces/:space/llms-full.txt",
  "GET spaces/:space/assets/*",
  "GET documents/:id",
  "GET documents/:id/content",
  "GET documents/:id/translations",
  "GET documents/:id/translations/:lang",
  "GET spaces/:space/labels",
  // The only things someone with no login can leave behind, each with its own limit. `POST ask` also takes the site's say-so.
  "POST ask",
  "POST ask/:id/rating",
  "POST stats/views",
  "POST stats/searches",
  "POST documents/:id/feedback",
  "PATCH documents/:id/feedback/:feedback"
]);

/** What a share link is for: reading its pages. Pages know not to ask for more, and what asks anyway finds nothing here. */
const SHARED_ROUTES: ReadonlySet<string> = new Set([
  "GET blocks",
  "GET bootstrap",
  "GET spaces/:space/resolve",
  "GET spaces/:space/assets/*",
  "GET documents/:id",
  "GET documents/:id/content",
  "GET documents/:id/translations",
  "GET documents/:id/translations/:lang"
]);

/** The page is public. Who wrote it, what they said when saving and who is editing it now are not. */
const VISITOR_CACHE_MS = 5000;
const visitorCaches = new WeakMap<PandocsServices, Map<string, { until: number; value: Promise<unknown> }>>();

/** These are the most expensive answers, and every visitor gets the same one, so a burst of them is one piece of work. */
function sharedByVisitors<T>(services: PandocsServices, key: string, load: () => Promise<T>): Promise<T> {
  let cache = visitorCaches.get(services);
  if (!cache) {
    cache = new Map();
    visitorCaches.set(services, cache);
  }
  const found = cache.get(key);
  if (found && found.until > Date.now()) return found.value as Promise<T>;
  const value = load();
  const entries = cache;
  entries.set(key, { until: Date.now() + VISITOR_CACHE_MS, value });
  value.catch(() => entries.delete(key));
  return value;
}

/** For someone with no login, every visitor's answer is the same, so a crawler asking again and again costs one. */
const forVisitors = <T>(
  principal: Principal,
  services: PandocsServices,
  key: string,
  load: () => Promise<T>
): Promise<T> => (principal.anonymous && !principal.shared ? sharedByVisitors(services, key, load) : load());

const withoutSource = <T extends { sourceText: unknown }>({ sourceText: _sourceText, ...job }: T) => job;

const routes: readonly Route[] = [
  route("GET", "tools", async () => ok(describeTools())),
  route("POST", "tools/:name", async ({ params, principal, services, json }) => {
    const tool = pandocsTools.find(item => item.name === params.name);
    if (!tool) throw notFound(t("Tool"));
    const args = await json(tool.input);
    return ok(await tool.run(services, principal, args as never));
  }),
  route("GET", "blocks", async ({ services }) => ok(describeBlocks(services.context.registry))),
  route("GET", "me", async ({ principal }) =>
    ok({
      id: principal.id,
      displayName: principal.displayName,
      kind: principal.kind,
      isAdmin: principal.isAdmin,
      scopes: principal.scopes
    })
  ),
  route("GET", "me/drafts", async ({ principal, services }) =>
    ok([...(await services.documents.myDrafts(principal)), ...(await services.live.mine(principal))])
  ),
  route("GET", "me/inbox", async ({ principal, services }) =>
    ok({ ...(await services.threads.inbox(principal)), changeSets: await services.changeSets.waitingFor(principal) })
  ),
  route("GET", "me/subscriptions", async ({ principal, services }) => ok(await services.subscriptions.list(principal))),
  route("POST", "me/inbox/read", async ({ principal, services, json }) => {
    const { ids } = await json(
      z.object({ ids: z.union([z.array(z.string().uuid()).max(200), z.literal("all")]) }).strict()
    );
    await services.threads.markRead(principal, ids);
    return ok({ ok: true });
  }),
  route("GET", "directory", async ({ query, principal, services }) => {
    const directory = services.context.ports.directory;
    // Who works here is not for visitors from another system to look through.
    return ok(directory && !principal.guest ? await directory.search(query.get("q") ?? "", 20) : []);
  }),
  route("GET", "search", async ({ query, principal, services }) => {
    // Searching in the site's own language, or one it does not have, is searching what pages say.
    const lang = query.get("lang");
    const site = lang ? await services.site.get() : undefined;
    const translated =
      site && lang !== site.defaultLang && site.locales.some(locale => locale.lang === lang) ? lang! : undefined;
    const input = {
      query: query.get("q") ?? "",
      space: query.get("space") ?? undefined,
      label: query.get("label") ?? undefined,
      lang: translated
    };
    const hits = await services.documents.search(principal, input);
    // The search box in a browser says what was searched for once someone stops typing; this is for programs.
    if (!principal.anonymous && audienceOf(principal) === "agent")
      services.stats.countSearch({ term: input.query, results: hits.length, audience: "agent", space: input.space });
    return ok(hits);
  }),

  route("GET", "bootstrap", async ({ principal, services }) =>
    ok(
      await (principal.anonymous && !principal.shared
        ? sharedByVisitors(services, "bootstrap", () => bootstrapFor(services, principal))
        : bootstrapFor(services, principal))
    )
  ),
  route("GET", "changes", async ({ query, principal, services }) => {
    const since = query.get("since") ?? "0";
    if (!validCursor(since)) throw invalid("PARAM_INVALID", t("since should be the next value from the last answer"));
    return ok(
      await services.changes.since(principal, {
        since,
        space: query.get("space") ?? undefined,
        limit: optionalInt(query.get("limit"), "limit")
      })
    );
  }),
  route("GET", "static/:file", async ({ params, principal, services }) => {
    const match = SEARCH_INDEX_FILE.exec(params.file!);
    if (!match) throw notFound(t("Asset"));
    const site = await services.site.get();
    const lang = match[1] ?? site.defaultLang;
    const build = async () =>
      services.documents.searchIndex(
        services.translations,
        lang,
        lang === site.defaultLang ? "" : `/${lang}`,
        await visibleSpaces(services, principal)
      );
    return ok(
      undefined,
      200,
      await (principal.anonymous ? sharedByVisitors(services, `index:${params.file!}`, build) : build())
    );
  }),
  route("GET", "site", async ({ services }) => ok(await services.site.get())),
  route("PATCH", "site", async ({ principal, services, json }) =>
    ok(await services.site.update(principal, await json(siteSettingsSchema.partial())))
  ),

  route("GET", "llms.txt", async ({ principal, services }) =>
    text200(await forVisitors(principal, services, "llms.txt", () => services.llms.index(principal)))
  ),
  route("GET", "llms-full.txt", async ({ principal, services }) =>
    text200(await forVisitors(principal, services, "llms-full.txt", () => services.llms.full(principal)))
  ),
  route("GET", "spaces/:space/llms.txt", async ({ params, principal, services }) =>
    text200(
      await forVisitors(principal, services, `llms.txt:${params.space}`, () =>
        services.llms.index(principal, params.space!)
      )
    )
  ),
  route("GET", "spaces/:space/llms-full.txt", async ({ params, principal, services }) =>
    text200(
      await forVisitors(principal, services, `llms-full.txt:${params.space}`, () =>
        services.llms.full(principal, params.space!)
      )
    )
  ),
  route("GET", "audit", async ({ query, principal, services }) =>
    ok(await services.audit.forSite(principal, auditQuery(query)))
  ),
  route("POST", "ask", async ({ json, principal, services }) => services.ask.respond(principal, await json(askInput))),
  route("POST", "ask/:id/rating", async ({ params, json, services }) => {
    const { helpful } = await json(z.object({ helpful: z.boolean() }).strict());
    if (!UUID.test(params.id!)) throw notFound(t("Question"));
    await services.stats.rateAnswer(params.id!, helpful);
    return ok({ ok: true });
  }),
  route("POST", "stats/views", async ({ json, principal, services }) => {
    const { document } = await json(z.object({ document: z.string().uuid() }).strict());
    // Only for what this person can open, so that nobody can make up numbers for what they cannot.
    await services.documents.read(principal, document, { scope: { scope: "outline" } });
    services.stats.countView(document, "person");
    return ok({ ok: true });
  }),
  route("POST", "stats/searches", async ({ json, services }) => {
    const { term, results, space } = await json(
      z
        .object({
          term: z.string().min(1).max(200),
          results: z.number().int().min(0),
          space: z.string().max(100).optional()
        })
        .strict()
    );
    services.stats.countSearch({ term, results, space, audience: "person" });
    return ok({ ok: true });
  }),
  route("GET", "insights", async ({ query, principal, services }) =>
    ok(await services.stats.insights(principal, { days: insightDays(query) }))
  ),
  route("GET", "feedback", async ({ query, principal, services }) =>
    ok(await services.feedback.list(principal, { status: feedbackStatus(query) }))
  ),
  route("POST", "feedback/:id/resolve", async ({ params, principal, services, json }) => {
    const { resolved } = await json(z.object({ resolved: z.boolean().default(true) }).strict());
    await services.feedback.resolve(principal, params.id!, resolved);
    return ok({ ok: true });
  }),
  route("GET", "deleted-spaces", async ({ principal, services }) => ok(await services.spaces.deleted(principal))),
  route("POST", "deleted-spaces/:id/restore", async ({ params, principal, services, json }) =>
    ok(
      await services.spaces.restore(
        principal,
        params.id!,
        await json(z.object({ slug: SPACE_SLUG.optional() }).strict())
      )
    )
  ),
  route("GET", "spaces", async ({ principal, services }) => ok(await services.spaces.list(principal))),
  route("POST", "spaces", async ({ principal, services, json }) => {
    const input = await json(
      z
        .object({
          slug: SPACE_SLUG,
          name: nameText(120),
          description: z.string().max(2000).optional(),
          defaultRole: z.enum(["none", "viewer", "commenter", "editor", "admin"]).optional()
        })
        .strict()
    );
    return ok(await services.spaces.create(principal, input), 201);
  }),
  route("GET", "spaces/:space", async ({ params, principal, services }) =>
    ok(await services.spaces.get(principal, params.space!))
  ),
  route("PATCH", "spaces/:space", async ({ params, principal, services, json }) => {
    const patch = await json(
      z
        .object({
          name: nameText(120).optional(),
          description: z.string().max(2000).optional(),
          defaultRole: z.enum(["none", "viewer", "commenter", "editor", "admin"]).optional(),
          publicRead: z.boolean().optional(),
          mergeRules: z
            .object({ requiredApprovals: z.number().int().min(0).max(10), requireChangeSets: z.boolean() })
            .strict()
            .optional(),
          glossary: z
            .array(
              z
                .object({ term: z.string().trim().min(1).max(80), definition: z.string().trim().min(1).max(1000) })
                .strict()
            )
            .max(500)
            .optional()
        })
        .strict()
    );
    return ok(await services.spaces.update(principal, params.space!, patch));
  }),
  route("DELETE", "spaces/:space", async ({ params, principal, services }) => {
    await services.spaces.remove(principal, params.space!);
    return ok({ deleted: true });
  }),
  route("GET", "spaces/:space/audit", async ({ params, query, principal, services }) =>
    ok(await services.audit.forSpace(principal, params.space!, auditQuery(query)))
  ),
  route("GET", "spaces/:space/insights", async ({ params, query, principal, services }) =>
    ok(await services.stats.insights(principal, { space: params.space!, days: insightDays(query) }))
  ),
  route("GET", "spaces/:space/feedback", async ({ params, query, principal, services }) =>
    ok(await services.feedback.list(principal, { space: params.space!, status: feedbackStatus(query) }))
  ),
  route("GET", "spaces/:space/trash", async ({ params, principal, services }) =>
    ok(await services.tree.trash(principal, params.space!))
  ),
  route("DELETE", "spaces/:space/trash", async ({ params, principal, services }) =>
    ok(await services.tree.emptyTrash(principal, params.space!))
  ),
  route("POST", "spaces/:space/archive", async ({ params, request, principal, services }) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) throw invalid("ARCHIVE_INVALID", t("There is no archive to import"));
    if (bytes.byteLength > MAX_ASSET_BYTES) throw invalid("ARCHIVE_TOO_LARGE", t("The archive is larger than 100 MiB"));
    return ok(await services.archives.import(principal, params.space!, bytes));
  }),
  route("GET", "spaces/:space/export", async ({ params, principal, services }) => {
    const { filename, bytes } = await services.export.space(principal, params.space!);
    return new Response(bytes as BodyInit, {
      headers: {
        ...NO_STORE,
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${filename}"`
      }
    });
  }),
  route("GET", "spaces/:space/members", async ({ params, principal, services }) =>
    ok(await services.spaces.members(principal, params.space!))
  ),
  route("PUT", "spaces/:space/members", async ({ params, principal, services, json }) => {
    const { subject, role } = await json(z.object({ subject: z.string().min(1), role: roleEnum.nullable() }).strict());
    return ok(await services.spaces.setMember(principal, params.space!, subject, role));
  }),
  route("GET", "spaces/:space/labels", async ({ params, principal, services }) =>
    ok(await services.documents.spaceLabels(principal, params.space!))
  ),
  route("PUT", "spaces/:space/subscription", async ({ params, principal, services }) => {
    await services.subscriptions.followSpace(principal, params.space!, true);
    return ok({ following: true });
  }),
  route("DELETE", "spaces/:space/subscription", async ({ params, principal, services }) => {
    await services.subscriptions.followSpace(principal, params.space!, false);
    return ok({ following: false });
  }),
  route("GET", "spaces/:space/templates", async ({ params, principal, services }) =>
    ok(await services.templates.list(principal, params.space!))
  ),
  route("POST", "spaces/:space/templates", async ({ params, principal, services, json }) =>
    ok(await services.templates.create(principal, params.space!, await json(templateInput)), 201)
  ),
  route("PATCH", "templates/:id", async ({ params, principal, services, json }) =>
    ok(await services.templates.update(principal, params.id!, await json(templateInput.partial())))
  ),
  route("DELETE", "templates/:id", async ({ params, principal, services }) => {
    await services.templates.remove(principal, params.id!);
    return ok({ deleted: true });
  }),
  route("GET", "spaces/:space/change-sets", async ({ params, query, principal, services }) =>
    ok(await services.changeSets.list(principal, params.space!, changeSetStatus(query)))
  ),
  route("POST", "spaces/:space/change-sets", async ({ params, principal, services, json }) =>
    ok(await services.changeSets.create(principal, params.space!, await json(changeSetInput)), 201)
  ),
  route("GET", "change-sets/:id", async ({ params, principal, services }) =>
    ok(await services.changeSets.get(principal, params.id!))
  ),
  route("PATCH", "change-sets/:id", async ({ params, principal, services, json }) =>
    ok(await services.changeSets.update(principal, params.id!, await json(changeSetInput.partial())))
  ),
  route("POST", "change-sets/:id/pages", async ({ params, principal, services, json }) =>
    ok(await services.changeSets.putPage(principal, params.id!, await json(changeSetPageInput)), 201)
  ),
  route("DELETE", "change-sets/:id/pages/:page", async ({ params, principal, services }) => {
    await services.changeSets.removePage(principal, params.id!, params.page!);
    return ok({ removed: true });
  }),
  route("POST", "change-sets/:id/reviews", async ({ params, principal, services, json }) =>
    ok(await services.changeSets.review(principal, params.id!, await json(reviewInput)))
  ),
  route("POST", "change-sets/:id/merge", async ({ params, principal, services }) =>
    ok(await services.changeSets.merge(principal, params.id!))
  ),
  route("POST", "change-sets/:id/close", async ({ params, principal, services }) =>
    ok(await services.changeSets.close(principal, params.id!))
  ),
  route("POST", "change-sets/:id/reopen", async ({ params, principal, services }) =>
    ok(await services.changeSets.reopen(principal, params.id!))
  ),
  route("DELETE", "change-sets/:id", async ({ params, principal, services }) =>
    ok(await services.changeSets.delete(principal, params.id!))
  ),
  route("GET", "spaces/:space/git-sync", async ({ params, principal, services }) =>
    ok(await services.gitSync.get(principal, params.space!))
  ),
  route("PUT", "spaces/:space/git-sync", async ({ params, principal, services, json }) =>
    ok(await services.gitSync.put(principal, params.space!, await json(gitSyncInput)))
  ),
  route("DELETE", "spaces/:space/git-sync", async ({ params, principal, services }) => {
    await services.gitSync.remove(principal, params.space!);
    return ok({ removed: true });
  }),
  route("POST", "spaces/:space/git-sync/run", async ({ params, principal, services }) => {
    await services.gitSync.runNow(principal, params.space!);
    return ok({ queued: true });
  }),
  route("GET", "spaces/:space/git-sync/runs", async ({ params, principal, services }) =>
    ok(await services.gitSync.runs(principal, params.space!))
  ),
  route("GET", "spaces/:space/webhooks", async ({ params, principal, services }) =>
    ok(await services.webhooks.list(principal, params.space!))
  ),
  route("POST", "spaces/:space/webhooks", async ({ params, principal, services, json }) =>
    ok(await services.webhooks.create(principal, params.space!, await json(webhookInput)), 201)
  ),
  route("GET", "webhooks", async ({ principal, services }) => ok(await services.webhooks.list(principal, null))),
  route("POST", "webhooks", async ({ principal, services, json }) =>
    ok(await services.webhooks.create(principal, null, await json(webhookInput)), 201)
  ),
  route("PATCH", "webhooks/:id", async ({ params, principal, services, json }) =>
    ok(await services.webhooks.update(principal, params.id!, await json(webhookInput.partial())))
  ),
  route("DELETE", "webhooks/:id", async ({ params, principal, services }) => {
    await services.webhooks.remove(principal, params.id!);
    return ok({ deleted: true });
  }),
  route("POST", "webhooks/:id/test", async ({ params, principal, services }) =>
    ok(await services.webhooks.test(principal, params.id!))
  ),
  route("GET", "webhooks/:id/deliveries", async ({ params, principal, services }) =>
    ok(await services.webhooks.deliveries(principal, params.id!))
  ),
  route("POST", "webhooks/:id/deliveries/:delivery/retry", async ({ params, principal, services }) =>
    ok(await services.webhooks.retry(principal, params.id!, params.delivery!))
  ),
  route("GET", "spaces/:space/tree", async ({ params, principal, services }) =>
    ok(await services.documents.tree(principal, params.space!))
  ),
  route("GET", "spaces/:space/resolve", async ({ params, query, principal, services }) =>
    ok(await services.documents.resolve(principal, params.space!, query.get("path") ?? ""))
  ),
  route("POST", "spaces/:space/documents", async ({ params, principal, services, json }) => {
    const input = await json(
      z
        .object({
          title: nameText(200),
          markdown: z.string().default(""),
          template: z.string().optional(),
          parentPath: z.string().optional(),
          slug: z.string().optional(),
          sortOrder: sortOrder.optional(),
          restricted: z.boolean().optional(),
          message: z.string().max(500).optional(),
          strict: z.boolean().optional()
        })
        .strict()
    );
    return ok(
      await services.documents.create(principal, await fromTemplate(services, principal, params.space!, input)),
      201
    );
  }),
  route("POST", "spaces/:space/assets", async ({ params, query, request, principal, services }) => {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_ASSET_BYTES) throw invalid("ASSET_TOO_LARGE", t("The file is larger than 100 MiB"));
    const bytes = new Uint8Array(await request.arrayBuffer());
    return ok(await services.assets.put(principal, params.space!, bytes, query.get("filename") ?? ""), 201);
  }),
  route("GET", "spaces/:space/manifest", async ({ params, principal, services }) =>
    ok(await services.changes.manifest(principal, params.space!))
  ),
  route("GET", "spaces/:space/snapshot", async ({ params, principal, services }) => {
    const manifest = await services.changes.manifest(principal, params.space!);
    return new Response(services.changes.archive(manifest), {
      headers: {
        ...NO_STORE,
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${manifest.space.slug}.tar.gz"`,
        "X-Pandocs-Cursor": manifest.cursor
      }
    });
  }),
  route("GET", "spaces/:space/assets/*", async ({ params, principal, services }) => {
    const sha256 = (params.rest ?? "").replace(/\.[a-z0-9]+$/iu, "");
    if (!/^[a-f0-9]{64}$/iu.test(sha256)) throw notFound(t("Asset"));
    const { record, bytes } = await services.assets.get(principal, params.space!, sha256);
    const inline = record.mime.startsWith("image/") || record.mime.startsWith("video/");
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": record.mime,
        "Content-Length": String(bytes.byteLength),
        // Addressed by content, so it never changes; `private` because every read is authorised.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": inline
          ? "inline"
          : `attachment; filename*=UTF-8''${encodeURIComponent(record.filename || sha256)}`
      }
    });
  }),
  route("GET", "spaces/:space/bulk-imports", async ({ params, principal, services }) =>
    ok(await services.bulkImports.list(principal, params.space!))
  ),
  route("POST", "spaces/:space/bulk-imports", async ({ params, request, principal, services, json }) => {
    if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_ASSET_BYTES) throw invalid("ASSET_TOO_LARGE", t("The file is larger than 100 MiB"));
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw invalid("INGEST_EMPTY", t("There is no file to import"));
      if (file.size > MAX_ASSET_BYTES) throw invalid("ASSET_TOO_LARGE", t("The file is larger than 100 MiB"));
      const parentPath = form.get("parentPath");
      return ok(
        await services.bulkImports.submit(principal, params.space!, {
          source: String(form.get("source") ?? ""),
          bytes: new Uint8Array(await file.arrayBuffer()),
          filename: file.name,
          ...(typeof parentPath === "string" && parentPath ? { parentPath } : {})
        }),
        201
      );
    }
    const input = await json(
      z
        .object({
          source: z.string().min(1).max(40),
          url: z.string().max(2000),
          includeChildren: z.boolean().optional(),
          parentPath: z.string().optional()
        })
        .strict()
    );
    return ok(await services.bulkImports.submit(principal, params.space!, input), 201);
  }),
  route("GET", "spaces/:space/imports", async ({ params, principal, services }) =>
    ok((await services.ingest.list(principal, params.space!)).map(withoutSource))
  ),
  route("POST", "spaces/:space/imports", async ({ params, request, principal, services, text }) => {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw invalid("INGEST_EMPTY", t("There is no file to import"));
      if (file.size > MAX_ASSET_BYTES) throw invalid("ASSET_TOO_LARGE", t("The file is larger than 100 MiB"));
      const target = JSON.parse(String(form.get("target") ?? "{}")) as Record<string, unknown>;
      const job = await services.ingest.submit(principal, {
        space: params.space!,
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        contentType: file.type,
        target: ingestTarget.parse(target)
      });
      return ok(withoutSource(job), 201);
    }
    const input = ingestBody.parse(JSON.parse(await text()));
    const job = await services.ingest.submit(principal, {
      space: params.space!,
      target: input.target,
      contentType: input.contentType,
      filename: input.filename,
      markdown: input.markdown,
      metadata: input.metadata,
      channel: input.channel,
      bytes: input.contentBase64 ? Buffer.from(input.contentBase64, "base64") : undefined
    });
    return ok(withoutSource(job), 201);
  }),

  route("GET", "documents/:id", async ({ params, query, principal, services }) => {
    if (principal.anonymous && query.has("revision")) throw notFound(t("Document"));
    const view = await services.documents.read(principal, params.id!, {
      scope: scopeFrom(query),
      revision: optionalInt(query.get("revision"), "revision")
    });
    // A page in a browser says when it has been read; this is for programs. A visitor's request says nothing about which it is.
    if (!principal.anonymous && audienceOf(principal) === "agent") services.stats.countView(view.document.id, "agent");
    return ok(principal.anonymous ? withoutPeople(view) : view);
  }),
  route("GET", "documents/:id/content", async ({ params, query, principal, services }) => {
    if (principal.anonymous && query.has("revision")) throw notFound(t("Document"));
    const view = await services.documents.read(principal, params.id!, {
      revision: optionalInt(query.get("revision"), "revision")
    });
    if (!principal.anonymous && audienceOf(principal) === "agent") services.stats.countView(view.document.id, "agent");
    return new Response(view.markdown ?? "", {
      headers: {
        ...NO_STORE,
        "Content-Type": "text/markdown; charset=utf-8",
        ETag: `"${view.revision.sha256}"`,
        "X-Pandocs-Revision": String(view.revision.no)
      }
    });
  }),
  route("POST", "documents/:id/feedback", async ({ params, principal, services, json }) =>
    ok(await services.feedback.leave(principal, params.id!, await json(feedbackInput)), 201)
  ),
  route("PATCH", "documents/:id/feedback/:feedback", async ({ params, principal, services, json }) => {
    const { body } = await json(feedbackBody);
    await services.feedback.explain(principal, params.id!, params.feedback!, body);
    return ok({ ok: true });
  }),
  route("GET", "documents/:id/share-links", async ({ params, principal, services }) =>
    ok(await services.shareLinks.list(principal, params.id!))
  ),
  route("POST", "documents/:id/share-links", async ({ params, principal, services, json }) =>
    ok(await services.shareLinks.create(principal, params.id!, await json(shareLinkInput)), 201)
  ),
  route("DELETE", "share-links/:id", async ({ params, principal, services }) => {
    await services.shareLinks.revoke(principal, params.id!);
    return ok({ revoked: true });
  }),
  route("PUT", "documents/:id/labels", async ({ params, principal, services, json }) => {
    const { labels } = await json(z.object({ labels: documentLabels }).strict());
    return ok({ labels: await services.documents.setLabels(principal, params.id!, labels) });
  }),
  route("GET", "documents/:id/subscription", async ({ params, principal, services }) =>
    ok(await services.subscriptions.ofDocument(principal, params.id!))
  ),
  route("PUT", "documents/:id/subscription", async ({ params, principal, services }) => {
    await services.subscriptions.followDocument(principal, params.id!, true);
    return ok({ following: true });
  }),
  route("DELETE", "documents/:id/subscription", async ({ params, principal, services }) => {
    await services.subscriptions.followDocument(principal, params.id!, false);
    return ok({ following: false });
  }),
  route("PATCH", "documents/:id", async ({ params, principal, services, json }) => {
    const patch = await json(
      z
        .object({
          title: nameText(200).optional(),
          sortOrder: sortOrder.optional(),
          restricted: z.boolean().optional()
        })
        .strict()
    );
    return ok(await services.documents.updateMeta(principal, params.id!, patch));
  }),
  route("DELETE", "documents/:id", async ({ params, query, principal, services }) => {
    await services.tree.remove(principal, params.id!, { recursive: query.get("recursive") === "true" });
    return ok({ deleted: true });
  }),
  route("POST", "documents/:id/move", async ({ params, principal, services, json }) =>
    ok(
      await services.tree.move(
        principal,
        params.id!,
        await json(
          z
            .object({
              parentId: z.string().uuid().nullable().optional(),
              beforeId: z.string().uuid().nullable().optional(),
              slug: z.string().min(1).max(120).optional()
            })
            .strict()
        )
      )
    )
  ),
  route("POST", "documents/:id/restore", async ({ params, principal, services }) =>
    ok(await services.tree.restore(principal, params.id!))
  ),
  route("DELETE", "documents/:id/purge", async ({ params, principal, services }) => {
    await services.tree.purge(principal, params.id!);
    return ok({ deleted: true });
  }),
  route(
    "PUT",
    "documents/:id/content",
    idempotent(async ({ params, principal, services, json }) =>
      ok(await services.documents.saveContent(principal, params.id!, await json(contentSchema)))
    )
  ),
  route(
    "POST",
    "documents/:id/ops",
    idempotent(async ({ params, principal, services, json }) =>
      ok(await services.documents.applyOps(principal, params.id!, await json(opsSchema)))
    )
  ),
  route(
    "POST",
    "documents/:id/rollback",
    idempotent(async ({ params, principal, services, json }) =>
      ok(
        await services.documents.rollback(
          principal,
          params.id!,
          await json(
            z.object({ to: z.number().int().positive(), expectedRevision: z.number().int().positive() }).strict()
          )
        )
      )
    )
  ),
  route("GET", "documents/:id/revisions", async ({ params, query, principal, services }) =>
    ok(
      await services.documents.revisions(
        principal,
        params.id!,
        optionalInt(query.get("limit"), "limit"),
        optionalInt(query.get("before"), "before")
      )
    )
  ),
  route("GET", "documents/:id/revisions/:no", async ({ params, principal, services }) => {
    const { visibleText: _visibleText, ...revision } = await services.documents.revisionContent(
      principal,
      params.id!,
      intParam(params.no, "no")
    );
    return ok(revision);
  }),
  route("GET", "documents/:id/diff", async ({ params, query, principal, services }) =>
    ok(
      await services.documents.diff(
        principal,
        params.id!,
        intParam(query.get("from"), "from"),
        intParam(query.get("to"), "to")
      )
    )
  ),
  route("GET", "documents/:id/draft", async ({ params, query, principal, services }) =>
    ok(await services.documents.draft(principal, params.id!, draftLang(query)))
  ),
  route("PUT", "documents/:id/draft", async ({ params, query, principal, services, json }) =>
    ok(
      await services.documents.saveDraft(
        principal,
        params.id!,
        await json(
          z
            .object({
              markdown: z.string(),
              baseRevision: z.number().int().positive(),
              title: z.string().max(200).optional()
            })
            .strict()
        ),
        draftLang(query)
      )
    )
  ),
  route("DELETE", "documents/:id/draft", async ({ params, query, principal, services }) => {
    await services.documents.deleteDraft(principal, params.id!, draftLang(query));
    return ok({ deleted: true });
  }),
  route("POST", "documents/:id/draft/assist", async ({ params, query, principal, services, json }) =>
    ok(
      await services.assist.assistOnDraft(principal, params.id!, {
        ...(await json(
          z
            .object({
              action: z.enum(ASSIST_ACTIONS),
              quote: z.string().min(1).max(8000),
              markdown: z.string().max(MOST_DRAFT_CHARS).optional()
            })
            .strict()
        )),
        lang: draftLang(query)
      })
    )
  ),
  route("POST", "documents/:id/live", async ({ params, principal, services }) =>
    ok(await services.live.open(principal, params.id!))
  ),
  route("GET", "documents/:id/live", async ({ params, principal, services }) =>
    ok(await services.live.status(principal, params.id!))
  ),
  route("DELETE", "documents/:id/live", async ({ params, principal, services }) => {
    await services.live.discard(principal, params.id!);
    return ok({ discarded: true });
  }),
  route("POST", "documents/:id/editing", async ({ params, principal, services, json }) => {
    const { editing } = await json(z.object({ editing: z.boolean() }).strict());
    return ok({ other: await services.documents.setEditing(principal, params.id!, editing) });
  }),
  route("GET", "documents/:id/members", async ({ params, principal, services }) =>
    ok(await services.documents.documentMembers(principal, params.id!))
  ),
  route("PUT", "documents/:id/members", async ({ params, principal, services, json }) => {
    const { subject, role } = await json(
      z.object({ subject: z.string().regex(/^(?:user:.+|group:.+|everyone)$/u), role: roleEnum.nullable() }).strict()
    );
    return ok(await services.documents.setDocumentMember(principal, params.id!, subject, role));
  }),

  route("GET", "documents/:id/threads", async ({ params, query, principal, services }) => {
    const status = query.get("status");
    if (status !== null && status !== "open" && status !== "resolved")
      throw invalid("PARAM_INVALID", t("status can only be open or resolved"));
    return ok(await services.threads.list(principal, params.id!, status ?? undefined));
  }),
  route("POST", "documents/:id/threads", async ({ params, principal, services, json }) => {
    const input = await json(
      z.object({ anchor: anchorSchema, body: z.string().min(1).max(20000), mentions: mentionsSchema }).strict()
    );
    return ok(await services.threads.create(principal, params.id!, input), 201);
  }),
  route("GET", "documents/:id/translations", async ({ params, principal, services }) => {
    const list = await services.translations.list(principal, params.id!);
    return ok(principal.anonymous ? list.map(item => ({ ...item, updatedName: "" })) : list);
  }),
  route("GET", "documents/:id/translations/:lang", async ({ params, principal, services }) => {
    const found = await services.translations.get(principal, params.id!, params.lang!);
    return ok(principal.anonymous ? { ...found, updatedName: "" } : found);
  }),
  route("PUT", "documents/:id/translations/:lang", async ({ params, principal, services, json }) =>
    ok(
      await services.translations.save(
        principal,
        params.id!,
        params.lang!,
        await json(
          z
            .object({
              title: nameText(200),
              markdown: z.string(),
              sourceRevision: z.number().int().positive(),
              machine: z.boolean().optional(),
              base: z
                .object({
                  updatedAt: z.string().datetime({ offset: true }),
                  markdown: z.string(),
                  title: z.string().optional()
                })
                .strict()
                .optional()
            })
            .strict()
        )
      )
    )
  ),
  route("DELETE", "documents/:id/translations/:lang", async ({ params, principal, services }) => {
    await services.translations.remove(principal, params.id!, params.lang!);
    return ok({ deleted: true });
  }),
  route("POST", "documents/:id/translations/:lang/generate", async ({ params, principal, services, json }) =>
    ok(
      await services.translations.generate(
        principal,
        params.id!,
        params.lang!,
        await json(
          z.union([
            z.object({ from: z.string().min(1), to: z.string().min(1) }).strict(),
            z.object({ title: z.literal(true) }).strict()
          ])
        )
      )
    )
  ),
  route("POST", "documents/:id/assist", async ({ params, principal, services, json }) =>
    ok(
      await services.assist.assist(
        principal,
        params.id!,
        await json(
          z
            .object({
              action: z.enum(ASSIST_ACTIONS),
              start: z.number().int().min(0),
              end: z.number().int().positive(),
              revision: z.number().int().positive().optional()
            })
            .strict()
        )
      )
    )
  ),
  route("POST", "documents/:id/threads/summary", async ({ params, principal, services }) =>
    ok(await services.threads.summarizeDocument(principal, params.id!))
  ),
  route("GET", "threads/:id", async ({ params, principal, services }) =>
    ok(await services.threads.get(principal, params.id!))
  ),
  route("POST", "threads/:id/comments", async ({ params, principal, services, json }) =>
    ok(
      await services.threads.reply(
        principal,
        params.id!,
        await json(z.object({ body: z.string().min(1).max(20000), mentions: mentionsSchema }).strict())
      ),
      201
    )
  ),
  route("POST", "threads/:id/resolve", async ({ params, principal, services }) =>
    ok(await services.threads.setStatus(principal, params.id!, "resolved"))
  ),
  route("POST", "threads/:id/reopen", async ({ params, principal, services }) =>
    ok(await services.threads.setStatus(principal, params.id!, "open"))
  ),
  route("POST", "threads/:id/suggestion", async ({ params, principal, services }) =>
    ok(await services.assist.suggestFromThread(principal, params.id!))
  ),
  route("POST", "threads/:id/summary", async ({ params, principal, services }) =>
    ok(await services.threads.summarizeThread(principal, params.id!))
  ),
  route("PATCH", "comments/:id", async ({ params, principal, services, json }) =>
    ok(
      await services.threads.updateComment(
        principal,
        params.id!,
        await json(z.object({ body: z.string().min(1).max(20000), mentions: mentionsSchema }).strict())
      )
    )
  ),
  route("POST", "comments/:id/reactions", async ({ params, principal, services, json }) =>
    ok(
      await services.threads.react(
        principal,
        params.id!,
        await json(z.object({ emoji: z.string().min(1).max(16), active: z.boolean() }).strict())
      )
    )
  ),
  route("DELETE", "comments/:id", async ({ params, principal, services }) => {
    await services.threads.deleteComment(principal, params.id!);
    return ok({ deleted: true });
  }),

  route("GET", "documents/:id/proposals", async ({ params, query, principal, services }) => {
    const status = query.get("status");
    if (status !== null && !["pending", "accepted", "rejected"].includes(status))
      throw invalid("PARAM_INVALID", t("status is not valid"));
    return ok(await services.proposals.list(principal, params.id!, (status ?? undefined) as never));
  }),
  route("POST", "documents/:id/proposals", async ({ params, principal, services, json }) => {
    const input = await json(
      z
        .object({
          baseRevision: z.number().int().positive(),
          ops: z.array(editOpSchema).min(1).max(100).optional(),
          markdown: z
            .string()
            .max(4 * 1024 * 1024)
            .optional(),
          rationale: z.string().max(2000).optional(),
          threadIds: z.array(z.string().uuid()).max(50).optional()
        })
        .strict()
    );
    return ok(await services.proposals.create(principal, params.id!, input), 201);
  }),
  route("GET", "proposals/:id", async ({ params, principal, services }) =>
    ok(await services.proposals.get(principal, params.id!))
  ),
  route(
    "POST",
    "proposals/:id/decide",
    idempotent(async ({ params, principal, services, json }) => {
      const input = await json(
        z
          .object({
            decision: z.enum(["accept", "reject"]),
            opIndexes: z.array(z.number().int().min(0)).max(100).optional(),
            note: z.string().max(2000).optional(),
            resolveThreads: z.boolean().optional()
          })
          .strict()
      );
      return ok(await services.proposals.decide(principal, params.id!, input));
    })
  ),

  route("GET", "bulk-imports/sources", async ({ services }) => ok(services.bulkImports.sources())),
  route("GET", "bulk-imports/:id", async ({ params, principal, services }) =>
    ok(await services.bulkImports.get(principal, params.id!))
  ),
  route("POST", "bulk-imports/:id/cancel", async ({ params, principal, services }) =>
    ok(await services.bulkImports.cancel(principal, params.id!))
  ),
  route("POST", "bulk-imports/:id/retry", async ({ params, principal, services }) =>
    ok(await services.bulkImports.retry(principal, params.id!))
  ),
  route("GET", "imports/:id", async ({ params, principal, services }) =>
    ok(withoutSource(await services.ingest.get(principal, params.id!)))
  ),
  route("POST", "imports/:id/retry", async ({ params, principal, services, json }) =>
    ok(
      withoutSource(
        await services.ingest.retry(
          principal,
          params.id!,
          await json(z.object({ processors: z.array(z.string()).max(20).optional() }).strict())
        )
      )
    )
  ),
  route("POST", "imports/:id/publish", async ({ params, principal, services, json }) => {
    const input = await json(
      z
        .object({
          title: nameText(200).optional(),
          parentPath: z.string().optional(),
          slug: z.string().optional(),
          markdown: z.string().optional(),
          documentId: z.string().uuid().optional()
        })
        .strict()
    );
    return ok(withoutSource(await services.ingest.publish(principal, params.id!, input)));
  }),
  route("POST", "imports/:id/discard", async ({ params, principal, services }) =>
    ok(withoutSource(await services.ingest.discard(principal, params.id!)))
  )
];

/** What the handler serves, so the API contract test cannot drift from it. */
export const publicRouteTable = [...PUBLIC_ROUTES];

export const pandocsRouteTable = routes.map(({ method, pattern }) => ({ method, pattern }));

const ingestTarget = z
  .object({
    documentId: z.string().uuid().optional(),
    parentPath: z.string().optional(),
    slug: z.string().optional(),
    title: z.string().max(200).optional(),
    sortOrder: sortOrder.optional(),
    restricted: z.boolean().optional()
  })
  .strict();

const ingestBody = z
  .object({
    target: ingestTarget.optional(),
    contentType: z.string().max(200).optional(),
    filename: z.string().max(240).optional(),
    markdown: z.string().optional(),
    contentBase64: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    channel: z.literal("migration").optional()
  })
  .strict();

export interface PandocsHandlerOptions {
  /** Where the host mounted the API, for example `/api/v1`. */
  readonly basePath: string;
  readonly onError?: ((error: unknown) => void) | undefined;
}

/** Framework-neutral on purpose: the host authenticates, then hands over a Web `Request`. */
export function createPandocsHandler(services: PandocsServices, options: PandocsHandlerOptions) {
  const base = options.basePath.replace(/\/+$/u, "");
  return async (request: Request, principal: Principal): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (!url.pathname.startsWith(`${base}/`)) throw notFound(t("Endpoint"));
      const parts = url.pathname
        .slice(base.length + 1)
        .split("/")
        .filter(Boolean)
        .map(part => {
          try {
            return decodeURIComponent(part);
          } catch {
            throw notFound(t("Endpoint"));
          }
        });
      const matched = matchRoute(routes, request.method, parts);
      if (!matched.route) {
        if (matched.pathExists) throw new PandocsError(405, "METHOD_NOT_ALLOWED", t("This method is not supported"));
        throw notFound(t("Endpoint"));
      }
      if (principal.shared && !SHARED_ROUTES.has(`${matched.route.method} ${matched.route.pattern}`))
        throw notFound(t("Endpoint"));
      if (principal.anonymous && !PUBLIC_ROUTES.has(`${matched.route.method} ${matched.route.pattern}`))
        throw new PandocsError(401, "UNAUTHENTICATED", t("Sign in first"));
      // What these name is always a UUID, and anything else is simply not here, rather than a query the database refuses.
      for (const name of UUID_PARAMS) {
        const value = matched.params[name];
        if (value !== undefined && !UUID.test(value)) throw notFound(t("Endpoint"));
      }
      let body: string | undefined;
      const readText = async () => {
        if (body === undefined) {
          const declared = Number(request.headers.get("content-length") ?? 0);
          if (declared > JSON_LIMIT) throw invalid("BODY_TOO_LARGE", t("The request body is too large"));
          body = await request.text();
          if (body.length > JSON_LIMIT) throw invalid("BODY_TOO_LARGE", t("The request body is too large"));
        }
        return body;
      };
      const context: RouteContext = {
        request,
        principal,
        params: matched.params,
        query: url.searchParams,
        services,
        text: readText,
        async json(schema) {
          const raw = await readText();
          let value: unknown;
          try {
            value = raw ? JSON.parse(raw) : {};
          } catch {
            throw invalid("BODY_INVALID", t("The request body is not valid JSON"));
          }
          return schema.parse(value);
        }
      };
      const result = await matched.route.handler(context);
      if (isResponse(result)) return result;
      if (result.raw !== undefined)
        return Response.json(result.raw, { status: result.status ?? 200, headers: NO_STORE });
      return Response.json(envelope(result.data), { status: result.status ?? 200, headers: NO_STORE });
    } catch (error) {
      return errorResponse(error, options.onError);
    }
  };
}

function errorResponse(raw: unknown, onError: PandocsHandlerOptions["onError"]): Response {
  const error = fromDatabase(raw);
  if (error instanceof PandocsError) {
    return Response.json(
      {
        version: 1,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      },
      { status: error.status, headers: NO_STORE }
    );
  }
  if (error instanceof z.ZodError) {
    return Response.json(
      {
        version: 1,
        error: {
          code: "INPUT_INVALID",
          message: t("The request is not valid"),
          details: error.issues.map(({ path, message }) => ({ path, message }))
        }
      },
      { status: 422, headers: NO_STORE }
    );
  }
  onError?.(error);
  return Response.json(
    { version: 1, error: { code: "INTERNAL_ERROR", message: t("The service is temporarily unavailable") } },
    { status: 500, headers: NO_STORE }
  );
}
