import pg from "pg";
import { createApp, createChangeListener, createPublisher, createRuntime, loadSigningSecret, migrate, readConfig, runPublisher } from "./app.js";
import { hashPassword } from "./auth/passwords.js";
import { listen } from "./listen.js";
import { exitWithParent, startPublisherProcess } from "./publisher-process.js";
import { VERSION } from "./version.js";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_LIMIT_MS = 10_000;

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.databasePool });
  pool.on("error", error => console.error(JSON.stringify({ event: "db.pool_error", message: error.message })));
  await migrate(pool);
  const runtime = createRuntime({ ...config, secret: config.secret ?? await loadSigningSecret(pool) }, pool);

  if (config.admin && (await runtime.users.count()) === 0) {
    await runtime.users.createFirstAdmin({ email: config.admin.email, displayName: config.admin.displayName, passwordHash: await hashPassword(config.admin.password) });
  }

  const sweeper = config.roles.has("worker") ? setInterval(() => {
    void runtime.sessions.sweep().catch(() => undefined);
    void runtime.oauth.sweep().catch(() => undefined);
  }, SWEEP_INTERVAL_MS) : null;
  sweeper?.unref();
  if (config.roles.has("worker")) runtime.worker.start();

  const publisher = config.publish && config.roles.has("publisher")
    ? runPublisher({ connectionString: config.databaseListenUrl, services: runtime.services, publisher: createPublisher({ services: runtime.services, ...config.publish }) })
    : null;
  if (publisher) exitWithParent();
  // A process that serves pages and has been told to publish leaves the files to a process of its own.
  const publisherProcess = config.publish && !config.roles.has("publisher") && config.roles.has("worker")
    ? startPublisherProcess({ args: process.argv.slice(1), env: { ...process.env, UV_THREADPOOL_SIZE: "16" } })
    : null;
  const listener = createChangeListener(config.databaseListenUrl, () => {
    if (config.roles.has("web")) {
      runtime.events.wake();
      runtime.live.wake();
    }
    publisher?.wake();
  });

  const server = config.roles.has("web")
    ? listen(createApp(runtime, { cacheHtml: process.env.NODE_ENV === "production" }), { hostname: config.host, port: config.port }, info => {
      console.log(JSON.stringify({ event: "server.listening", version: VERSION, port: info.port, roles: [...config.roles], url: config.siteUrl }));
    })
    : null;
  if (!server) console.log(JSON.stringify({ event: "server.started", version: VERSION, roles: [...config.roles] }));
  server?.on("upgrade", runtime.live.handleUpgrade);

  const shutdown = () => {
    if (sweeper) clearInterval(sweeper);
    runtime.lifecycle.draining = true;
    runtime.live.drain();
    server?.drain();
    publisherProcess?.stop();
    // A pod stays in its load balancer's list for a moment after being told to stop, and requests keep coming until then.
    setTimeout(() => {
      // Long requests could otherwise hold the process past what an orchestrator allows.
      setTimeout(() => process.exit(0), SHUTDOWN_LIMIT_MS).unref();
      void runtime.live.stop().catch(() => undefined).finally(() => {
        listener.stop();
        publisher?.stop();
        runtime.destroy();
        const finish = () => void pool.end().finally(() => process.exit(0));
        if (server) server.close(finish);
        else finish();
      });
    }, server ? config.drainMs : 0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// Background work that fails says so and tries again later. It should not end every request in progress along the way.
process.on("unhandledRejection", reason => {
  console.error(JSON.stringify({ event: "process.unhandled_rejection", name: reason instanceof Error ? reason.name : "unknown", message: reason instanceof Error ? reason.message : String(reason) }));
});

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
