import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const hasGit = spawnSync("git", ["--version"]).status === 0;

/** Nothing about the machine running the tests should change how Git behaves in them. */
const quietEnv = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

export const runGit = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: quietEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export interface HostRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

/** Someone with their own clone, working as people do. */
export class Person {
  constructor(private readonly dir: string, private readonly name: string) {}

  commit(files: Readonly<Record<string, string | Uint8Array | null>>, message: string, branch = "main"): string {
    for (const [path, content] of Object.entries(files)) {
      const target = join(this.dir, path);
      if (content === null) {
        rmSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    runGit(this.dir, "add", "-A");
    runGit(this.dir, "-c", `user.name=${this.name}`, "-c", "user.email=someone@example.com", "commit", "--quiet", "-m", message);
    runGit(this.dir, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    return runGit(this.dir, "rev-parse", "HEAD");
  }

  pull(branch = "main"): void {
    runGit(this.dir, "pull", "--quiet", "--rebase", "origin", branch);
  }

  link(path: string, target: string): void {
    execFileSync("ln", ["-s", target, join(this.dir, path)]);
  }

  read(path: string): string {
    return execFileSync("cat", [join(this.dir, path)], { encoding: "utf8" });
  }

  get files(): string[] {
    return runGit(this.dir, "ls-files").split("\n").filter(Boolean).sort();
  }

  log(format: string): string {
    return runGit(this.dir, "log", "-1", `--format=${format}`);
  }
}

/** A Git host on this machine: Git's own HTTP server program, behind a small web server that can ask for a password. */
export class GitHost {
  readonly requests: HostRequest[] = [];
  /** What the Authorization header has to say, if anything. */
  requiredAuthorization: string | null = null;
  private readonly root = mkdtempSync(join(tmpdir(), "pandocs-git-host-"));
  private readonly scratch: string[] = [];
  private server!: Server;
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://host.test");
      this.requests.push({ method: request.method ?? "", url: url.pathname + url.search, authorization: request.headers.authorization });
      if (this.requiredAuthorization !== null && request.headers.authorization !== this.requiredAuthorization) {
        response.writeHead(401, { "WWW-Authenticate": "Basic realm=\"test\"" }).end();
        return;
      }
      const child = spawn("git", ["http-backend"], {
        env: {
          ...quietEnv,
          GIT_PROJECT_ROOT: this.root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          ...(request.headers["content-length"] ? { CONTENT_LENGTH: request.headers["content-length"] } : {}),
          ...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] } : {}),
          ...(request.headers["git-protocol"] ? { HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"]) } : {}),
          REMOTE_USER: "someone",
          REMOTE_ADDR: "127.0.0.1"
        }
      });
      request.pipe(child.stdin);
      let head: Buffer = Buffer.alloc(0);
      let sent = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (sent) {
          response.write(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
          const split = line.indexOf(":");
          const name = line.slice(0, split).trim();
          const value = line.slice(split + 1).trim();
          if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
          else headers[name] = value;
        }
        response.writeHead(status, headers);
        response.write(head.subarray(end + 4));
        sent = true;
      });
      child.stdout.on("end", () => response.end());
    });
    await new Promise<void>(done => {
      this.server.listen(0, "127.0.0.1", done);
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise(done => {
      this.server.close(done);
    });
    rmSync(this.root, { recursive: true, force: true });
    for (const dir of this.scratch) rmSync(dir, { recursive: true, force: true });
  }

  /** Makes an empty repository, and says where to reach it. */
  create(name: string, objectFormat: "sha1" | "sha256" = "sha1"): string {
    const bare = join(this.root, `${name}.git`);
    mkdirSync(bare);
    runGit(bare, "init", "--quiet", "--bare", `--object-format=${objectFormat}`, "--initial-branch=main");
    runGit(bare, "config", "http.receivepack", "true");
    runGit(bare, "config", "uploadpack.allowFilter", "true");
    runGit(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
    return this.url(name);
  }

  url(name: string): string {
    return `http://127.0.0.1:${this.port}/${name}.git`;
  }

  person(name: string, who = "Grace"): Person {
    const dir = mkdtempSync(join(tmpdir(), "pandocs-git-clone-"));
    this.scratch.push(dir);
    runGit(dir, "clone", "--quiet", join(this.root, `${name}.git`), ".");
    return new Person(dir, who);
  }

  /** Where the branch is, straight from the repository. */
  head(name: string, branch = "main"): string | null {
    try {
      return runGit(join(this.root, `${name}.git`), "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    } catch {
      return null;
    }
  }

  uploadPackRequests(): number {
    return this.requests.filter(request => request.method === "POST" && request.url.includes("git-upload-pack")).length;
  }
}
