---
title: Open source licenses
---

Pandocs is released under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0): free to use, change and pass on, commercially too. It is built on many open source projects. This page lists the main ones and their licenses, and where to find the notices those licenses ask to go along with the software.

## Where the full texts are

| What is released | Where |
| --- | --- |
| The container image, with the server and web app | `/THIRD-PARTY-NOTICES.txt` on the site, which is `/app/web/THIRD-PARTY-NOTICES.txt` in the image. Pandocs' own `LICENSE` and `NOTICE` are in `/app` |
| Node.js in the image | `/usr/local/LICENSE`, which covers the parts Node.js includes |
| Debian packages in the image | `/usr/share/doc/<package>/copyright` |
| The command line | `THIRD-PARTY-NOTICES-cli.txt`, attached to every release |
| The converter's image, if you run it | `/app/THIRD-PARTY-NOTICES.txt` in it for its Python packages, and `/usr/share/doc/<package>/copyright` for Debian's, LibreOffice among them |
| Client libraries on npm | `LICENSE` in the package. Their dependencies come from the package manager, each with its own license |

`THIRD-PARTY-NOTICES.txt` is made when the image is built. It lists every package bundled into the server and every package the web app is built from, with their license and NOTICE texts. Tools used only while building are listed too, though they are not in what is released.

## The main projects

| Project | What for | License |
| --- | --- | --- |
| [Rspress](https://github.com/web-infra-dev/rspress) | The documentation theme, copied into the repository | MIT |
| [React](https://github.com/facebook/react) | The web interface | MIT |
| [Base UI](https://github.com/mui/base-ui), [shadcn/ui](https://github.com/shadcn-ui/ui) | Forms, dialogs and menus. The shadcn/ui components are copied into the repository | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | Styles for the components | MIT |
| [unified](https://github.com/unifiedjs/unified), [remark](https://github.com/remarkjs/remark) | Reading Markdown | MIT |
| [Tiptap](https://github.com/ueberdosis/tiptap), [ProseMirror](https://github.com/ProseMirror/prosemirror) | The editor | MIT |
| [Yjs](https://github.com/yjs/yjs), [Hocuspocus](https://github.com/ueberdosis/hocuspocus) | Editing together | MIT |
| [Shiki](https://github.com/shikijs/shiki) | Code highlighting | MIT |
| [KaTeX](https://github.com/KaTeX/KaTeX) | Formulas | MIT |
| [Mermaid](https://github.com/mermaid-js/mermaid) | Flowcharts, sequence diagrams and more | MIT |
| [Recharts](https://github.com/recharts/recharts) | Charts | MIT |
| [reveal.js](https://github.com/hakimel/reveal.js) | Presenting a page as slides | MIT |
| [markmap](https://github.com/markmap/markmap) | Mind maps | MIT |
| [Scalar](https://github.com/scalar/scalar) | API references | MIT |
| [FlexSearch](https://github.com/nextapps-de/flexsearch) | Searching the site | Apache-2.0 |
| [Lucide](https://github.com/lucide-icons/lucide) | Icons | ISC |
| [Boring Avatars](https://github.com/boringdesigners/boring-avatars) | Pictures for people | MIT |
| [jsdiff](https://github.com/kpdecker/jsdiff) | Comparing versions | BSD-3-Clause |
| [Node.js](https://github.com/nodejs/node) | What the server runs on | MIT |
| [Hono](https://github.com/honojs/hono) | Serving pages and the API | MIT |
| [node-postgres](https://github.com/brianc/node-postgres) | Talking to PostgreSQL | MIT |
| [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3) | Object storage with the S3 API | Apache-2.0 |
| [openid-client](https://github.com/panva/openid-client) | Single sign-on | MIT |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | The MCP server | MIT |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) | Calling models | MIT |
| [Nodemailer](https://github.com/nodemailer/nodemailer) | Sending mail | MIT-0 |
| [Zod](https://github.com/colinhacks/zod) | Checking input | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | Importing Word files | BSD-2-Clause |
| [read-excel-file](https://gitlab.com/catamphetamine/read-excel-file) | Importing Excel files | MIT |
| [PDF.js](https://github.com/mozilla/pdf.js), inside [unpdf](https://github.com/unjs/unpdf) | Importing PDF files | Apache-2.0, and unpdf itself is MIT |
| [Turndown](https://github.com/mixmark-io/turndown) | Turning HTML into Markdown | MIT |
| [fflate](https://github.com/101arrowz/fflate) | Compressing and unpacking | MIT |
| [Docling](https://github.com/docling-project/docling) | The converter's text recognition, run on its own | MIT |
| [MarkItDown](https://github.com/microsoft/markitdown) | The converter without Docling | MIT |
| [LibreOffice](https://www.libreoffice.org) | The converter's way into old Office formats | Mostly MPL-2.0 |
| The [Go](https://github.com/golang/go) standard library, `golang.org/x/term`, `golang.org/x/sys` | The command line | BSD-3-Clause |
| [Debian](https://www.debian.org) 12 | The container's base system | Each package has its own, git's being GPL-2.0 |

The image holds over eight hundred third-party packages. Four in five are MIT, and most of the rest are ISC, Apache-2.0 and BSD. None can only be used under the GPL, the AGPL or the SSPL.

## Some that need a word

Some packages offer a choice of licenses, some carry another project inside, and some describe their license incompletely.

| Package | License | What we do |
| --- | --- | --- |
| elkjs, which Mermaid lays diagrams out with | EPL-2.0 or GPL-3.0 or later | Used under EPL-2.0, unchanged. The source is at [kieler/elkjs](https://github.com/kieler/elkjs) |
| DOMPurify | MPL-2.0 or Apache-2.0 | Used under Apache-2.0 |
| JSZip | MIT or GPL-3.0 or later | Used under MIT |
| json-schema | AFL-2.1 or BSD-3-Clause | Used under BSD-3-Clause |
| type-fest | MIT or CC0-1.0 | Used under MIT |
| PDF.js | Apache-2.0 | Bundled inside unpdf, which leaves its license out, so the list adds it |
| The copies of Rspress and shadcn/ui | MIT | Their licenses are in the repository, at `packages/web/vendor/rspress/LICENSE` and `packages/web/vendor/shadcn/LICENSE`, and at the end of the list |
| khroma | MIT | Its package names no license, and its license file is MIT |
| duck | BSD-2-Clause | Its package only says BSD |
| lightningcss | MPL-2.0 | Only used to build the styles, and not in what is released |
| caniuse-lite | CC-BY-4.0 | Browser support data used while building, from Alexis Deveria's [caniuse.com](https://caniuse.com) |
| git, in the image | GPL-2.0 | Git sync runs it. It is Debian's own package, unchanged, and its source comes from Debian, with `apt-get source git` for example |

The others, MIT-0, 0BSD, Unlicense, BlueOak-1.0.0, Python-2.0, CC0-1.0 and Zlib, are permissive: keeping the notices in the list is enough.

## Passing it on

Changing Pandocs and passing it on, the Apache License 2.0 asks you to:

- Include `LICENSE`, and keep `NOTICE` and `THIRD-PARTY-NOTICES.txt`.
- Say in the files you changed that you changed them.

This page describes the dependencies and is not legal advice. Where in doubt, the license texts in the list are what count.
