import { execFile, spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitPort, GitRemote, GitWorkspace } from "@pandocs/core";
import { t } from "@pandocs/i18n";
import { isPrivate } from "./webhooks.js";

const NETWORK_TIMEOUT_MS = 5 * 60 * 1000;
const LOCAL_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const PASSED_ON = ["PATH", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;

interface RunOptions {
  readonly cwd?: string;
  readonly input?: string | Uint8Array;
  readonly env?: NodeJS.ProcessEnv;
  readonly network?: boolean;
}

/**
 * Git itself, as a program. A repository can be large, so reading one does not belong on the thread serving pages, and
 * running it this way works with whatever a host speaks. Each call gets a clean environment, because nothing it finds on
 * this machine should change what it does, and credentials never appear on a command line, where anyone on the machine
 * could see them. Nothing is ever checked out: files in a repository are data, and links and hooks in one do nothing here.
 */
export function createGitPort(deps: { readonly allowPrivate: boolean; readonly binary?: string }): GitPort {
  const binary = deps.binary ?? "git";

  /** Asked before anything connects, with the answer pinned for Git, so a name cannot resolve to somewhere else by the time it does. */
  const pinned = async (repository: string): Promise<readonly string[]> => {
    if (deps.allowPrivate) return [];
    const url = new URL(repository);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const family = isIP(host);
    const addresses = family ? [{ address: host, family }] : await lookup(host, { all: true, verbatim: true }).catch(() => {
      throw new Error(t("The repository's address could not be found"));
    });
    if (addresses.length === 0 || addresses.some(({ address, family: kind }) => isPrivate(address, kind))) {
      throw new Error(t("This address is on a private network, which Git sync cannot reach unless the server allows it"));
    }
    return family ? [] : [`http.curloptResolve=${host}:${port}:${addresses.map(({ address, family: kind }) => (kind === 6 ? `[${address}]` : address)).join(",")}`];
  };

  const environment = (remote: GitRemote, settings: readonly string[]): NodeJS.ProcessEnv => {
    const entries = [
      ...settings,
      // Sending a token on to wherever a host redirects to would be giving it away.
      "http.followRedirects=false",
      "credential.helper=",
      "core.hooksPath=/dev/null",
      "gc.auto=0",
      "maintenance.auto=false",
      "protocol.allow=never",
      "protocol.https.allow=always",
      "protocol.http.allow=always"
    ];
    if (remote.token) {
      const credentials = remote.token.includes(":") ? remote.token : `x-access-token:${remote.token}`;
      entries.push(`http.extraHeader=Authorization: Basic ${Buffer.from(credentials).toString("base64")}`);
    }
    const env: NodeJS.ProcessEnv = {
      HOME: tmpdir(),
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: String(entries.length)
    };
    for (const name of PASSED_ON) if (process.env[name] !== undefined) env[name] = process.env[name];
    entries.forEach((entry, at) => {
      const split = entry.indexOf("=");
      env[`GIT_CONFIG_KEY_${at}`] = entry.slice(0, split);
      env[`GIT_CONFIG_VALUE_${at}`] = entry.slice(split + 1);
    });
    return env;
  };

  const runner = (remote: GitRemote, env: NodeJS.ProcessEnv) => (args: readonly string[], options: RunOptions = {}) => new Promise<Buffer>((resolve, reject) => {
    const child = execFile(binary, args, { cwd: options.cwd ?? tmpdir(), env: { ...env, ...options.env }, encoding: "buffer", maxBuffer: MAX_OUTPUT_BYTES, timeout: options.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(t("This server cannot run Git")));
        return;
      }
      const said = stderr.toString("utf8").replace(/\s+/gu, " ").trim().slice(0, 500);
      // It has no reason to repeat a token, but this ends up on a settings page, so it does not get the chance.
      reject(new Error((said || (error.killed ? t("Git took too long") : error.message)).replaceAll(remote.token || "\0", "…")));
    });
    // Git may be gone before it has read this, which it says for itself when it exits.
    child.stdin?.on("error", () => undefined);
    if (options.input !== undefined) child.stdin!.end(options.input);
  });

  const headOf = async (remote: GitRemote, git: ReturnType<typeof runner>) => (await git(["ls-remote", "--", remote.repository, `refs/heads/${remote.branch}`], { network: true })).toString("utf8").split(/\s/u, 1)[0] || null;

  return {
    async head(remote) {
      return headOf(remote, runner(remote, environment(remote, await pinned(remote.repository))));
    },

    async open(remote): Promise<GitWorkspace> {
      const env = environment(remote, await pinned(remote.repository));
      const outside = runner(remote, env);
      const directory = await mkdtemp(join(tmpdir(), "pandocs-git-"));
      const git = (args: readonly string[], options: RunOptions = {}) => outside(args, { cwd: directory, ...options });
      const dispose = () => rm(directory, { recursive: true, force: true });
      try {
        const remoteHead = await headOf(remote, outside);
        await git(["init", "--quiet", `--object-format=${remoteHead?.length === 64 ? "sha256" : "sha1"}`, `--initial-branch=${remote.branch}`, "."]);
        await git(["remote", "add", "origin", remote.repository]);
        const files = new Map<string, string>();
        let head: string | null = null;
        let author: GitWorkspace["author"] = null;
        if (remoteHead) {
          // The history is not needed, and the files only as they are asked for.
          await git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "--no-tags", "origin", `+refs/heads/${remote.branch}:refs/remotes/origin/${remote.branch}`], { network: true });
          head = (await git(["rev-parse", `refs/remotes/origin/${remote.branch}`])).toString("utf8").trim();
          const [name = "", subject = ""] = (await git(["log", "-1", "--format=%an%x00%s", head])).toString("utf8").trim().split("\0");
          author = { name, subject };
          for (const entry of (await git(["ls-tree", "-r", "-z", "--full-tree", head])).toString("utf8").split("\0")) {
            // Plain files only. A link in a repository points nowhere that means anything here.
            const match = /^100\d{3} blob ([0-9a-f]+)\t(.+)$/su.exec(entry);
            if (match) files.set(match[2]!, match[1]!);
          }
        }
        return {
          head,
          author,
          files,
          async prefetch(paths) {
            if (paths.length < 2) return;
            const blobs = paths.flatMap(path => files.get(path) ?? []);
            // Asking for them together is one round trip instead of one each. A host that will not do this has already sent them, or will send them one at a time.
            await git(["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--quiet", "origin", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin"], { network: true, input: `${blobs.join("\n")}\n` }).catch(() => undefined);
          },
          async read(path) {
            const blob = files.get(path);
            if (!blob) throw new Error(t("{0} is not in the repository", path));
            return git(["cat-file", "blob", blob], { network: true });
          },
          async commit({ write, remove, message, author: who }) {
            const withIndex = { GIT_INDEX_FILE: join(directory, ".index") };
            if (head) await git(["read-tree", head], { env: withIndex });
            const entries: string[] = [];
            for (const { path, bytes } of write) {
              const blob = (await git(["hash-object", "-w", "--stdin"], { input: bytes })).toString("utf8").trim();
              entries.push(`100644 ${blob}\t${path}`);
            }
            for (const path of remove) entries.push(`0 ${"0".repeat(head?.length ?? 40)}\t${path}`);
            await git(["update-index", "-z", "--index-info"], { env: withIndex, input: `${entries.join("\0")}\0` });
            // Unchanged files have not been downloaded, and do not need to be for this.
            const tree = (await git(["write-tree", "--missing-ok"], { env: withIndex })).toString("utf8").trim();
            const created = (await git(["commit-tree", tree, ...(head ? ["-p", head] : []), "-F", "-"], {
              env: { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: "Pandocs", GIT_COMMITTER_EMAIL: who.email },
              input: `${message}\n`
            })).toString("utf8").trim();
            await git(["push", "--quiet", "origin", `${created}:refs/heads/${remote.branch}`], { network: true });
            return created;
          },
          dispose
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    }
  };
}

/** Whether there is a Git to run at all, so that the feature can say so where it is offered. */
export function gitIsInstalled(binary = "git"): boolean {
  return spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0;
}
