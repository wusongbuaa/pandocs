# Git sync

A space can be kept the same as a folder of a Git repository, in both directions. Someone can edit a page in the browser, or change the file in the repository and push. Each gets the other's work, usually within a minute.

Space administrators set it up under **Git sync** in the space's management pages. It needs the repository's HTTPS address, a branch, and an access token that can read and push. Leave the folder empty to use the whole repository. Nothing outside the folder is touched.

Repositories are reached over HTTP or HTTPS only, not SSH. Use the address you would clone from, usually ending in `.git`, because a host's redirects are not followed.

On GitHub that is a fine-grained token with Contents read and write, and on GitLab a project access token with `write_repository`. It is sent as a password, with `x-access-token` as the user name. For a host that wants a particular user name, write `name:token`.

The token is never shown again. It goes only to the repository it was given for: changing the address needs a new one, and a host cannot have it passed on through a redirect.

## How pages and files correspond

| In the space | In the repository |
| --- | --- |
| A page at `guide/start` | `<folder>/guide/start.md` |
| A page with no text that holds others | A folder, with no file of its own |
| An image | `<folder>/assets/<hash>.<ext>`, linked relative to the page's file |
| Titles, order and labels | `<folder>/.pandocs/pages.json` |

Files that are not named `.md`, and anything in a folder whose name starts with a dot, such as `.github`, are not pages. They are left as they are. A page's title comes from `pages.json`, then `title:` in the file's front matter, then its first heading, then its file name.

Images a file points to by its own path, such as `![](images/a.png)`, are stored with the page. The file keeps saying what it says until someone next edits the page, when its images move to `assets/`.

Comments, suggestions, translations and who can read what are not in the repository. Pages only some people can read stay out of it too, unless you tick the box saying otherwise. When a page becomes restricted, its file is removed.

## What happens when

Each commit from the repository is a new version of the pages it changes, under the name of whoever made it. Saves here are sent together, and the commit lists which pages at which version, under the name of whoever made them when that is one person.

| In the repository | Here | Result |
| --- | --- | --- |
| A file changed | Page unchanged | The page gets a new version |
| A file changed | Page changed elsewhere in the text | Both changes are merged, and the result is sent back |
| A file changed | Page changed in the same place | The page keeps its text and the repository is given it too. What the file said becomes a suggestion on the page, so a person decides, and nothing is lost |
| A new file | No such page | A new page, along with pages for any folders it needs |
| A new file | A page with text at that address | As for the same place changing |
| A file renamed | Page unchanged or changed | The page moves and keeps its comments, and its old address keeps working. If the commit also edited the file, it still counts as a rename when at least half of its lines are the same, about what Git itself goes by, and the edit then applies as for any changed file |
| A file deleted | Page unchanged | The page goes to the trash. If pages below it remain, it stays as a page with no text |
| A file deleted | Page changed | The page stays and its file comes back |
| A file changed | Page deleted | The page is created again, since someone has just worked on it |

The first sync has no history to go on, so if a page and a file have the same address and different text, the choice you made when connecting decides. Files and pages only on one side are copied to the other either way.

A branch with nothing on it was deleted, which is different from someone deleting every page: it gets everything back. Pointing the settings at another repository, branch or folder starts by comparing again, and deletes nothing.

## Spaces where everything goes through review

If a space requires [change sets](./design.md#writes), what comes from the repository goes into a change set, "From Git: …", and stays there until someone merges it. Later commits are added to the same one while it is open. Renames are a deletion and a new page there.

The repository keeps what it says meanwhile. Closing the change set means no: the pages keep their text, the repository is given it, and files for new pages are removed. Git's history has what they said.

What is sent to the repository does not go through review, as it is already what the space says.

## When it syncs

It asks the repository where the branch is about once a minute, and within a few seconds of a page being saved. To be quicker, add the address shown on the settings page as a push webhook in the repository. Anyone who has that address can do no more than make a sync come sooner.

Each sync makes a fresh, partial copy in a temporary directory, without checking anything out. Only files that changed are downloaded, and what was last the same is in the database, so any replica can do the next one. Pushing onto a branch that moved in the meantime fails, and the next sync starts again from what it finds.

A failure is shown on the settings page, and it tries again after one, five and then thirty minutes. Files it could not take, such as a name that cannot be an address, one larger than 2 MiB or one that is not text, are listed in its record along with the reason, and do not hold up the others.

## Things it does not do

- **Protected branches.** It pushes straight to the branch. If the host requires pull requests there, the push fails and the failure says why.
- **Git LFS.** A file in LFS comes through as the small text file Git has for it.
- **SSH addresses and SSH keys.**
- **Submodules and symbolic links.** They are ignored.
- **Moving a page within a change set.** That is not part of change sets yet, in either direction.

## Running it

The Docker image includes Git. Elsewhere, `git` 2.37 or newer has to be on the server's `PATH`. Without it the settings page says so, and everything else works as usual.

Repositories on private networks, loopback and cloud metadata addresses are refused, checked when connecting and pinned so that a name cannot later resolve somewhere else. For a host inside your own network, set `PANDOCS_GIT_ALLOW_PRIVATE=true`. `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are respected, and with a proxy it is the proxy that resolves the name. `GIT_SSL_CAINFO` and `SSL_CERT_FILE` work for a private certificate authority.

Workers do this work, so a deployment with separate roles needs Git on those.
