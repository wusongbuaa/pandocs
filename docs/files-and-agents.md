# Files and agents

Pandocs keeps its documents in PostgreSQL and object storage. Agents often want files. This page explains how the two meet without creating a second source of truth.

## The rule

Files are a **projection**. The database is what is true, and a copy on disk is derived from it. Reading files is free. Changing what is true always goes through the server, which records who did it, checks the revision they started from, and merges or refuses. Two people can never silently overwrite each other, whichever way they came in.

| | Reads | Writes |
| --- | --- | --- |
| Web | Live | Saved as revisions |
| API, MCP, `pandocs call` | Live, filtered per person | Revisions, or proposals for agents |
| `pandocs sync` | A local copy, filtered per person | `pandocs commit` |
| Shared directory | Read-only copy of chosen spaces, the same for everyone with the mount | Not possible by design |

## Which one to use

**One agent, or a few, with network access to the server:** `pandocs sync`. Each copy holds exactly what that token may read, including restricted pages it has been given. With `--watch` it stays current within about a second.

**Many sandboxes with a shared file system, or none with a way to the server:** publish to a shared directory, and mount it read-only. Nothing to run in the sandbox, and any tool that reads files works.

**An agent that speaks MCP:** connect it to `/mcp` with an agent token, or run `pandocs mcp` for one that only speaks stdio. It needs no files at all.

## Publishing to a shared directory

Works on anything POSIX-like: NFS, Tencent CFS, AWS EFS, Alibaba NAS, or a plain directory.

```bash
PANDOCS_PUBLISH_DIR=/mnt/shared/pandocs
PANDOCS_PUBLISH_SPACES=handbook,guide   # or * for all of them
```

Anyone with the mount can read what is published, so the list is required and has no default. Restricted pages and the images only they use are never written. A space taken off the list is removed on the next full round, within five minutes.

Each space becomes:

```
handbook/
  getting-started.md
  getting-started/first-steps.md
  assets/<sha256>.png
  llms.txt
  .pandocs/
    README.md          How this directory works, for an agent finding it cold
    MANIFEST.json      Every file, with its hash and revision
    CURRENT            A small file that changes whenever anything does
    CHANGES.ndjson     What changed recently
    pack.tar.gz        Every page in one file, for unpacking to a local disk
```

Any number of replicas can publish. A lock lets one do it, and another takes over within seconds if it goes away. `LISTEN` and that lock need a direct connection, so if `DATABASE_URL` points at a pooler in transaction mode, set `PANDOCS_DATABASE_LISTEN_URL`.

Publishing runs in a process of its own, so a mount that hangs only delays the files, and pages keep being served. An NFS server that restarts holds new writes back for about 90 seconds, for example. To keep the mount off the replicas serving pages altogether, run one or two with `PANDOCS_ROLES=publisher` and set `PANDOCS_PUBLISH_DIR` only on those.

Nothing depends on these files. Delete the directory and it is rebuilt. If something changes or removes files inside it, the next full round puts them right.

### What readers should know

Measured on a kernel NFS server with two separate clients, 10,000 pages and default mount options. `test/nfs/run.sh` repeats all of it. This is not any particular cloud's service, so treat the numbers as a guide and the rules as what matters.

- **Reading a file by name gives its current content, and never half a file.** Files are replaced by rename, never rewritten in place: 21,516 reads of a 512 KB page during 91 rewrites found no partial read. A save reached another client in about half a second on NFSv4 (at most 1.2 s), and in about 6 seconds on NFSv3.
- **Finding new files: list a directory or read `MANIFEST.json`.** Asking for a path that did not exist a moment ago can keep failing for up to a minute, because clients remember that it was missing. `lookupcache=positive` removes that wait.
- **Polling: read `CURRENT`.** Do not rely on `stat`, which can lag by tens of seconds, or on file-change notifications, which do not cross NFS clients at all.
- **Searching everything: unpack `pack.tar.gz` to a local disk first.** `grep` across 10,000 files took 80 seconds over NFS and 26 milliseconds locally, and `pandocs sync --from` brought those files to a local disk in 0.6 seconds. The pack can be a few minutes behind, and comes with its own manifest.
- **Use NFSv4 where you can.** Besides being faster to catch up, on NFSv3 a process holding a file open gets a stale handle error if the file is replaced.

