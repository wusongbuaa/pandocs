import { embedded, withTicket } from "../embed/session";
import { randomId } from "../ui/random-id";
import { language, t } from "../i18n";

export { API_BASE } from "../data/site-base";
import { API_BASE } from "../data/site-base";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  readonly body?: unknown;
  readonly idempotent?: boolean;
  /** Lets the request finish after the page has gone. */
  readonly keepalive?: boolean;
}

/** Someone may have picked a language other than the one their browser asks for. */
const ANSWER_LANGUAGE = { "accept-language": language };

const SESSION_RELOAD_KEY = "pandocs:session-reload";

/** The page route sends an expired session to the login page, so reloading is all it takes. Once, in case it does not. */
function reloadForLogin(): void {
  if (sessionStorage.getItem(SESSION_RELOAD_KEY)) return;
  sessionStorage.setItem(SESSION_RELOAD_KEY, "1");
  location.reload();
}

let visitor = false;

export function setVisitor(value: boolean): void {
  visitor = value;
}

let sessionExpired: (() => void) | null = null;

/** While someone is typing, a reload would throw away what they wrote, so the editor takes over. Returns how to give it back. */
export function onSessionExpired(handler: () => void): () => void {
  sessionExpired = handler;
  return () => {
    if (sessionExpired === handler) sessionExpired = null;
  };
}

type Payload<T> = { data?: T; error?: { code?: string; message?: string; details?: unknown } } | null;

export interface PreparedAnswer {
  readonly status: number;
  readonly payload: unknown;
}

let prepared = new Map<string, PreparedAnswer>();

/** A page from the server comes with the answers it was rendered from, so that it starts out the same here without asking again. Each is good for one question. */
export function prepareAnswers(answers: Readonly<Record<string, PreparedAnswer>>): void {
  prepared = new Map(Object.entries(answers));
}

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as Payload<T>;
  // Someone with no login is meant to be here. What they cannot reach is not a sign that a login ran out.
  if (response.status === 401 && !embedded && !visitor) {
    if (sessionExpired) sessionExpired();
    else reloadForLogin();
  }
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code ?? "REQUEST_FAILED", payload?.error?.message ?? t("Request failed. Try again later."), payload?.error?.details);
  sessionStorage.removeItem(SESSION_RELOAD_KEY);
  return payload?.data as T;
}

export const api = {
  get: async <T>(path: string) => {
    const answer = prepared.get(path);
    if (!answer) return parse<T>(await fetch(`${API_BASE}/${path}`, { credentials: "same-origin", headers: ANSWER_LANGUAGE }));
    prepared.delete(path);
    return parse<T>(new Response(JSON.stringify(answer.payload), { status: answer.status }));
  },
  send: async <T>(method: string, path: string, options: RequestOptions = {}) => parse<T>(await fetch(`${API_BASE}/${path}`, {
    method,
    credentials: "same-origin",
    ...(options.keepalive ? { keepalive: true } : {}),
    headers: {
      ...ANSWER_LANGUAGE,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.idempotent ? { "idempotency-key": randomId() } : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })),
  upload: async <T>(path: string, file: File, fields: Readonly<Record<string, string>> = {}) => {
    const form = new FormData();
    form.set("file", file);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return parse<T>(await fetch(`${API_BASE}/${path}`, { method: "POST", credentials: "same-origin", headers: ANSWER_LANGUAGE, body: form }));
  },
  /** For an answer that arrives in pieces: server-sent events, with JSON in each. Being refused is an ordinary error. */
  stream: async (path: string, body: unknown, onEvent: (event: unknown) => void, signal: AbortSignal): Promise<void> => {
    const response = await fetch(`${API_BASE}/${path}`, { method: "POST", credentials: "same-origin", headers: { ...ANSWER_LANGUAGE, "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.ok || !response.body) {
      await parse(response);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    // Safari cannot go through a stream with `for await`.
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      buffered += decoder.decode(read.value, { stream: true });
      const events = buffered.split("\n\n");
      buffered = events.pop() ?? "";
      for (const event of events) {
        if (!event.startsWith("data: ")) continue;
        // One event that cannot be read is skipped, rather than ending the answer it is part of.
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.slice(6));
        } catch {
          continue;
        }
        onEvent(parsed);
      }
    }
  },
  /** Something for the numbers, which nobody waits for and nothing depends on. It can outlive the page, and a login that ran out is not its concern. */
  beacon: (path: string, body: unknown): void => {
    void fetch(`${API_BASE}/${path}`, { method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  },
  uploadRaw: async <T>(path: string, file: File) => parse<T>(await fetch(`${API_BASE}/${path}`, { method: "POST", credentials: "same-origin", headers: { ...ANSWER_LANGUAGE, "content-type": file.type || "application/octet-stream" }, body: file })),
  /** The hash identifies the asset and the server knows its type. Dropping the extension also stops dev servers treating API paths as static files. */
  assetUrl: (space: string, src: string) => withTicket(`${API_BASE}/spaces/${encodeURIComponent(space)}/${src.replace(/\.[a-z0-9]+$/iu, "")}`)
};

export function failureMessage(error: unknown, fallback = t("That did not finish. Try again later.")): string {
  return error instanceof ApiError ? error.message : fallback;
}
