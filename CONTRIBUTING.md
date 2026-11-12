# Contributing

## Getting set up

You need Node 26, pnpm, Go and a PostgreSQL server. Or open the repository in its [development container](./.devcontainer/devcontainer.json), in VS Code or a Codespace, which has all of them, an S3 server, and Playwright's Chromium installed.

```bash
pnpm install
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test:e2e` runs real browser flows. It needs Playwright's Chromium, which you have to install with an older Node, since on Node 26 its installer hangs while unpacking. With nvm: `nvm exec 22 npx playwright@1.58.2 install chromium`. `PANDOCS_E2E_ENGINE=firefox` or `PANDOCS_E2E_ENGINE=webkit` runs them in Firefox or in WebKit, Safari's engine, once that browser is installed the same way. CI runs them in Chromium on every push, and in the other two once a week; to run those now, start the "Other browsers" workflow from the Actions tab, or with `gh workflow run browsers.yml`.

## Changing things

- **Fixing a bug?** Write a test that fails first.
- **Changing the HTTP API?** Update `docs/api/openapi.yaml`, which tests hold against the routes and what they answer, then run `scripts/generate-sdks.sh`.
- **`packages/web/vendor` is a copy of the Rspress theme.** A test checks it stays unchanged. Change behaviour through its slots and CSS variables.
- **Adding something to a page?** Its first render also runs on the server, and has to come out the same in the browser. Read `location`, `document`, storage and the time in an effect, or use `useLocation`. Something that only works with a page around it goes in `NoSSR`. A mismatch shows up as a console error, which the browser tests fail on where they look for those.
- **Adding text people read?** Write the English in `t("...")`, with `{0}` for arguments and `{0|page|pages}` for a word that depends on a count, and add the Chinese to that package's `src/i18n/zh.ts`. A test fails if you forget. Anything an agent or a developer reads, such as tool and API descriptions, is only in English. In the web app, code in the first chunk cannot call `t` while it loads, because translations arrive after it.
- **Changing something people will notice?** Add a line under *Unreleased* in the [changelog](./CHANGELOG.md), for someone running or using it.
- **Touching publishing, or the chart?** `test/nfs/run.sh` and `test/helm/run.sh` try them for real, and take a few minutes.
- Write comments that say why, not what. Tests should read as what the product promises.
- Editors that read [.editorconfig](./.editorconfig) keep the whitespace the same. Wrap lines the way the code around them does: there is no formatter yet, because one would rewrite most files at once.

## Pull requests

- A pull request is squashed into one commit, with its title as the message. Write the title as [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) do, which a check holds it to: `feat: ...`, `fix(cli): ...`, `docs: ...`, `chore(deps): ...`. The kinds are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`.
- CI has to pass, and every review conversation has to be resolved, before it can merge.
- One change per pull request is easier to review, and to undo.

## Your contribution's license

What you contribute is under the [Apache License 2.0](./LICENSE), as the rest of Pandocs is: its section 5 says so for anything submitted on purpose to be included. There is no agreement to sign. Only send what you have the right to send, and say where it came from if it is a copy of someone else's work, so that [NOTICE](./NOTICE) can say so too.

## Getting help

See [SUPPORT](./SUPPORT.md). How decisions are made, and who makes them, is in [GOVERNANCE](./GOVERNANCE.md).

## Releasing

See [docs/releasing.md](./docs/releasing.md).

## Conduct

Everyone taking part follows the [code of conduct](./CODE_OF_CONDUCT.md).

## Layout

See the [README](./README.md). The design and why it is this way are in [docs/design.md](./docs/design.md).
