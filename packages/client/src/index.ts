import createFetchClient, { type Client } from "openapi-fetch";
import type { components, paths } from "./schema.js";

export type { components, paths };
type Schemas = components["schemas"];
export type Change = Schemas["Change"];
export type CommitResult = Schemas["CommitResult"];
export type Comment = Schemas["Comment"];
export type DocumentView = Schemas["DocumentView"];
export type Me = Schemas["Me"];
export type Proposal = Schemas["Proposal"];
export type SearchHit = Schemas["SearchHit"];
export type Space = Schemas["Space"];
export type SpaceManifest = Schemas["SpaceManifest"];
export type Thread = Schemas["Thread"];
export type TreeNode = Schemas["TreeNode"];

export interface PandocsClientOptions {
  /** Where the site is, such as `https://docs.example.com`. */
  readonly server: string;
  /** An API token from an account page. An agent token reads, comments and proposes; only a person's can save. */
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** The server said no. `code` is stable and meant for programs, such as `REVISION_CONFLICT` or `MERGE_CONFLICT`. */
export class PandocsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "PandocsError";
  }
}

export type LiveEvent = { readonly type: "change"; readonly change: Change } | { readonly type: "reset" };

const RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

interface Answer<T> {
  readonly data?: { readonly data: T } | undefined;
  readonly error?: { readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown } } | undefined;
  readonly response: Response;
}

function unwrap<T>({ data, error, response }: Answer<T>): T {
  if (data) return data.data;
  throw new PandocsError(response.status, error?.error?.code ?? "UNKNOWN", error?.error?.message ?? `The server answered ${response.status}`, error?.error?.details);
}

const newKey = () => crypto.randomUUID();

/** Reads Server-Sent Events off a response body. A proxy can split a frame anywhere, so frames are only read once whole. */
async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; event?: string; data?: string }> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame: { id?: string; event?: string; data?: string } = {};
        for (const line of buffer.slice(0, end).split("\n")) {
          if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("data: ")) frame.data = line.slice(6);
        }
        buffer = buffer.slice(end + 2);
        if (frame.event) yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The usual things by name, and `api` for everything else, typed from the API description.
 *
 * ```ts
 * const pandocs = createPandocsClient({ server: "https://docs.example.com", token });
 * const page = await pandocs.read(id);
 * await pandocs.propose(id, { baseRevision: page.revision.no, markdown: edited, rationale: "Fix the first step" });
 * for await (const event of pandocs.events({ space: "handbook" })) console.log(event);
 * ```
 */
export function createPandocsClient(options: PandocsClientOptions) {
  const server = options.server.replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers = { Authorization: `Bearer ${options.token}` };
  const api: Client<paths> = createFetchClient<paths>({ baseUrl: `${server}/api/v1`, fetch: fetchImpl, headers });

  return {
    api,
    me: async () => unwrap(await api.GET("/me")),
    spaces: async () => unwrap(await api.GET("/spaces")),
    tree: async (space: string) => unwrap(await api.GET("/spaces/{space}/tree", { params: { path: { space } } })),
    search: async (q: string, filter: { readonly space?: string } = {}) => unwrap(await api.GET("/search", { params: { query: { q, ...filter } } })),
    read: async (id: string) => unwrap(await api.GET("/documents/{id}", { params: { path: { id } } })),
    /** Finds a page by its address in a space. */
    resolve: async (space: string, path: string) => unwrap(await api.GET("/spaces/{space}/resolve", { params: { path: { space }, query: { path } } })) as unknown as { readonly id: string },
    create: async (space: string, input: paths["/spaces/{space}/documents"]["post"]["requestBody"]["content"]["application/json"]) =>
      unwrap(await api.POST("/spaces/{space}/documents", { params: { path: { space } }, body: input })),
    /** Saves a page, naming the revision the edit started from. With `merge`, an edit to a page that moved on is merged by block. */
    save: async (id: string, input: paths["/documents/{id}/content"]["put"]["requestBody"]["content"]["application/json"]) =>
      unwrap(await api.PUT("/documents/{id}/content", { params: { path: { id }, header: { "Idempotency-Key": newKey() } }, body: input })),
    /** Suggests a change for someone with edit rights to decide. Give the whole edited text as `markdown`, or `ops`. */
    propose: async (id: string, input: paths["/documents/{id}/proposals"]["post"]["requestBody"]["content"]["application/json"]) =>
      unwrap(await api.POST("/documents/{id}/proposals", { params: { path: { id } }, body: input, headers: { "Idempotency-Key": newKey() } })),
    threads: async (id: string) => unwrap(await api.GET("/documents/{id}/threads", { params: { path: { id }, query: {} } })),
    comment: async (id: string, input: paths["/documents/{id}/threads"]["post"]["requestBody"]["content"]["application/json"]) =>
      unwrap(await api.POST("/documents/{id}/threads", { params: { path: { id } }, body: input })),
    reply: async (threadId: string, body: string) => unwrap(await api.POST("/threads/{id}/comments", { params: { path: { id: threadId } }, body: { body } })),
    /** A space as files: every page this token can read, and the uploads they use, with hashes. */
    manifest: async (space: string) => unwrap(await api.GET("/spaces/{space}/manifest", { params: { path: { space } } })),
    /** Anything the server offers, by name. See `GET /tools` for what there is. */
    tool: async <T = unknown>(name: string, args: Record<string, unknown>) =>
      unwrap<T>(await api.POST("/tools/{name}", { params: { path: { name } }, body: args as never }) as Answer<T>),
    /**
     * What changes, as it happens, until `signal` aborts. Reconnects by itself and misses nothing in between. A row says
     * what changed, not what to do about it, so read current state when one arrives. A `reset` means too much went by to
     * list, so compare everything you care about. Throws if the server refuses, as retrying would not help.
     */
    events: async function* (filter: { readonly space?: string; readonly document?: string; readonly since?: string; readonly signal?: AbortSignal } = {}): AsyncGenerator<LiveEvent> {
      let position = filter.since;
      let delay = RECONNECT_MS;
      const query = new URLSearchParams();
      if (filter.space) query.set("space", filter.space);
      if (filter.document) query.set("document", filter.document);
      const address = `${server}/api/v1/events?${query}`;
      while (!filter.signal?.aborted) {
        try {
          const response = await fetchImpl(address, { headers: { ...headers, Accept: "text/event-stream", ...(position ? { "Last-Event-ID": position } : {}) }, ...(filter.signal ? { signal: filter.signal } : {}) });
          if (!response.ok || !response.body) {
            const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
            // Anything but a server that is restarting will say the same again.
            if (response.status < 500) throw new PandocsError(response.status, payload?.error?.code ?? "UNKNOWN", payload?.error?.message ?? `The server answered ${response.status}`);
          } else {
            delay = RECONNECT_MS;
            for await (const frame of framesOf(response.body)) {
              if (frame.id) position = frame.id;
              if (frame.event === "change") yield { type: "change", change: JSON.parse(frame.data ?? "{}") as Change };
              else if (frame.event === "reset") yield { type: "reset" };
            }
          }
        } catch (error) {
          if (error instanceof PandocsError) throw error;
          if (filter.signal?.aborted) return;
        }
        await new Promise(done => setTimeout(done, delay));
        delay = Math.min(delay * 2, MAX_RECONNECT_MS);
      }
    }
  };
}

export type PandocsClient = ReturnType<typeof createPandocsClient>;
