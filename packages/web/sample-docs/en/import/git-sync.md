---
title: Git sync
---

A space can be kept the same as a folder of a Git repository, in both directions. Someone edits a page in the browser, someone else changes the file and pushes, and each usually has the other's work within a minute.

Space administrators set it up under **Git sync** in the space. It needs the repository's HTTPS address, a branch, and an access token that can read and push. Leave the folder empty to use the whole repository. Nothing outside the folder is touched.

:::warning

This has been tested against Git's own HTTP server on one machine, and not against GitHub or GitLab. Try it on a test repository first.

:::

## How pages and files correspond

| In the space | In the repository |
| --- | --- |
| A page at `guide/start` | `<folder>/guide/start.md` |
| A page with no text that holds others | A folder |
| An image | `<folder>/assets/<hash>.<ext>` |
| Titles, order and labels | `<folder>/.pandocs/pages.json` |

Comments, suggestions, translations and who can read what are not in the repository. Pages only some people can read stay out of it too, unless you tick the box saying otherwise.

## When both sides changed

| In the repository | Here | Result |
| --- | --- | --- |
| A file changed | Page unchanged | The page gets a new version |
| A file changed | Page changed elsewhere | Both are merged, and the result is sent back |
| A file changed | Page changed in the same place | The page keeps its text and the repository is given it. What the file said becomes a suggestion for a person to decide, and nothing is lost |
| A new file | No such page | A new page |
| A file renamed | Either way | The page moves and keeps its comments, and its old address keeps working |
| A file deleted | Page unchanged | The page goes to the trash |
| A file deleted | Page changed | The page stays and its file comes back |

If a space requires [change sets](../collaboration/change-sets.md), what comes from the repository goes into one, for someone to merge.

## What it does not do

Protected branches (it pushes straight to the branch, and if the host requires pull requests the push fails and says why), Git LFS, SSH addresses and keys, submodules and symbolic links.

The Docker image includes Git. Elsewhere, `git` 2.37 or newer has to be on the server.
