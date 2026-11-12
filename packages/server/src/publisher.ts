import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { batchesOf, type PandocsServices, type ManifestFile, type SpaceManifest } from "@pandocs/core";
import pg from "pg";

const META_DIR = ".pandocs";
const MANIFEST = `${META_DIR}/MANIFEST.json`;
const CURRENT = `${META_DIR}/CURRENT`;
const CHANGES = `${META_DIR}/CHANGES.ndjson`;
const GUIDE = `${META_DIR}/README.md`;
const PACK = `${META_DIR}/pack.tar.gz`;
const INDEX = "llms.txt";
const OWN_FILES: ReadonlySet<string> = new Set([MANIFEST, CURRENT, CHANGES, GUIDE, PACK, INDEX]);
const WORKERS = 16;
const KEPT_CHANGES = 1000;
const GUIDE_TEXT = `# How this directory works

This is a read-only copy of a Pandocs space, kept up to date by its server. The server holds the source of truth.

## Reading

- Every page is \`<path>.md\`, with its current text. Images and other uploads are under \`assets/\`.
- \`.pandocs/MANIFEST.json\` lists every file with its revision. Read it or list a directory to find new files: asking for a path that did not exist a moment ago can keep failing for up to a minute on network file systems.
- \`.pandocs/CURRENT\` is small and changes whenever anything here does, so it is the file to poll. \`.pandocs/CHANGES.ndjson\` says what changed recently.
- To search across everything, unpack \`.pandocs/pack.tar.gz\` to a local disk first. That is far faster than searching here, though the pack can be a few minutes behind.

## Writing

Do not write here. Edit a copy, then submit it with \`pandocs commit\`, or with the proposal tools over MCP or the API, naming the revision you started from. If someone changed the page in the meantime, your change is merged or refused, never lost silently.
`;

/**
 * The rule from testing real NFS clients: replace by rename, so a reader never sees half a file. Never rewrite in place.
 * Every call is a round trip on a network file system, so a round remembers which folders it has already seen to.
 */
