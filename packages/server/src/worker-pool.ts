import { cpus } from "node:os";
import { Worker } from "node:worker_threads";

/** A thread keeps what it took at its busiest. Starting one takes a moment, and long pages are not saved all the time. */
const LET_GO_AFTER_MS = 60_000;

interface Job<Input, Output> {
  readonly id: number;
  readonly input: Input;
  resolve(result: Output): void;
  reject(error: Error): void;
}

/** Work too long for the thread serving requests. Workers start on first use, one that dies is replaced, and one with nothing to do goes away. */
export function createWorkerPool<Input, Output>(
  workerUrl: URL,
  size = Math.max(1, Math.min(2, cpus().length - 1)),
  heapMb?: number,
  letGoAfterMs = LET_GO_AFTER_MS
) {
  const queue: Job<Input, Output>[] = [];
  const idle: Worker[] = [];
  const idleTimers = new Map<Worker, ReturnType<typeof setTimeout>>();
  const running = new Map<Worker, Job<Input, Output>>();
  let spawned = 0;
  let nextId = 0;
  let stopped = false;

  const pump = () => {
    while (queue.length > 0) {
      let worker = idle.pop();
      if (worker) clearTimeout(idleTimers.get(worker));
      if (!worker && spawned < size) worker = spawn();
      if (!worker) return;
      const job = queue.shift()!;
      running.set(worker, job);
      worker.postMessage({ id: job.id, input: job.input });
    }
  };

  const spawn = () => {
    const worker = new Worker(workerUrl, heapMb ? { resourceLimits: { maxOldGenerationSizeMb: heapMb } } : {});
    spawned += 1;
    worker.unref();
    worker.on("message", (reply: { id?: number; result?: Output; error?: string }) => {
      const job = running.get(worker);
      // Only the answer to the job counts: a development server's file watcher, for one, talks on the same channel.
      if (!job || reply?.id !== job.id) return;
      running.delete(worker);
      idle.push(worker);
      idleTimers.set(worker, setTimeout(() => void worker.terminate(), letGoAfterMs).unref());
      if (reply.error === undefined) job?.resolve(reply.result as Output);
      else job?.reject(new Error(reply.error));
      pump();
    });
    const lost = (error: Error) => {
      const job = running.get(worker);
      running.delete(worker);
      const at = idle.indexOf(worker);
      if (at >= 0) idle.splice(at, 1);
      clearTimeout(idleTimers.get(worker));
      idleTimers.delete(worker);
      spawned -= 1;
      job?.reject(error);
      if (!stopped) pump();
    };
    worker.on("error", lost);
    worker.on("exit", code => {
      if (code !== 0 && !stopped) lost(new Error(`worker exited with ${code}`));
    });
    return worker;
  };

  return {
    get workers() {
      return spawned;
    },
    run(input: Input): Promise<Output> {
      return new Promise((resolve, reject) => {
        queue.push({ id: (nextId += 1), input, resolve, reject });
        pump();
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      await Promise.all([...idle, ...running.keys()].map(worker => worker.terminate()));
    }
  };
}
