---
title: Files and the command line
---

Agents often want files. But what is true is in the database, and files are **copies**: reading them is free, and changing what is true always goes through the server. So there is never a second source of truth, whichever way people come in.

| | Reads | Writes |
| --- | --- | --- |
| Web | Live | Saved as versions |
| API, MCP, `pandocs call` | Live, filtered per person | Versions, or suggestions for agents |
| `pandocs sync` | A local copy, filtered per person | `pandocs commit` |
| Shared directory | A read-only copy of chosen spaces, the same for everyone | Not possible by design |

## The command line

A single binary for macOS, Linux and Windows, with no runtime to install. `login` opens the site in your browser for you to say yes, then stays signed in until `pandocs logout`. For a script or CI, use a token from **Account and tokens** instead, with `pandocs login --token` or `PANDOCS_TOKEN`.

```bash
pandocs login --server https://docs.example.com
pandocs sync handbook          # into ./handbook
cd handbook
$EDITOR getting-started.md
pandocs status
pandocs commit -m "Fix the first step"
```

- **`sync` never overwrites your work.** A file is only replaced if it still matches what the server last gave you. With `--watch` it stays current within about a second.
- **`commit` names the version each edit started from.** If the page moved on, the server merges by block, and the result comes back to your file. If you both changed the same place, it stops with exit code 3 and leaves both versions alone.
- **With an agent token, `commit` proposes.** Edits become suggestions and new files become imports, for a person to decide. Anyone can ask for the same with `--propose`.
- **Changes to review together.** `pandocs commit --change-set "Title"` puts everything into one [change set](../collaboration/change-sets.md).

`pandocs tools` and `pandocs call <tool>` reach everything the server offers, so new server features work without a new binary.

## A shared directory

For many sandboxes sharing a file system, or ones with no way to the server, publish chosen spaces to a shared directory. Nothing runs in the sandbox, and any tool that reads files works. NFS, Tencent CFS, AWS EFS, Alibaba NAS or a plain directory will do.

```bash
PANDOCS_PUBLISH_DIR=/mnt/shared/pandocs
PANDOCS_PUBLISH_SPACES=handbook,guide   # or * for all of them
```

Anyone with the mount can read what is published, so the list is required and has no default. Restricted pages and the images only they use are never written.

Each space becomes:

```tree
handbook
├── getting-started.md
├── getting-started
│   └── first-steps.md
├── assets
│   └── <sha256>.png
├── llms.txt
└── .pandocs
    ├── README.md          # How this works, for an agent finding it cold
    ├── MANIFEST.json      # Every file, with its hash and version
    ├── CURRENT            # A small file that changes whenever anything does
    ├── CHANGES.ndjson     # What changed recently
    └── pack.tar.gz        # Every page in one file, for unpacking locally
```

## What readers of a shared directory should know

Measured on a kernel NFS server with two separate clients, 10,000 pages and default mount options, which is not any particular cloud's service. Treat the numbers as a guide and the rules as what matters.

- **Reading a file by name gives its current content, and never half a file.** Files are replaced by rename, never rewritten in place. A save reached another client in about half a second on NFSv4, and about 6 seconds on NFSv3.
- **To find new files, list a directory or read `MANIFEST.json`.** Clients can remember for up to a minute that a path was missing. `lookupcache=positive` removes that wait.
- **To poll, read `CURRENT`.** `stat` can lag by tens of seconds, and file-change notifications do not cross NFS clients.
- **To search everything, unpack `pack.tar.gz` locally first.** `grep` across 10,000 files took 80 seconds over NFS and 26 milliseconds locally. The pack can be a few minutes behind.

:::tip

Nothing depends on these files. Delete the directory and it is rebuilt. If something changes files inside it, the next round puts them right.

:::

## Reacting to changes

- `GET /api/v1/events`: changes as Server-Sent Events, filtered per person. Reconnect with `Last-Event-ID` to catch up.
- `GET /api/v1/changes?since=<next>`: the same by polling.
- `GET /api/v1/spaces/{space}/manifest` and `/snapshot`: a space as files.