async function writeAtomically(target: string, content: string | Uint8Array, folders?: Set<string>): Promise<void> {
  const folder = dirname(target);
  if (!folders?.has(folder)) {
    await mkdir(folder, { recursive: true });
    folders?.add(folder);
  }
  const temporary = join(dirname(target), `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(temporary, content);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function pool<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

async function hashOf(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function listing(manifest: SpaceManifest): string {
  const pages = manifest.files.filter(file => file.kind === "document").map(file => `- [${file.title ?? file.path}](${file.path})`);
  return `# ${manifest.space.name}\n\n${pages.join("\n")}\n`;
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

export interface PublishResult {
  readonly written: number;
  readonly removed: number;
  readonly cursor: string;
}

/**
 * Keeps a shared directory such as CFS, EFS or NAS in step with the database. Each round compares what should be there
 * with the manifest already there, so replays and missed events cost nothing. It only derives: nothing reads these
 * files back, and nothing but this process should write to them.
 */
export function createPublisher(deps: {
  readonly services: PandocsServices;
  readonly dir: string;
  readonly spaces: readonly string[] | "*";
  readonly packIntervalMs?: number | undefined;
  readonly log?: ((event: Record<string, unknown>) => void) | undefined;
}) {
  const { services, dir } = deps;
  const log = deps.log ?? (event => console.log(JSON.stringify(event)));
  const packIntervalMs = deps.packIntervalMs ?? 5 * 60 * 1000;
  const lastPack = new Map<string, { at: number; files: string }>();
  /** By space and path, what each file looked like when it was last found to hold what the manifest says. */
  const checked = new Map<string, Map<string, { size: number; mtimeMs: number; sha256: string }>>();

  const allowed = (slug: string) => deps.spaces === "*" || deps.spaces.includes(slug);
  /** Slugs cannot contain any of this. Checked again because a mistake in this one place would write outside the mount. */
  const inside = (root: string, path: string): string | null => {
    const target = resolve(root, path);
    return target.startsWith(`${resolve(root)}${sep}`) && !path.split("/").includes(META_DIR) ? target : null;
  };

  const readManifest = async (root: string): Promise<SpaceManifest | null> => {
    try {
      return JSON.parse(await readFile(join(root, MANIFEST), "utf8")) as SpaceManifest;
    } catch {
      return null;
    }
  };

  const removeWithParents = async (root: string, target: string) => {
    await rm(target, { force: true });
    for (let parent = dirname(target); parent !== root && parent.startsWith(root); parent = dirname(parent)) {
      const entries = await readdir(parent).catch(() => null);
      if (!entries || entries.length > 0) return;
      await rmdir(parent).catch(() => undefined);
    }
  };

  /** A pack means reading every page, so it trails behind on a timer. It carries its own manifest, which says how far behind. */
  const packIfDue = async (slug: string, root: string, manifest: SpaceManifest) => {
    const files = JSON.stringify(manifest.files);
    const last = lastPack.get(slug);
    if (last?.files === files || (last && Date.now() - last.at < packIntervalMs)) return;
    const temporary = join(root, META_DIR, `.tmp-${randomBytes(6).toString("hex")}`);
    try {
      await pipeline(Readable.fromWeb(services.changes.archive(manifest) as never), createWriteStream(temporary));
      await rename(temporary, join(root, PACK));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    lastPack.set(slug, { at: Date.now(), files });
  };

  /**
   * The files that still hold what the manifest says. Something may have written to one, and reading it is the only
   * way to know, so a file is read again only once its size or time has changed since it was last found right.
   */
  const intact = async (slug: string, root: string, files: readonly ManifestFile[]): Promise<Set<string>> => {
    const before = checked.get(slug) ?? new Map<string, { size: number; mtimeMs: number; sha256: string }>();
    const now = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
    await pool(files, async file => {
      const target = inside(root, file.path);
      const found = target ? await stat(target).catch(() => null) : null;
      if (!target || !found?.isFile()) return;
      const last = before.get(file.path);
      const unchanged = last?.sha256 === file.sha256 && last.size === found.size && last.mtimeMs === found.mtimeMs;
      if (unchanged || await hashOf(target) === file.sha256) now.set(file.path, { size: found.size, mtimeMs: found.mtimeMs, sha256: file.sha256 });
    });
    checked.set(slug, now);
    return new Set(now.keys());
  };

  const removeSpace = async (slug: string) => {
    lastPack.delete(slug);
    checked.delete(slug);
    const root = join(dir, slug);
    // Only ever a directory this process made.
    if (await readManifest(root)) await rm(root, { recursive: true, force: true });
  };

  return {
    allowed,
    /**
     * One round for one space. Safe to repeat, and safe to run after a crash halfway through the last one. `verify` also
     * looks at the files themselves, which brings back anything removed or changed from under it and clears what a
     * crash left behind.
     */
    async publish(slug: string, options: { readonly verify?: boolean } = {}): Promise<PublishResult> {
      const startedAt = Date.now();
      const root = join(dir, slug);
      const desired = allowed(slug) ? await services.changes.publishedManifest(slug) : null;
      if (!desired) {
        await removeSpace(slug);
        return { written: 0, removed: 0, cursor: "0" };
      }
      const previous = await readManifest(root);
      const onDisk = options.verify ? new Set(await filesUnder(root)) : null;
      const whole = onDisk && previous ? await intact(slug, root, previous.files.filter(file => onDisk.has(file.path))) : null;
      const known = new Map((previous?.files ?? []).filter(file => !onDisk || (whole ?? onDisk).has(file.path)).map(file => [file.path, file]));
      const wanted = desired.files.filter(file => inside(root, file.path) !== null);
      const changed = wanted.filter(file => known.get(file.path)?.sha256 !== file.sha256);
      const paths = new Set(wanted.map(file => file.path));
      const removed = [...known.keys()].filter(path => !paths.has(path));
      const unchanged = previous !== null && changed.length === 0 && removed.length === 0
        && previous.space.name === desired.space.name && JSON.stringify(previous.files) === JSON.stringify(wanted);
      const manifest: SpaceManifest = unchanged ? previous : { ...desired, files: wanted };

      if (!unchanged) {
        const folders = new Set<string>();
        for (const batch of batchesOf(changed.filter((file): file is ManifestFile & { documentId: string } => file.kind === "document"))) {
          const texts = await services.changes.markdownOf(batch.map(file => file.documentId));
          await pool(batch, async file => {
            const text = texts.get(file.documentId);
            if (text !== undefined) await writeAtomically(join(root, file.path), text, folders);
          });
        }
        await pool(changed.filter(file => file.kind === "asset"), async file => {
          const bytes = await services.changes.assetBytes(desired.space.id, file.sha256);
          if (bytes) await writeAtomically(join(root, file.path), bytes, folders);
        });
        const manifestText = JSON.stringify(manifest);
        await writeAtomically(join(root, GUIDE), GUIDE_TEXT);
        await writeAtomically(join(root, INDEX), listing(manifest));
        // New content is in place before the manifest names it, and old content leaves only after.
        await writeAtomically(join(root, MANIFEST), manifestText);
        await pool(removed, async path => {
          const target = inside(root, path);
          if (target) await removeWithParents(root, target);
        });
        const history = await readFile(join(root, CHANGES), "utf8").then(text => text.split("\n").filter(Boolean), () => [] as string[]);
        const at = new Date().toISOString();
        const fresh = [
          ...changed.map(file => JSON.stringify({ cursor: manifest.cursor, at, action: "write", path: file.path, revision: file.revision })),
          ...removed.map(path => JSON.stringify({ cursor: manifest.cursor, at, action: "remove", path }))
        ];
        await writeAtomically(join(root, CHANGES), `${[...history, ...fresh].slice(-KEPT_CHANGES).join("\n")}\n`);
        // The small file readers poll goes last, so seeing it change means everything before it is there.
        await writeAtomically(join(root, CURRENT), `${JSON.stringify({ cursor: manifest.cursor, files: manifest.files.length, sha256: createHash("sha256").update(manifestText).digest("hex") })}\n`);
        log({ event: "publisher.published", space: slug, written: changed.length, removed: removed.length, cursor: manifest.cursor, ms: Date.now() - startedAt });
      }
      // Never on a directory seen for the first time: it may hold someone's files under a name that happens to match.
      if (onDisk && previous) {
        for (const path of onDisk) {
          if (!paths.has(path) && !OWN_FILES.has(path)) await removeWithParents(root, join(root, path));
        }
      }
      await packIfDue(slug, root, manifest);
      return { written: unchanged ? 0 : changed.length, removed: unchanged ? 0 : removed.length, cursor: manifest.cursor };
    },
    /** Every space, including those that should no longer be here. */
    async publishAll(options: { readonly verify?: boolean } = {}): Promise<void> {
      const { rows } = await services.context.db.query<{ slug: string }>(`SELECT slug FROM pandocs.spaces WHERE deleted_at IS NULL`);
      const live = new Set(rows.map(row => row.slug).filter(allowed));
      for (const slug of live) await this.publish(slug, options);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!live.has(name)) await removeSpace(name);
      }
    }
  };
}

export type Publisher = ReturnType<typeof createPublisher>;

const LEADER_LOCK = "pandocs:publisher";
const DEBOUNCE_MS = 300;
const FULL_ROUND_MS = 5 * 60 * 1000;
const FAILED_ROUND_RETRY_MS = 30_000;
const LEAD_RETRY_MS = 5000;

/**
 * Any number of replicas can have this role; a session lock lets exactly one work, and the next takes over when its
 * connection drops. Like `LISTEN`, the lock needs a real connection rather than one borrowed from a transaction pooler.
 */
export function runPublisher(deps: {
  readonly connectionString: string;
  readonly services: PandocsServices;
  readonly publisher: Publisher;
  readonly debounceMs?: number;
  readonly leadRetryMs?: number;
}) {
  const { services, publisher } = deps;
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const leadRetryMs = deps.leadRetryMs ?? LEAD_RETRY_MS;
  let stopped = false;
  let lock: pg.Client | null = null;
  let leading = false;
  let lastAttempt = 0;
  let running: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cursor = "0";
  let lastFull = 0;

  const release = () => {
    leading = false;
    const client = lock;
    lock = null;
    if (!client) return;
    client.removeAllListeners();
    client.on("error", () => undefined);
    void client.end().catch(() => undefined);
  };

  const lead = async (): Promise<boolean> => {
    if (leading) return true;
    if (Date.now() - lastAttempt < leadRetryMs) return false;
    lastAttempt = Date.now();
    try {
      if (!lock) {
        const client = new pg.Client({ connectionString: deps.connectionString, keepAlive: true });
        client.on("error", release);
        client.on("end", release);
        lock = client;
        await client.connect();
      }
      const { rows } = await lock.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [LEADER_LOCK]);
      leading = rows[0]?.locked === true;
      // Whatever happened while no one was leading is covered by comparing everything once.
      if (leading) lastFull = 0;
    } catch {
      release();
    }
    return leading;
  };

  const round = async () => {
    if (!await lead()) return;
    if (Date.now() - lastFull > FULL_ROUND_MS) {
      const start = await services.changes.watermark();
      await publisher.publishAll({ verify: true });
      cursor = start;
      lastFull = Date.now();
      return;
    }
    const spaces = new Set<string>();
    let everything = false;
    for (let rows = await services.changes.settledSince(cursor); rows.length > 0; rows = await services.changes.settledSince(cursor)) {
      cursor = rows.at(-1)!.cursor;
      for (const row of rows) {
        if (row.kind === "discussion") continue;
        if (row.kind === "space" || !row.spaceSlug) everything = true;
        else spaces.add(row.spaceSlug);
      }
    }
    if (everything) await publisher.publishAll();
    else for (const slug of spaces) await publisher.publish(slug);
  };

  const work = async () => {
    try {
      await round();
    } catch (error) {
      // Rows this round moved past may not be on disk, and the full round is what catches those.
      lastFull = Date.now() - FULL_ROUND_MS + FAILED_ROUND_RETRY_MS;
      console.error(JSON.stringify({ event: "publisher.round_failed", name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "" }));
    }
  };

  const settle = async (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = work().finally(() => {
      running = null;
      if (again && !stopped) {
        again = false;
        wake();
      }
    });
    return running;
  };

  const wake = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void settle();
    }, debounceMs);
    timer.unref();
  };

  return {
    wake,
    /** One round now, for tests. */
    settle,
    get leading() {
      return leading;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      release();
    }
  };
}
