import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBlobId, type GitRemote } from "@pandocs/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitPort, gitIsInstalled } from "../src/git.js";
import { GitHost, hasGit } from "./git-host.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const author = { name: "Ada", email: "ada@example.com" };

describe.skipIf(!hasGit)("talking to a Git host", () => {
  const host = new GitHost();
  const git = createGitPort({ allowPrivate: true });
  let repoNo = 0;
  let name = "";
  let remote: GitRemote;

  beforeAll(() => host.start());
  afterAll(() => host.stop());
  beforeEach(() => {
    repoNo += 1;
    name = `repo-${repoNo}`;
    remote = { repository: host.create(name), branch: "main", token: "" };
    host.requiredAuthorization = null;
    host.requests.length = 0;
  });

  it("starts an empty repository, as whoever the commit is for, committed by Pandocs", async () => {
    expect(await git.head(remote)).toBeNull();
    const workspace = await git.open(remote);
    expect(workspace.head).toBeNull();
    expect(workspace.author).toBeNull();
    expect(workspace.files.size).toBe(0);
    const commit = await workspace.commit({ write: [{ path: "guide.md", bytes: bytes("# Guide\n") }, { path: "a/b/c.md", bytes: bytes("Deep\n") }], remove: [], message: "First commit\n\nWith a body", author });
    await workspace.dispose();
    expect(await git.head(remote)).toBe(commit);
    expect(host.head(name)).toBe(commit);
    const person = host.person(name);
    expect(person.files).toEqual(["a/b/c.md", "guide.md"]);
    expect(person.read("a/b/c.md")).toBe("Deep\n");
    expect(person.log("%an <%ae>|%cn|%s|%b")).toBe("Ada <ada@example.com>|Pandocs|First commit|With a body");
  });

  it("starts a branch that does not exist yet, on top of nothing", async () => {
    host.person(name).commit({ "main.md": "Main\n" }, "On main");
    const other = { ...remote, branch: "docs/next" };
    expect(await git.head(other)).toBeNull();
    const workspace = await git.open(other);
    const commit = await workspace.commit({ write: [{ path: "guide.md", bytes: bytes("Guide\n") }], remove: [], message: "Hello", author });
    await workspace.dispose();
    expect(host.head(name, "docs/next")).toBe(commit);
  });

  it("reads files exactly as they are, each by the identifier Git gives it, and who last committed", async () => {
    const binary = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 10]);
    const commit = host.person(name).commit({ "guide.md": "One\r\nTwo\n", "picture.png": binary, "名前 with space.md": "Hello\n" }, "Add some files");
    const workspace = await git.open(remote);
    expect(workspace.head).toBe(commit);
    expect(workspace.author).toEqual({ name: "Grace", subject: "Add some files" });
    expect([...workspace.files.keys()].sort()).toEqual(["guide.md", "picture.png", "名前 with space.md"].sort());
    expect(workspace.files.get("guide.md")).toBe(gitBlobId(bytes("One\r\nTwo\n")));
    expect(workspace.files.get("picture.png")).toBe(gitBlobId(binary));
    expect(new Uint8Array(await workspace.read("picture.png"))).toEqual(binary);
    expect(Buffer.from(await workspace.read("guide.md")).toString()).toBe("One\r\nTwo\n");
    expect(Buffer.from(await workspace.read("名前 with space.md")).toString()).toBe("Hello\n");
    await expect(workspace.read("nothing.md")).rejects.toThrow(/nothing\.md/u);
    await workspace.dispose();
  });

  it("only downloads what it is asked for, and several things in one go", async () => {
    host.person(name).commit({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n", "d.md": "D\n" }, "Files");
    host.requests.length = 0;
    const workspace = await git.open(remote);
    const opening = host.uploadPackRequests();
    await workspace.read("a.md");
    const first = host.uploadPackRequests();
    expect(first).toBeGreaterThan(opening);
    await workspace.prefetch(["b.md", "c.md", "d.md"]);
    const together = host.uploadPackRequests();
    expect(Buffer.from(await workspace.read("b.md")).toString()).toBe("B\n");
    expect(Buffer.from(await workspace.read("c.md")).toString()).toBe("C\n");
    expect(Buffer.from(await workspace.read("d.md")).toString()).toBe("D\n");
    expect(host.uploadPackRequests()).toBe(together);
    await workspace.dispose();
  });

  it("commits on top of what is there, leaving alone what it never downloaded", async () => {
    host.person(name).commit({ "keep.md": "Keep\n", "change.md": "One\n", "gone.md": "Gone\n", "my file.md": "Mine\n" }, "Files");
    const workspace = await git.open(remote);
    const commit = await workspace.commit({ write: [{ path: "change.md", bytes: bytes("Two\n") }, { path: "docs/新しい file.md", bytes: bytes("New\n") }], remove: ["gone.md", "my file.md"], message: "Change things", author });
    await workspace.dispose();
    expect(host.head(name)).toBe(commit);
    const person = host.person(name);
    expect(person.files).toEqual(["change.md", "docs/\"\\346\\226\\260\\343\\201\\227\\343\\201\\204 file.md\"".replace(/^docs\/"(.*)"$/u, "\"docs/$1\""), "keep.md"].sort());
    expect(person.read("keep.md")).toBe("Keep\n");
    expect(person.read("change.md")).toBe("Two\n");
    expect(person.read("docs/新しい file.md")).toBe("New\n");
  });

  it("is refused when the branch has moved on since it looked, and nothing is lost", async () => {
    const person = host.person(name);
    person.commit({ "guide.md": "One\n" }, "First");
    const workspace = await git.open(remote);
    person.pull();
    const theirs = person.commit({ "other.md": "Theirs\n" }, "In between");
    await expect(workspace.commit({ write: [{ path: "guide.md", bytes: bytes("Two\n") }], remove: [], message: "Too late", author })).rejects.toThrow(/./u);
    await workspace.dispose();
    expect(host.head(name)).toBe(theirs);
  });

  it("does not follow links, which point nowhere that means anything here", async () => {
    const person = host.person(name);
    person.link("evil.md", "/etc/passwd");
    person.commit({ "real.md": "Real\n" }, "A link");
    const workspace = await git.open(remote);
    expect([...workspace.files.keys()]).toEqual(["real.md"]);
    await workspace.dispose();
  });

  it("works with a repository using the newer kind of identifiers", async () => {
    const sha256 = { repository: host.create(`${name}-sha256`, "sha256"), branch: "main", token: "" };
    const person = host.person(`${name}-sha256`);
    const first = person.commit({ "guide.md": "One\n", "gone.md": "Gone\n" }, "First");
    expect(first).toHaveLength(64);
    expect(await git.head(sha256)).toBe(first);
    const workspace = await git.open(sha256);
    expect(workspace.head).toBe(first);
    expect(workspace.files.get("guide.md")).toBe(gitBlobId(bytes("One\n"), "sha256"));
    expect(Buffer.from(await workspace.read("guide.md")).toString()).toBe("One\n");
    const commit = await workspace.commit({ write: [{ path: "guide.md", bytes: bytes("Two\n") }], remove: ["gone.md"], message: "Second", author });
    await workspace.dispose();
    expect(commit).toHaveLength(64);
    const again = host.person(`${name}-sha256`);
    expect(again.files).toEqual(["guide.md"]);
    expect(again.read("guide.md")).toBe("Two\n");
  });

  it("removes its copy afterwards, and when opening fails", async () => {
    host.person(name).commit({ "guide.md": "One\n" }, "First");
    const scratch = mkdtempSync(join(tmpdir(), "pandocs-git-tmp-"));
    const before = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      const workspace = await git.open(remote);
      expect(readdirSync(scratch)).toHaveLength(1);
      await workspace.dispose();
      expect(readdirSync(scratch)).toEqual([]);
      await expect(git.open({ ...remote, repository: host.url("nothing-here") })).rejects.toThrow(/./u);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("says something useful when the repository is not there", async () => {
    await expect(git.head({ ...remote, repository: host.url("nothing-here") })).rejects.toThrow(/not found|nothing-here/iu);
  });

  describe("with a token", () => {
    const token = "ghp_secretsecretsecret";
    const header = (credentials: string) => `Basic ${Buffer.from(credentials).toString("base64")}`;

    it("sends it as a password, so it works on any host, for reading, downloading and pushing", async () => {
      host.person(name).commit({ "guide.md": "One\n" }, "First");
      host.requiredAuthorization = header(`x-access-token:${token}`);
      const authed = { ...remote, token };
      expect(await git.head(authed)).toBe(host.head(name));
      const workspace = await git.open(authed);
      expect(Buffer.from(await workspace.read("guide.md")).toString()).toBe("One\n");
      await workspace.commit({ write: [{ path: "guide.md", bytes: bytes("Two\n") }], remove: [], message: "Second", author });
      await workspace.dispose();
      expect(host.person(name).read("guide.md")).toBe("Two\n");
    });

    it("takes a user name too, for hosts that care", async () => {
      host.requiredAuthorization = header("oauth2:abc");
      expect(await git.head({ ...remote, token: "oauth2:abc" })).toBeNull();
    });

    it("fails without asking anyone anything, and without saying what the token is", async () => {
      host.requiredAuthorization = header(`x-access-token:${token}`);
      await expect(git.head(remote)).rejects.toThrow(/./u);
      const wrong = await git.head({ ...remote, token: "wrong-token-value" }).catch((error: Error) => error.message);
      expect(wrong).toEqual(expect.any(String));
      expect(wrong).not.toContain("wrong-token-value");
      expect(wrong).not.toContain(Buffer.from("x-access-token:wrong-token-value").toString("base64"));
    });

    it("hides it even if something repeats it", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pandocs-git-wrapper-"));
      const wrapper = join(dir, "git");
      writeFileSync(wrapper, `#!/bin/sh\necho "fatal: could not use ${token}" >&2\nexit 1\n`);
      chmodSync(wrapper, 0o755);
      const message = await createGitPort({ allowPrivate: true, binary: wrapper }).head({ ...remote, token }).catch((error: Error) => error.message);
      expect(message).toContain("could not use");
      expect(message).not.toContain(token);
      rmSync(dir, { recursive: true, force: true });
    });

    it("never puts it on a command line, where anyone on the machine could read it", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pandocs-git-wrapper-"));
      const log = join(dir, "log");
      const wrapper = join(dir, "git");
      writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec git "$@"\n`);
      chmodSync(wrapper, 0o755);
      host.person(name).commit({ "guide.md": "One\n" }, "First");
      host.requiredAuthorization = header(`x-access-token:${token}`);
      const logged = createGitPort({ allowPrivate: true, binary: wrapper });
      const authed = { ...remote, token };
      await logged.head(authed);
      const workspace = await logged.open(authed);
      await workspace.read("guide.md");
      await workspace.commit({ write: [{ path: "guide.md", bytes: bytes("Two\n") }], remove: [], message: "Second", author });
      await workspace.dispose();
      const commands = readFileSync(log, "utf8");
      expect(commands).toContain("ls-remote");
      expect(commands).toContain("push");
      expect(commands).not.toContain(token);
      expect(commands).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
      rmSync(dir, { recursive: true, force: true });
    });

    it("does not send it on to wherever a host redirects to", async () => {
      const elsewhere: (string | undefined)[] = [];
      const collector = createServer((request, response) => {
        elsewhere.push(request.headers.authorization);
        response.writeHead(404).end();
      });
      await new Promise<void>(done => {
        collector.listen(0, "127.0.0.1", done);
      });
      const redirector = createServer((request, response) => {
        response.writeHead(302, { Location: `http://127.0.0.1:${(collector.address() as AddressInfo).port}${request.url ?? "/"}` }).end();
      });
      await new Promise<void>(done => {
        redirector.listen(0, "127.0.0.1", done);
      });
      try {
        const repository = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/repo.git`;
        await expect(git.head({ repository, branch: "main", token })).rejects.toThrow(/./u);
        expect(elsewhere).toEqual([]);
      } finally {
        redirector.close();
        collector.close();
      }
    });
  });

  describe("on a server that may not reach private networks", () => {
    const careful = createGitPort({ allowPrivate: false });

    it.each(["127.0.0.1", "localhost", "[::1]", "10.0.0.8", "192.168.1.1", "169.254.169.254"])("refuses %s before connecting", async address => {
      const repository = `http://${address}:9/repo.git`;
      await expect(careful.head({ repository, branch: "main", token: "t" })).rejects.toThrow(/private network/iu);
      await expect(careful.open({ repository, branch: "main", token: "t" })).rejects.toThrow(/private network/iu);
    });

    it("did not even connect to this one", async () => {
      await expect(careful.head(remote)).rejects.toThrow(/private network/iu);
      expect(host.requests).toEqual([]);
    });
  });

  it("says so if there is no Git to run", async () => {
    expect(gitIsInstalled()).toBe(true);
    expect(gitIsInstalled("/nothing/here/git")).toBe(false);
    await expect(createGitPort({ allowPrivate: true, binary: "/nothing/here/git" }).head(remote)).rejects.toThrow(/cannot run Git/iu);
    expect(existsSync("/nothing/here/git")).toBe(false);
  });
});
