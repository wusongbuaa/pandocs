<p align="center"><img src="packages/web/public/logo.svg" width="96" height="96" alt=""></p>

<p align="center">
  <a href="https://github.com/wusongbuaa/pandocs/actions/workflows/ci.yml"><img src="https://github.com/wusongbuaa/pandocs/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/wusongbuaa/pandocs/releases/latest"><img src="https://img.shields.io/github/v/release/wusongbuaa/pandocs?sort=semver" alt="Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/wusongbuaa/pandocs" alt="License: Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/@pandocs/client"><img src="https://img.shields.io/npm/v/@pandocs/client?label=%40pandocs%2Fclient" alt="npm"></a>
  <a href="https://pkg.go.dev/github.com/wusongbuaa/pandocs/sdks/go"><img src="https://pkg.go.dev/badge/github.com/wusongbuaa/pandocs/sdks/go.svg" alt="Go Reference"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/wusongbuaa/pandocs"><img src="https://api.scorecard.dev/projects/github.com/wusongbuaa/pandocs/badge" alt="OpenSSF Scorecard"></a>
</p>

# Pandocs

Pandocs puts people and agents on the same page: one source of truth with two ways in. People work on the web, agents work with files and tools, and both end up in the same versioned documents. Its logo is a panda reading over the top of an open book.

[中文说明](./README.zh-CN.md)

