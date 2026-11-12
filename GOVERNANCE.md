# Governance

## Who decides

Pandocs has one maintainer today, [@wusongbuaa](https://github.com/wusongbuaa), who reviews and merges changes, cuts releases and answers security reports. [CODEOWNERS](./.github/CODEOWNERS) asks them to review every pull request.

Decisions are made in the open, in issues, discussions and pull requests, and the reasons are written down there. Larger ones, such as a change to the content format, the HTTP API or what a release supports, start as an issue or a discussion before the code, so that others can say what it would mean for them. [docs/design.md](./docs/design.md) holds the ones that shaped the project.

## How a change lands

- A change goes through a pull request. `main` takes no pushes, keeps a linear history and needs CI to pass, and every review conversation resolved.
- A pull request is squashed into one commit with its title, which follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), as [CONTRIBUTING](./CONTRIBUTING.md) says.
- Releases follow [docs/releasing.md](./docs/releasing.md).

## Becoming a maintainer

Someone who has made several changes that landed, and reviewed others', can be asked, or can ask, to become a maintainer. A maintainer can review and merge. With two or more, every pull request needs the approval of one who did not write it, and CODEOWNERS lists them by the parts they look after.

A maintainer who has not taken part for six months moves to the list of past maintainers below, and can come back by asking.

## Changing this

This file changes through a pull request like anything else.

## Past maintainers

None yet.
