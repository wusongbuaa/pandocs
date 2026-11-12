import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { Language } from "@pandocs/i18n";

export interface PreparedAnswer {
  readonly status: number;
  readonly payload: unknown;
}

/** The other side of this is `packages/web/src/ssr`, which comes with the web app's build. */
export interface RenderInput {
  readonly url: string;
  readonly origin: string;
  readonly answers: Readonly<Record<string, PreparedAnswer>>;
}

export interface RenderedPage {
  readonly html: string;
  readonly headTags: string;
  readonly htmlAttrs: string;
  readonly status: 200 | 404;
}

/** How long someone waits for a render. After this they get a page their browser renders, and the next person gets this one. */
const WAIT_MS = 3000;
/** Past this a render is stopped, and that page is not tried again for a while. */
const LIMIT_MS = 30_000;
const RETRY_AFTER_MS = 5 * 60_000;
/** More waiting than this and they would mostly run out their wait in the queue. */
const QUEUE_LIMIT = 64;
/** A page renders to the same thing from the same input, so anything that changes it is a different entry. */
const REMEMBERED_CHARS = 32 * 1024 * 1024;
/** A document that takes more than this is not one to give up the server for. */
const THREAD_HEAP_MB = 256;
/** A thread starts in about a tenth of a second and holds on to its memory, so one with nothing to do goes away. */
const IDLE_MS = 60_000;
/** The same goes for one that has grown: a long page leaves it this size or larger, and it only gets smaller by starting over. */
const RETIRE_ABOVE_BYTES = 200 * 1024 * 1024;

interface Job {
  readonly key: string;
  readonly input: RenderInput;
  resolve(page: RenderedPage): void;
  reject(error: Error): void;
}

type Log = (event: string, fields: Readonly<Record<string, unknown>>) => void;

const sizeOf = (page: RenderedPage) => page.html.length + page.headTags.length;

/**
 * Renders pages on other threads: on the main one, a long document would stop every other request. A thread keeps to one
 * language, because a page's text is settled when its code loads, the same as in a browser. Threads start on first use, so
 * a language nobody reads costs nothing, and one that dies is replaced. Whenever this does not produce a page in time, the
 * caller sends one for the browser to render, so a problem here costs speed rather than the page.
 */
