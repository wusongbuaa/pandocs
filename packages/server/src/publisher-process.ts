import { spawn, type ChildProcess } from "node:child_process";

const MAX_DELAY_MS = 60_000;
const STABLE_AFTER_MS = 60_000;

/**
 * Publishing gets a process of its own. File operations wait in a pool of threads that DNS lookups, compression and
 * everything else asynchronous in Node share, so a shared file system that hangs, as NFS does when its server restarts,
 * would otherwise stop the whole site from answering. Hung, this process only delays the files.
 */
export function startPublisherProcess(options: {
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly firstDelayMs?: number;
  readonly log?: (event: Record<string, unknown>) => void;
}) {
  const firstDelayMs = options.firstDelayMs ?? 1000;
  const log = options.log ?? (event => console.error(JSON.stringify(event)));
  let child: ChildProcess | null = null;
  let stopped = false;
  let delay = firstDelayMs;
  let restart: ReturnType<typeof setTimeout> | null = null;

  const launch = () => {
    const startedAt = Date.now();
    // The channel is only there so the child knows when this process is gone: see `exitWithParent`.
    const started = spawn(options.command ?? process.execPath, options.args as string[], {
      env: { ...options.env, PANDOCS_ROLES: "publisher" },
      stdio: ["ignore", "inherit", "inherit", "ipc"]
    });
    child = started;
    started.on("error", error => log({ event: "publisher.process_error", message: error.message }));
    started.on("exit", code => {
      child = null;
      if (stopped) return;
      delay = Date.now() - startedAt > STABLE_AFTER_MS ? firstDelayMs : Math.min(delay * 2, MAX_DELAY_MS);
      log({ event: "publisher.process_exited", code, restartInMs: delay });
      restart = setTimeout(launch, delay);
      restart.unref();
    });
  };

  launch();
  return {
    get pid() {
      return child?.pid;
    },
    stop() {
      stopped = true;
      if (restart) clearTimeout(restart);
      child?.kill("SIGTERM");
    }
  };
}

/** A publisher left running after its parent died would hold the publishing lock with no one to restart it. */
export function exitWithParent(): void {
  if (process.send) process.on("disconnect", () => process.exit(0));
}