## The command line

Install it with npm, which picks the binary for your system:

```bash
npm install -g @pandocs/cli
```

Or run it with no install, as `npx @pandocs/cli <command>`. Without Node, take the single binary for macOS, Linux or Windows from the releases page, where each comes with a checksum and signed provenance. Both are the same build.

Then sign in, which opens the site in your browser for you to say yes:

```bash
pandocs login --server https://docs.example.com
pandocs sync handbook          # into ./handbook
cd handbook
$EDITOR getting-started.md
pandocs status
pandocs commit -m "Fix the first step"
```

It stays signed in as you on this computer, renewing itself each hour, until `pandocs logout`, which also ends it on the server. **Connected apps** on your account page shows it, and signs it out from there too. The address the browser comes back to is on `127.0.0.1`, so over SSH or in a container `login` prints the page to open, and forwarding its port gets the answer back. Or use a token from your account page: `pandocs login --token` asks for it without showing it, and `pandocs login --server URL < token-file` reads it from stdin. Scripts, CI and agents can skip `login` and set `PANDOCS_URL` and `PANDOCS_TOKEN`.

`sync` never overwrites your work. A file is only replaced if it still matches what the server last gave you. A page that moved on the server moves here too, with your changes in it.

`commit` names the revision each edit started from. If the page moved on, the server merges by block, and the merged text comes back to your file. If you both changed the same place it stops with exit code 3 and leaves both versions alone. It says which revision it conflicted with: `pandocs get <space/path> --revision N` shows it. Once you have worked those changes into your file, `pandocs commit --resolved` sends it as made from that revision, so the same conflict does not come back. Anything changed on the server since is merged as usual.

New `.md` files become pages, with any missing pages above them, titled by their first heading. A deleted file only deletes the page with `--delete`.

**With an agent token, `commit` proposes instead.** Edits become proposals and new pages become imports, for someone with edit rights to decide. Anyone can ask for the same with `--propose`.

**To have changes across pages decided together**, `pandocs commit --change-set "Title"` puts everything into one change set, including new pages and, with `--delete`, deleted ones. `--to-change-set <id>` adds to one that exists. Nothing happens to the pages until someone merges it, which they do all at once or not at all.

For a sandbox that has the mount and no way to the server:

```bash
pandocs sync handbook ./work --from /mnt/shared/pandocs/handbook --watch
```

With a server as well, `--from` is just the quick way to most of it, and the server has the last word.

`pandocs tools` and `pandocs call <tool>` reach everything the server offers, and new server features work without a new binary.

## Reacting to changes

- `GET /api/v1/events` streams changes as Server-Sent Events, filtered per person. Reconnect with `Last-Event-ID` to catch up. A `reset` event means too much went by, so compare a manifest instead.
- `GET /api/v1/changes?since=<next>` is the same feed by polling.
- `GET /api/v1/spaces/{space}/manifest` and `/snapshot` give a space as files.

A row in the feed says what changed, not what to do about it. Readers compare against current state, so seeing a row twice is harmless, and a missed one is caught by the next comparison. The `cursor` values are opaque: keep them and hand them back.

Rows appear once they are settled. A write transaction left open on the same PostgreSQL server holds the feed back until it ends. Nothing is lost, but keep long-running writes off that server if you need the feed to be prompt.

## Page names

Pages exist as files on every platform, so their path segments have to work as file names on all of them: no `/ \ < > : " | ? *` or whitespace, no leading or trailing dot, no name like `CON` or `NUL`, not ending in `.md`, and at most 240 bytes. Two pages cannot differ only by case. Titles are turned into names that follow these rules automatically.