export function createRenderPool(
  workerFile: string,
  deps: {
    readonly log: Log;
    readonly threads?: number;
    readonly waitMs?: number;
    readonly limitMs?: number;
    readonly idleMs?: number;
    readonly base?: string;
  }
) {
  const threads = deps.threads ?? 1;
  const waitMs = deps.waitMs ?? WAIT_MS;
  const limitMs = deps.limitMs ?? LIMIT_MS;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const lanes = new Map<
    Language,
    {
      queue: Job[];
      idle: Worker[];
      running: Map<Worker, { job: Job; id: number; timer: NodeJS.Timeout }>;
      spawned: number;
    }
  >();
  const inFlight = new Map<string, Promise<RenderedPage>>();
  const remembered = new Map<string, RenderedPage>();
  const refused = new Map<string, number>();
  const idleTimers = new WeakMap<Worker, NodeJS.Timeout>();
  let rememberedChars = 0;
  let nextId = 0;
  let stopped = false;

  const remember = (key: string, page: RenderedPage) => {
    remembered.set(key, page);
    rememberedChars += sizeOf(page);
    for (const [oldest, old] of remembered) {
      if (rememberedChars <= REMEMBERED_CHARS) break;
      remembered.delete(oldest);
      rememberedChars -= sizeOf(old);
    }
  };

  const recall = (key: string) => {
    const page = remembered.get(key);
    if (page) {
      // Back to the end of the line, so what goes first is what nobody has asked for in the longest time.
      remembered.delete(key);
      remembered.set(key, page);
    }
    return page;
  };

  const laneOf = (language: Language) => {
    let lane = lanes.get(language);
    if (!lane) lanes.set(language, (lane = { queue: [], idle: [], running: new Map(), spawned: 0 }));
    return lane;
  };

  const pump = (language: Language) => {
    const lane = laneOf(language);
    while (lane.queue.length > 0 && !stopped) {
      let worker = lane.idle.pop();
      if (!worker && lane.spawned < threads) worker = spawn(language);
      if (!worker) return;
      clearTimeout(idleTimers.get(worker));
      const job = lane.queue.shift()!;
      const running = worker;
      const id = (nextId += 1);
      lane.running.set(running, { job, id, timer: setTimeout(() => void running.terminate(), limitMs).unref() });
      running.postMessage({ id, input: job.input });
    }
  };

  const spawn = (language: Language) => {
    const lane = laneOf(language);
    const worker = new Worker(workerFile, {
      workerData: { language, base: deps.base ?? "" },
      resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_MB }
    });
    lane.spawned += 1;
    worker.unref();
    const finish = () => {
      const current = lane.running.get(worker);
      if (current) clearTimeout(current.timer);
      lane.running.delete(worker);
      return current?.job;
    };
    worker.on("message", (reply: { id?: number; page?: RenderedPage; error?: string; heapBytes?: number }) => {
      // Only the answer to the job counts: a development server's file watcher, for one, talks on the same channel.
      if (reply?.id === undefined || reply.id !== lane.running.get(worker)?.id) return;
      const job = finish();
      if ((reply.heapBytes ?? 0) > RETIRE_ABOVE_BYTES) {
        void worker.terminate();
      } else {
        lane.idle.push(worker);
        idleTimers.set(worker, setTimeout(() => void worker.terminate(), idleMs).unref());
      }
      if (reply.page) job?.resolve(reply.page);
      else job?.reject(new Error(reply.error ?? "the page did not render"));
      pump(language);
    });
    let gone = false;
    const lost = (error: Error) => {
      if (gone) return;
      gone = true;
      clearTimeout(idleTimers.get(worker));
      const job = finish();
      const at = lane.idle.indexOf(worker);
      if (at >= 0) lane.idle.splice(at, 1);
      lane.spawned -= 1;
      job?.reject(error);
      pump(language);
    };
    worker.on("error", lost);
    worker.on("exit", code => lost(new Error(`a rendering thread stopped with ${code}`)));
    return worker;
  };

  const start = (language: Language, key: string, input: RenderInput) => {
    const page = new Promise<RenderedPage>((resolve, reject) => {
      laneOf(language).queue.push({ key, input, resolve, reject });
      pump(language);
    })
      .then(
        rendered => {
          remember(key, rendered);
          return rendered;
        },
        (error: Error) => {
          refused.set(key, Date.now() + RETRY_AFTER_MS);
          // The browser renders it instead, so this is about speed; the reason is here for whoever looks into that.
          deps.log("web.render_failed", { url: input.url, language, error: error.message.slice(0, 2000) });
          throw error;
        }
      )
      .finally(() => inFlight.delete(key));
    inFlight.set(key, page);
    return page;
  };

  return {
    /** `null` means there is no rendered page to give right now, which the caller is ready for. */
    async render(language: Language, input: RenderInput): Promise<RenderedPage | null> {
      const key = createHash("sha256").update(language).update(JSON.stringify(input)).digest("base64url");
      const known = recall(key);
      if (known) return known;
      if ((refused.get(key) ?? 0) > Date.now()) return null;
      refused.delete(key);
      if (!inFlight.has(key) && laneOf(language).queue.length >= QUEUE_LIMIT) return null;
      const page = inFlight.get(key) ?? start(language, key, input);
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), waitMs);
      });
      try {
        // Carries on after the wait runs out, so that what took long only takes long once.
        return await Promise.race([page, late]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    stop(): void {
      stopped = true;
      for (const lane of lanes.values())
        for (const worker of [...lane.idle, ...lane.running.keys()]) void worker.terminate();
    }
  };
}

export type RenderPool = ReturnType<typeof createRenderPool>;