![A page of Pandocs' own documentation: the sidebar, the page with its tools for comments, editing, history and following, and its outline](./docs/images/screenshot.png)

- **A dynamic documentation site.** Markdown with blocks for steps, tabs, cards, diagrams, charts, formulas and slides, on the Rspress theme. Nothing to rebuild when a page changes, and pages leave the server finished, with a real 404, a sitemap and share cards. Open a space to the public with one switch, or keep everything behind a login.
- **Answers from your documents.** Ask AI next to the search box finds and reads pages with the permissions of whoever is asking, and links what it says to them. It needs no embeddings or vector database: bring any model with tool calls.
- **Know how the documents are doing.** What is read, by people and by agents, what is searched for and not found, what the AI could not answer, and what readers and agents say is wrong. Counts only, with nothing about who.
- **Edit together.** Everyone editing a page shares one draft and sees each other type, with no database but PostgreSQL, across any number of replicas. What agents and Git save comes into it as it happens, and readers see a version when someone saves. See [Editing together](./docs/live-editing.md).
- **Collaboration on the page.** Select text to comment, suggest edits, accept them piece by piece, and go back through every version.
- **Changes across pages.** Change sets let people and agents change several pages at once, for someone to review together and merge all at once or not at all. A space can require approvals, or that every change goes through review.
- **Made for agents too.** MCP tools an assistant can connect to by signing in, or with no login for public spaces, `llms.txt`, Markdown for every page by address or by asking for it, and tokens that let an agent read, comment and propose while a person decides. Agents never get more than their owner.
- **Git sync.** Keep a space and a folder of a Git repository the same, both ways. Commits become versions under their authors' names, edits here become commits, and what cannot be merged becomes a suggestion for someone to decide. See [Git sync](./docs/git-sync.md).
- **API references.** Upload an OpenAPI document and a page becomes an interactive reference. Each site also shows its own API at `/_/api`, with the document at `/api/v1/openapi.yaml`.
- **Tell people what happened.** Follow a page or a space to hear about changes in the app and by mail. Webhooks tell Feishu, Lark, Slack, WeCom, DingTalk and Teams groups, or your own systems. See [Webhooks](./docs/webhooks.md).
- **Share a page with anyone.** A link lets someone with no login read a page, and its subpages if you want, until it expires or you revoke it.
- **Labels, templates and your own look.** Labels that lead to pages like this one, templates for new pages, a favicon, a brand colour and custom CSS.
- **Files, without a second source of truth.** `pandocs sync` keeps a space on disk and `pandocs commit` sends edits back with merging, on macOS, Linux and Windows. Or publish chosen spaces to a shared file system such as NFS, CFS, EFS or NAS for sandboxes to mount read-only. See [Files and agents](./docs/files-and-agents.md) and [Connecting agents](./docs/connecting-agents.md).
- **Other files too.** Word, Excel, PowerPoint, PDF, HTML and CSV turn into pages you can comment on, with the original kept on the page. Or plug in a converter of your own. See [Importing files](./docs/importing-files.md). Whole sets of pages come in from Notion and Confluence exports, and from Feishu or Lark documents and knowledge bases.
- **Inside your own systems.** Put a page in another web app with a web component or React, with reading, comments and suggestions working as they do on the site, and your own system saying who its users are. See [Embedding](./docs/embedding.md).
- **Your identity provider.** Sign in through any OpenID Connect provider or plain OAuth2, with groups mapped to permissions, or with email and password.
- **English and Chinese.** The interface and messages follow each person's language, and the content can have translations of its own.
- **Runs where you run things.** PostgreSQL plus anything speaking the S3 API. Stateless replicas behind a load balancer when one is not enough.

## Try it

```bash
docker compose up
```

It runs the released image; `docker compose up --build` runs what is checked out instead. Open <http://localhost:8080> and create the administrator. Settings are in [.env.example](./.env.example). To see what it can do, **Import the sample documents** brings in Pandocs' own documentation with one click.

## Layout

| Path | What it is |
| --- | --- |
| `packages/i18n` | Interface text: English in the code, looked up for other languages. |
| `packages/markdown` | The content format: dialect, block registry, visible text, anchors, edit operations, merging. No dependency on React or Node. |
| `packages/core` | Domain services, ports, the HTTP handler, the tool catalog and the ingest pipeline. Takes a Web `Request` and an identity, so it can also live inside another application. |
| `packages/server` | The server process: accounts, OIDC and OAuth, API tokens, MCP, model calls, serving the web app. |
| `packages/web` | The web application, built on a verbatim copy of the Rspress theme. |
| `packages/embed` | The `<pandocs-doc>` web component and its React wrapper. |
| `cli` | The `pandocs` command line, in Go: a single binary with no runtime to install. `npm install -g @pandocs/cli` installs it too. |
| `packages/cli` | What npm installs as `@pandocs/cli`: a few lines of Node that run the binary for the system, from a package of its own for each. |
| `packages/client`, `sdks/go` | Typed clients for TypeScript and Go, generated from the API description. |
| `docs/api/openapi.yaml` | The HTTP API. Tests keep it in step with the routes and with what the server really sends. |

## Running it for real

[Deploying](./docs/deploying.md) covers Kubernetes with the Helm chart in `deploy/helm`, and the settings for AWS, Tencent Cloud and Alibaba Cloud. It needs only PostgreSQL and anything speaking the S3 API, so nothing ties it to one cloud.

Replicas keep nothing in memory that matters, so scaling out is adding more. To try that on one machine:

```bash
docker compose -f compose.yaml -f deploy/scale/compose.yaml up --scale pandocs=3
```

## Development

See also [CONTRIBUTING](./CONTRIBUTING.md), and the [changelog](./CHANGELOG.md) for what has changed. Needs Node 26, pnpm, Go and a PostgreSQL server, or the [development container](./.devcontainer/devcontainer.json), which has them all. Questions go to [Discussions](https://github.com/wusongbuaa/pandocs/discussions); see [SUPPORT](./SUPPORT.md) and [GOVERNANCE](./GOVERNANCE.md).

```bash
pnpm install
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm build
pnpm test:e2e   # real browser flows; needs Playwright's Chromium
                # install it with an older Node: on Node 26 Playwright's installer hangs while unpacking
node scripts/bench.mjs http://localhost:8080 pd_xxx 10000   # load test against a running server
```

To run it from source:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/pandocs pnpm dev
```

See [docs/design.md](./docs/design.md) for how the content format, writes and discussions work.

## License

[Apache-2.0](./LICENSE). The copies of the Rspress theme and of shadcn/ui components in this repository are MIT; see [NOTICE](./NOTICE). [Open source licenses](./packages/web/sample-docs/en/running/licenses.md) lists the projects Pandocs is built on and where their notices are, and a running site serves all of them at `/THIRD-PARTY-NOTICES.txt`.
