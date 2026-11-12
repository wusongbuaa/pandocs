import { createHash } from "node:crypto";
import { gitBlobId, type GitPort, type GitRemote, type GitWorkspace } from "@pandocs/core";

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

/** A repository in memory, which behaves as a host does: it refuses a push made on top of anything but where the branch is now. */
export class FakeRepository implements GitPort {
  readonly files = new Map<string, Uint8Array>();
  readonly pushes: { message: string; author: string; write: string[]; remove: string[] }[] = [];
  readonly remotes: GitRemote[] = [];
  latest: string | null = null;
  who = { name: "Ada", subject: "Say it better" };
  looks = 0;
  opens = 0;
  reads = 0;
  failure: Error | null = null;
  /** Someone gets in between the copy and the push, once. */
  beforePush: (() => void) | null = null;
  /** Something happens while a file is being read, once. */
  onRead: (() => Promise<void>) | null = null;
  private count = 0;

  private next(): string {
    this.count += 1;
    return createHash("sha1").update(String(this.count)).digest("hex");
  }

  /** Someone commits to the repository from outside. Null removes a file. */
  commit(files: Readonly<Record<string, string | Uint8Array | null>>, subject = "Say it better", name = "Ada"): void {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) this.files.delete(path);
      else this.files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
    }
    this.who = { name, subject };
    this.latest = this.next();
  }

  async head(remote: GitRemote): Promise<string | null> {
    this.looks += 1;
    this.remotes.push(remote);
    if (this.failure) throw this.failure;
    return this.latest;
  }

  async open(remote: GitRemote): Promise<GitWorkspace> {
    this.opens += 1;
    this.remotes.push(remote);
    if (this.failure) throw this.failure;
    const copyOf = this.latest;
    const copy = new Map(this.files);
    return {
      head: copyOf,
      author: copyOf ? this.who : null,
      files: new Map([...copy].map(([path, bytes]) => [path, gitBlobId(bytes)])),
      prefetch: async () => undefined,
      read: async path => {
        this.reads += 1;
        const happening = this.onRead;
        this.onRead = null;
        await happening?.();
        const bytes = copy.get(path);
        if (!bytes) throw new Error(`${path} is not there`);
        return bytes;
      },
      commit: async ({ write, remove, message, author }) => {
        this.beforePush?.();
        this.beforePush = null;
        if (this.latest !== copyOf) throw new Error("rejected: the branch has moved on");
        for (const { path, bytes } of write) this.files.set(path, bytes);
        for (const path of remove) this.files.delete(path);
        this.pushes.push({ message, author: author.name, write: write.map(item => item.path).sort(), remove: [...remove].sort() });
        this.latest = this.next();
        return this.latest;
      },
      dispose: async () => undefined
    };
  }

  read(path: string): string | undefined {
    return text(this.files.get(path));
  }

  get paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
