# Design

How Pandocs' content format, writes and discussions work. The README covers the code's layout. For the rest, see [Files and agents](./files-and-agents.md), [Connecting agents](./connecting-agents.md), [Embedding pages](./embedding.md), [Importing files](./importing-files.md) and [Deploying](./deploying.md).

## The content format

It builds on CommonMark, GFM and [generic directives](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444).

| Kind | Syntax | For | Built in |
| --- | --- | --- | --- |
| Container | `:::name[Title]{k="v"}` … `:::` | Markdown inside | note, tip, info, warning, danger, callout, columns, column, steps, tabs, tab, cards, card |
| Leaf | `::name[Title]{k="v"}` | Nothing inside | video, file, subpages, compare, openapi |
| Inline | `:name[Text]{k="v"}` | Within a line of text | tag |
| Data | ` ```name k="v" ` | Data or a small language inside | mermaid, chart, tree, prompt, hotspots, mindmap |
| Formula | `$$E=mc^2$$`, or a `$$` block alone in its paragraph | Typeset by KaTeX | |
| Super and subscript | `x^2^`, `H~2~O` | Letters, digits and `+-=()` only | |
| Also accepted | `> [!NOTE]` | Read as the matching callout | note, tip, warning, danger and so on |

Points to know when writing it:

- Reading is lenient and writing is strict. Every way of writing an attribute is accepted, and the system writes them back as `k="v"`.
- Leave blank lines around a container's opening and closing markers, or Prettier will format them badly.
- An outer container has more colons than the one inside it: `:::::columns` > `::::column` > `:::callout`.
- A container ends at the first line with enough colons, even inside a code block, which is how micromark behaves. For a code block containing `:::`, give the container more colons.
- An inline block needs a registered name and `[text]`. Anything else goes back to plain text, so `10:30` and `address:abc` are not swallowed as directives.
- Pages link to each other with relative paths such as `./page.md`, images use the standard syntax, and a page's metadata is YAML front matter. Raw HTML is not allowed, apart from `<br>`.
- Formulas only use `$$`. A single `$` is ordinary text, so prices do not become formulas. Formulas and file trees are not part of the visible text, and comments attach to the block.
- A single `~` is not strikethrough. Super and subscripts only take letters and digits, because `~` also writes ranges in Chinese text, so `1~3 天，5~7 天`, `北京~上海~广州` and `10~20~30` stay as they are.
- An image's alignment and width go in its title: `![Figure](a.png "A diagram align=center width=320")`. A title is standard syntax, so nothing extra shows up in other Markdown tools.
- What remains of an image's title is its caption, shown beneath it. It is not part of the visible text, and comments attach to the image. A double quote in a caption is written `\"`, which the editor does for you.
- Each heading in `:::steps` is a step, in the theme's `Steps` style. `::::tabs` holds `:::tab[Title]`, in the theme's `Tabs` style, and tabs with the same `group` switch together. Tab names are shown together above the content, away from where they were written, so they are not part of the visible text. A comment pointing into a collapsed tab, prompt or details block opens it.
- ` ```prompt title="" description="" ` is the theme's `Prompt`. Its content is shown and copied exactly as written with no Markdown parsing, which is why it is a data block rather than a container.
- `::::cards` holds `:::card[Title]{href="./a.md"}`. An `href` behaves like any link: it is rewritten when pages move, and only allows relative paths and safe addresses such as http(s). The style follows the cards on the theme's overview page.
- ` ```hotspots src="assets/a.png" alt="" ` holds `[{"x":20,"y":30,"title":"Entry","text":"Start here"}]`, with `x` and `y` as percentages of the image's width and height. In the editor, click the image to add a note and drag to move it. All of the text is shown as plain text.
- `::compare[Caption]{before="assets/a.png" after="assets/b.png" beforeLabel="Before" afterLabel="After"}` uses `react-compare-slider`, loaded when needed. The official theme has neither annotated screenshots nor comparisons, so they use its variables for style.
- `::openapi{src="assets/a.yaml"}` is an interactive API reference, from an OpenAPI document uploaded here or an address on this site. The browser is not allowed to fetch one from elsewhere. A page with nothing else on it gets the whole width and the reference's own navigation. [Scalar](https://github.com/scalar/scalar) draws it, a few megabytes loaded only by pages that show one. Trying requests is off here, since the page's policy would stop the browser sending them; `/_/api` shows this site's own API, where it is on.
- ` ```mindmap ` writes levels with headings and lists. A single top-level node is the centre, and otherwise the `title` attribute is. A mind map within a page does not take over the scroll wheel, or the page could not scroll.
- Footnotes use GFM's `[^1]` and `[^1]: Text`. Their heading follows the reader's language and stays out of the outline. In the editor a reference is one unit, and its text is edited on the block.
- Page layouts are chosen in front matter, as in Rspress: `pageType: home` with `hero` and `features`, and `outline`, `sidebar`, `footer` and `navbar`. Only these fields are read, and angle brackets and dangerous links are removed from their strings, because the theme outputs them as HTML.

### Why this syntax

`:::` containers with remark-directive are the mainstream among documentation tools: Docusaurus, Starlight, Rspress and Fumadocs use remark-directive, and VitePress and Outline use markdown-it-container, written the same way. It is not part of CommonMark, and generic directives are still only a community proposal, but the implementations are mature and widely used.

- MDX runs JSX inside content, which does not suit content written by third parties and agents.
- Markdoc's `{% %}` has no editor integration and does not degrade in other renderers. Its idea of tags having a schema lives on in the block registry.
- Unhandled directives go back to text, as they do in Docusaurus (`unusedDirectives`) and Starlight (`remarkDirectivesRestoration`).

### Adding a block

A block's definition is plain data (`BlockDefinition` in `@pandocs/markdown`: name, kind, example, zod attributes, and optionally how to parse its content), shared by the server and the editor. Adding a block takes:

1. A definition, in `createBlockRegistry([...builtinBlocks, yourBlock])`.
2. A component for reading, in `packages/web/src/markdown/blocks.tsx`. Without one it shows its source, and no content is lost.

The parser and editor nodes come from the definition. Blocks particular to a host are registered by that host, and stay out of the core. The rules:

- **Unknown blocks** keep their original bytes. Reading shows "unsupported" and the source, editing shows a card, and writing back leaves them unchanged.
- **Blocks with errors** produce diagnostics, and affect only themselves. API writes answer with the diagnostics, and refuse them with `strict=true`.
- Only code present at build time is registered. No third-party renderers are loaded at runtime.

## Writes

| Identity | Role | Can do |
| --- | --- | --- |
| Person | editor, admin | Make versions directly from the web, API, CLI or MCP. Accept or reject proposals |
| Person | commenter | Comment and make proposals |
| Person | viewer | Read |
| Agent | commenter at most | Comment and make proposals. Reads no more than the person it acts for |

Permissions follow the identity and role, not the channel. The channel is only recorded on the version, for tracing. A read-only credential's role is at most viewer.

- Writes carry `expectedRevision`, and a conflict answers 409. REST writes also need an `Idempotency-Key`.
- **Edit operations**: `str_replace`, `block_replace`, `block_insert_after`, `block_delete` and `block_move_after`. Block references `b1…bn` only hold for `expectedRevision`, and no block IDs are written into the Markdown.
- **Writing back by block**: saving on the web regenerates only the top-level blocks that changed, and keeps the original bytes of the rest (`packages/web/src/editor/write-back.ts`). When they cannot be matched up, it falls back to writing the whole page, and says so.
- **AI in the editor**: rewrite, translate, summarize and explain in the selection toolbar. Text being edited has no version yet, so it is saved as a draft first, and the server checks the text is in that person's draft before giving it to the model (`POST documents/:id/draft/assist`). They decide whether to use a rewrite or translation.
- **Block previews and source**: diagrams, charts and file trees look in the editor as they do when reading, and open their source when the cursor enters. The toolbar can switch to editing the whole page's Markdown, and switching back takes what was written as the new base.
- **Drafts**: suggesting and translating, and editing alone when the shared draft is not available, keep a draft saved to the server, visible only to that person, and available from another device. A draft goes away once it becomes a version. The reading page mentions an unsaved draft, and `/_/drafts` lists them all (`GET me/drafts`, plus those only on this computer). Leaving the editor loses nothing: changing page or closing the tab keeps a copy in the browser before sending it, and if it cannot be sent (offline, signed out, or over `keepalive`'s 64 KB limit while closing), it stays on the computer. Next time it is compared with the server's copy, and offered back. A translation has its own draft (`?lang=`, with its title), which needs edit access.
- **Concurrency**: people editing a page share one draft and see each other type ([details](./live-editing.md)). Everything else that writes, and anyone editing alone, is compare-and-set. If a save is behind and `merge=true`, it merges three ways by block. Neighbouring blocks changed separately merge too, and only a conflict within one block answers `MERGE_CONFLICT`.
- **Coming back to a page**: returning to the window reads discussions and suggestions again, and a new version prompts for a refresh rather than replacing what is being read. While editing it only says so, and saving merges.
- **Titles**: edited in place in the editor and saved with the text (`title` on `PUT documents/:id/content`), with no version of their own.
- **Markup problems**: `diagnostics` are listed at the top of the reading page for people who can fix them, and update with the content in the editor. Readers only see the notice on the block itself.
- **Proposals**: a base version, a list of operations, a rationale and related discussions. People and agents use the same model, and part of one can be accepted.
- **Change sets**: changes to several pages, reviewed together, that land together or not at all. A page in one is the whole new text and the version it started from, or a new page, a deletion, or a page coming back from the trash. Merging runs in one transaction: each page merges three ways onto what is there now, and if any cannot land, nothing changes and the answer says which. Anyone who can comment can make and read one, which is what an agent working across pages needs, and it can do so with `change_set_*` tools or `pandocs commit --change-set`. Only people review one, and not their own. Changing one makes earlier reviews stop counting, and a page someone cannot read is only counted for them. One that never landed can be deleted, with its pages and reviews, by whoever made it, the person an agent made it for, or an administrator of its space; a merged one is part of its pages' history and stays. Moving a page cannot be part of one yet.
- **Merge rules**: per space, `requiredApprovals` holds a merge back until that many people have approved, and `requireChangeSets` means nobody saves, moves, renames, reorders, deletes or restores a page directly, including administrators, who would have to change the rule first. A change set can bring a page back from the trash, and an import waits as a draft. Someone accepting a suggestion counts as one review, so that only works where one is enough. Translations, labels, the glossary and comments are not covered, since they do not change what a page says.

## Discussions

Anchors are not written into the text. Their coordinates are positions among the non-whitespace characters of the visible text, worked out on the server from mdast, so the CLI and MCP can locate text without a browser. The browser only maps positions to the DOM (`packages/web/src/reader/text-map.ts`).

Each new version locates open discussions again, with three possible results:

| State | Meaning | Shown |
| --- | --- | --- |
| `exact` | The text is still there | Highlighted |
| `fuzzy` | The quote is ≥0.7 similar and its context ≥0.5 | Highlighted, and marked as possibly moved |
| `orphaned` | Not found | Not attached to the text. The quote stays in the discussion panel |

A discussion's card can suggest a change from the discussion (`POST threads/:id/suggestion`). The server gives the discussion and the block it concerns to the model, and the result goes only to whoever asked. They check it and send it as a suggestion linked to the discussion, which resolves when the suggestion is accepted.

Better to call an anchor lost than attach it to the wrong text. What concerns a person (mentions, replies, and proposals waiting for them) is handled within Pandocs, and sending it elsewhere goes through the `Notifier` port.

## Imports

Outside content takes one pipeline: `channel × content type → route → processors → validation → how it is stored`. The routes are in `packages/core/src/ingest/routes.ts`:

| Route | Channel and type | Processors | Stored as |
| --- | --- | --- | --- |
| `markdown-programmatic` | Markdown from the API, CLI or MCP | `normalize` | Published with edit access, otherwise a proposal or draft |
| `markdown-upload` | `.md` and `.txt` uploaded on the web | `normalize` | Draft |
| `document-extract` | docx, pdf, pptx, xlsx, html and so on | `extract` → `normalize`, in the background | Draft |

The original file is kept, and a failed job can run again with other processors. Custom parsing is a new `Processor` (given through `ports.processors`) and a route, with no change to the API.

## The app

`@pandocs/web` is a Vite app, served by `@pandocs/server`, which renders its pages and hands them to the browser to carry on from.

- `vendor/rspress/` is an unchanged copy of the Rspress theme and runtime. The rules are in `vendor/UPSTREAM.md`, and `test/vendor-integrity.test.ts` keeps it unchanged.
- **Forms and dialogs** are shadcn/ui's components on Base UI: `vendor/shadcn/` is an unchanged copy of what its CLI generates, with every colour mapped to the theme's variables in `src/styles/kit.css`, and `src/ui/form.tsx` and `dialog.tsx` are what the app uses from it. They bring Tailwind's CSS and more script, so they only load when someone opens a management page or a dialog. What shows on a reader's first page (menus, panels and tooltips in `src/ui/`, buttons) is Base UI with plain CSS, and `test/first-load.test.ts` keeps it that way.
- **How much fits on a page.** Body text stays at the theme's 16 px, which is what nearly every documentation site uses and already gives about 43 Chinese characters a line. `src/styles/density.css` tightens only what the theme leaves looser than most: headings, the line height and the sidebar. Management pages are not in the theme, so `manage.css` sets their sizes outright: the wide layout, smaller headings and tables with less padding. `test/e2e/density.spec.ts` holds these numbers, and the comparison with the official theme leaves that one file out.
- **What floats over a page leaves the page where it is.** `html` keeps `scrollbar-gutter: stable`, so a page getting long enough to scroll, or a dialog taking its scrollbar away, moves nothing. Menus, selects, popovers and tips are not modal: the page stays scrollable under them, and clicking outside closes them. Only real dialogs stop it scrolling, and what shows through in the scrollbar's room is tinted like the rest of what they cover. `test/e2e/overlays.spec.ts` holds this.
- **A form says what is wrong where it is wrong.** `Form` checks the controls' own constraints on submitting and shows each problem under its field, and so it does for what the server answers: the fields in a 422's `details`, or the one a caller names for a code of its own. Anything else goes to a toast. Enter submits. Leave a submit button enabled when something is only missing, so that pressing it says what is.
- Additions only go in two places. `src/virtual/*` replaces the virtual modules Rspress generates at build time, and `src/theme/index.tsx` overrides theme components in the official way. Places in the layout are slots of the theme's `Layout`, and toolbar actions go through `registerSelectionAction` in `src/theme/slots.ts`.
- At start, `GET bootstrap` fetches the site settings, spaces and page trees, fills in the data objects the theme reads, and only then loads the interface. A changed page tree needs a full reload, because the theme copies its routes when it loads.
- **Rendering on the server**: `src/ssr/` is built along with the app into `dist/ssr`, with everything it needs inside, and runs on threads started by `packages/server/src/web/render-pool.ts`. The server asks the API for what the first render needs, as the person asking (`bootstrap`, the document, its translation). A thread renders from those answers and cannot fetch anything, and they go along in the page, so the browser starts from the same data without asking again. It uses the same routes and components as the browser, and the theme's own way of hydrating.
  - What runs in a first render gives the same result in both places, so it reads no `location`, `document`, storage or local time. Hooks like `useLocation` work in both, `ui/local-time.tsx` shows UTC until the page is live, and effects only run in the browser.
  - A thread stays in one language, the same as a page in a browser, so text settled while code loads stays right. The language someone picks is in a cookie for the server to read. A page says what language it was rendered in, and the browser starts out in that.
  - The theme copies its list of routes while it loads and remembers what it found for an address, which suits one person in a browser. A thread gives it a single route that becomes the page being rendered (`ssr/page-route.ts`).
  - Tools rather than reading (the editor, history, source, slides, the pages under `/_/`) and blocks that need a page around them (charts, comparisons, mind maps) sit in the theme's `NoSSR`. The server leaves a place for them.
  - Whenever there is no rendered page to give, the same app renders in the browser from an unfinished one. `test/e2e/` runs through rendering, with hydration errors logged as console errors, and `test/e2e/rendered.spec.ts` covers what is specific to it.
- **The logo** is in `public/`: `logo.svg` is the panda over its book, and `favicon.svg`, `favicon.ico` (16, 32 and 48 px) and `apple-touch-icon.png` are a version drawn for 24 px and under, without the lines on the pages and with heavier strokes, on a green tile. Pages and the sign-in page point at them, and the sample documents' front page shows the logo. A site's own favicon, from its settings, takes their place in every page as the server sends it (`withFavicon` in `packages/server/src/web/pages.ts`), which is why settings keep it to an address or a small image.
- **The colour** is green, `DEFAULT_BRAND_COLOR` in `@pandocs/core`, a shade deeper than the logo's so links and white text on buttons read better than on the theme's blue. It comes from `/site.css` like a colour a site chooses, so the comparison with the official theme, which has no site, still sees the theme's blue. Left at the default, the front page's gradients go green to teal too.
- **Sample documents**: `packages/web/sample-docs/` holds Pandocs' own documentation as Markdown in both languages. *Import the sample documents*, for administrators, writes it through the ordinary API from the browser, so it needs no route of its own and costs nobody a byte until it is asked for. What is there already stays as it is, so running it again only fills in what is missing.
- Comparing with the official theme: `node packages/web/parity/run.mjs` uses Playwright to compare screenshots of the same content in an official build and in this app.
- Browser flows: `pnpm test:e2e` (`test/e2e/flows.spec.ts`) uses a real mouse and keyboard on the built app, with the production CSP and no login. It needs Playwright's Chromium.
- **Text is not HTML**: the official theme assumes titles come from the site's author, and outputs anything that looks like HTML as HTML. Here titles, sections and space names come from everyone who can write, agents included. `src/theme/text.ts` overrides the theme's `renderHtmlOrText` and `renderInlineMarkdown` to output only escaped text with bold, italic, strikethrough and inline code, and `test/theme-text.test.tsx` watches for new HTML output in the theme. The outline's range still comes from what the theme collects on the page, and its text from the document's own outline. Pages also have an enforced CSP (`packages/server/src/web/csp.ts`), to stop any script that escaping might miss.

Clicking a diagram fills the window, with the wheel to zoom and dragging to move (`packages/web/src/markdown/diagram-zoom.tsx`), in slides too. In the editor a click still opens its source. Ordinary images zoom with the theme's `medium-zoom`. Annotated screenshots and comparisons do not, since clicking them already does something.

A page can be viewed in two other ways, both loaded when needed and read-only, so they work on translations too:

- **Present** (`?view=slides`): reveal.js makes the page into slides, one for each `##` and `---`, with long sections split by the next heading level, and the opening content and title on the first. Content renders with the same components as the reading page. Only `reveal.css` is included, with no official theme (their embedded fonts are over 400 KB), and colours come from the theme's variables, so dark mode follows. Esc leaves.
- **Mind map** (`?view=mindmap`): `markmap-view` draws the outline, and clicking a node goes back to that heading on the page. markmap writes node content into the page as HTML, so it only gets escaped text (`toMarkmapData`).

Managing documents is under `/_/`: notifications, spaces, the page tree (drag to reorder and move), members and page permissions, the trash, import and export, audit logs and site settings. Hovering in the reading page's sidebar can also create, rename, move and delete pages.

- **Addresses**: a page created on the web whose title would make a long address gets an 8-character short one (`slugForNewPage`), because a Chinese path copies out as a long run of `%E4%B8%80`. Without a `slug`, the API, CLI and MCP still go by the title, since they use paths as references. "Use short addresses" in the page tree replaces existing ones in one go, and old links keep redirecting.
- **Moving**: `POST documents/:id/move` handles changing an address, changing parent and reordering. Subpages move too, old addresses are kept in `document_redirects`, and `resolve`, the page route (with a 301) and the app's 404 page follow them. A page's own relative links are rewritten for its new place and still point where they did. The original gets a version if its text changes, translations are rewritten in place, and only reordering, or links that do not change, make no version. Restoring from the trash to another place works the same way.
- **Deleting**: pages go to the trash, and subpages deleted with a parent are one batch that comes back together. With its parent gone a page goes to the top level, and with its address taken it gets another. Only space administrators can delete from the trash for good or empty it. "Days to keep" in the site settings is off by default. Once set, expired pages are cleaned up hourly, which belongs in any decision about data retention.
- **Spaces**: deleting is soft, and administrators can restore. An address cannot change once created. A space's front page uses the theme's Home layout, built from its page tree, and a page with the path `index` replaces it.
- **Export**: `GET spaces/:space/export` packs the pages the current identity can read, the images they use, and `manifest.json`.
- **Import of an export**: `POST spaces/:space/archive` brings an exported archive back into this or another space, with no draft in between. A page at the same address with different text gets a new version, so nothing is lost, and importing again changes nothing. What cannot be imported is reported one by one, and the rest goes ahead. The upload area takes several files at a time.
- **Glossary**: one for each space. A term gets a dotted underline and its meaning the first time it appears, wrapped in one element with no change to the text, so comments are not disturbed. It can be imported from a table on a page, with the term in the first column and its meaning in the second.
- **Search**: the theme's full-text index, built by the server according to permissions. With several spaces visible, results say which space they are in. Typing pinyin (`renzheng`, `rz`) finds a page's title by how it is pronounced, and the dictionary only loads once letters are typed.
- **For agents**: `/llms.txt`, `/llms-full.txt` and `/<space>/llms.txt` follow the llmstxt.org convention, with `/<lang>/` in front for a language other than the site's own. `/<space>/<path>.md` is one page's Markdown, which any page address also gives for `Accept: text/markdown`. All are filtered by the reader's permissions, and also accept API tokens. Markdown starts with a line saying where the index is and has its links in full, except when someone copies a page from the site, who gets it as written. A front page nobody has written is a list of what is under it. Pages have the theme's hidden note for agents and its WebMCP tools. `/mcp/public` is MCP for someone with no login: `PUBLIC_TOOL_NAMES`, on what is public.

### Asking the documents

`POST ask` answers a question the way a person would find the answer: searching and reading. The model gets three tools (`search_pages`, `read_page`, `list_pages`), which run as the person asking, so nothing reaches it they could not open themselves. There is no embedding index to build, keep up to date and filter by permission, and PostgreSQL needs no extension.

- **Citations**: the first time the model is shown a page or a section, it gets a number for the length of the question. Answers cite `[3]`, the server keeps only numbers it really gave and renumbers them in order of use, and each leads to the page or heading. An answer that cites nothing is counted as one the pages did not have.
- **What it reads is not instructions**: the system prompt says so, a document's text cannot close the tag it arrives in, and the tools can only read. The worst a page can do is mislead an answer that links back to it. Answers render as plain Markdown with no blocks or images, because a picture could carry what was read to anywhere just by loading.
- **Streaming**: server-sent events through a whole conversation (`LlmPort.conversation`), for the Anthropic protocol through its SDK and any OpenAI-compatible service, including one that answers all at once. Thinking blocks go back to the model unchanged. A tool call cut off by the length limit is not acted on. After six turns the model has to answer with what it has.
- **Who**: people, not agents, which have their own models and the same tools. Someone with no login only on a site that says so (`askForVisitors`). Each question counts once against the hourly limit, per person, with one shared limit for all visitors and another per address.

### Reading numbers and feedback

Under *Insights*, for a space's editors and for administrators: how much pages are read, by people and by agents and tools; what is searched for and what finds nothing; what the AI is asked and what the pages did not have; and what readers and agents say about pages. They only see pages they can read.

- **Counts only**: `page_views` and `search_terms` are per day, with no address, cookie or name. Questions are kept without who asked. Search terms and questions go after 180 days, reading numbers after 400. `PANDOCS_READING_STATS=false` keeps none of it.
- **People** are counted by the page in the browser saying so (`stats/views`, `stats/searches`, once someone stops typing), which is what keeps crawlers out of those numbers. **Agents and tools** are counted by the server: tokens, the CLI, MCP, a page's Markdown from outside the site, and known AI crawlers by their user agent. Search engines are not counted as either.
- **Writing**: counts collect in memory and go out every ten seconds as additions, so reading a page is not a write, and replicas add up. A replica that dies loses a few seconds of counts.
- **Feedback**: a vote and optionally some words at the end of a page, or `doc_report` for an agent over MCP, or `POST documents/:id/feedback` for anything else, which a page's Markdown mentions. Anyone who can read a page can do this. Words on a report or an unhelpful vote go to whoever saved the current version, as a notification. Someone with no login has no name here.
- **What a visitor can write** is a short, explicit list in `PUBLIC_ROUTES`, each limited per address, and a browser on another site cannot be made to do it.

### Labels, templates and following

Labels belong to the page rather than its text: changing one makes no new version, they count as the same in any letter case, and an archive carries them. Templates are per space, for those who can edit it, alongside a few built-in ones in the reader's language. `{{title}}` and `{{date}}` are filled in once when a page is made, and a template changing later touches nothing made from it.

Following a page or a space adds a notification in the same transaction as the commit, so a change that fails tells nobody. Someone who has not read the last notice gets it brought up to date rather than another. Mail goes out from the background after a minute of quiet, one message per person however many pages changed, and only about pages they can still read when it is due: an import of a thousand pages must not be a thousand mails. The notifications list checks the same thing when it is read.

### Editing together

Everyone in the editor shares one draft per page, and saving makes a version of it, the way Confluence does it. The alternative, where typing changes the page, would show readers half a sentence and make a version out of every pause, in a product where versions are what agents, Git and reviewers work from.

A draft is a Yjs document, kept in `live_drafts` with the version it has taken in. Hocuspocus handles the connections, and `y-prosemirror`'s binding keeps it and the editor the same. The server holds the same schema as the editor, in `@pandocs/editor-model`, because it has to be able to read a draft and change it without a browser. Three things depend on that:

- **Starting one.** If the first person's browser filled in an empty draft, two people arriving together would each add the whole page, and it would all be there twice. The server starts it, and whoever gets there second on any replica uses the first one's.
- **Bringing in versions.** A version made through the API, the CLI, Git or a review is merged three ways with what the draft says, by block, and the result is applied to the draft as a change to only what differs. That merges with what someone is typing at that moment, and everyone sees it arrive. Where both changed the same place, the draft keeps its text and says so.
- **Blocks nobody touched keep their bytes**, as they do when editing alone, because saving compares what each block says with what the version the draft has taken in says.

Replicas keep copies of the drafts their people are in, and the row is what is true. Every write takes the row's lock, merges what is there into the copy and writes the result, so that copies can only ever add up. `NOTIFY` passes changes between replicas within milliseconds, and is only a shortcut: a message that is lost, or too large to send, is found in the row by the next write or within 15 seconds. That is why this needs no Redis, and no sticky sessions.

A draft has a generation, part of the name a browser connects to. A draft is removed once nobody has been in it for a while and it says what the page says, and the next one is unrelated to it as far as Yjs can tell. A tab left open from before would merge in and double everything, so it is turned away instead, and starts over with what is new.

Conversions take time in proportion to a page's length, so long pages convert on another thread, as parsing them does.

### Webhooks

Events come from the audit log's own call, in the same transaction as the change, so what rolls back was never announced and what happened cannot be missed. Deliveries are rows. A worker claims one by pushing its next try into the future rather than holding a lock while talking to another server, so any number of replicas can share the work and what a dead one was sending comes back. Chats get ten seconds to gather what else happens and then one message, because they refuse a flood anyway. The sender checks addresses at the moment of connecting, since a space administrator should not be able to reach inside the network from the server, and it follows no redirects.

### Git sync

A space and a folder of a repository, kept the same both ways ([details](./git-sync.md)). `GitSyncService` in the core knows the rules and only ever sees a `GitPort`; `packages/server/src/git.ts` is the port, running Git itself as a separate program, so that a large repository does not hold up the thread serving pages and any host Git can speak to works. Each run makes a fresh partial copy and nothing is ever checked out, so what a repository contains can only ever be data. What was last the same, per file, is in `git_sync_files`, which is what makes three-way merges possible and lets any replica do the next run. Commits are built without a working tree, on top of what was downloaded, so one that lost a race with a push is refused rather than merged by Git. Conflicts land as a suggestion on the page, and the file gets the page's text, because Git keeps history and a page needs one text to show.

### Share links

A link makes someone a principal with `shared` set: its pages, and nothing else whatever is otherwise public. `requireSpace` and `requireDocument` say so, as do the few places that list things, and the handler lets such a principal reach only a short list of read routes, so a new route is closed to it until someone decides otherwise. The link is looked up on every request, so revoking one, or restricting its page, takes effect at once. Pages under `/s/` are not rendered on the server: nothing there is for search engines, and the app gets its token from the address the way an embedded page gets one from its host.

### Bringing in other tools

An importer turns what another tool has into pages and hands them to a sink as it goes, which writes them through the same commits as anything else. It runs in the background as whoever asked, so it can do no more than they can by then, under a lease it renews as it goes. It can safely start over, because a page at the same address only gets a new version if its text differs, and that is how a failed or cancelled import is picked up. Exports are read a file at a time and sizes are checked before anything is unpacked.

### Languages

There are two separate things here.

**The interface** is in English or Chinese. The text in the code is the English itself, looked up through `t()` from `@pandocs/i18n`, and each package's `src/i18n/zh.ts` holds its Chinese. A test keeps the code and those files in step. The web app goes by what the person picked on their account page, then the language in the address, then their browser. The server goes by `Accept-Language`, and answers in English without one, which is what agents, the CLI and the SDKs get. Tool descriptions, the API description and block examples are only ever in English, since it is mainly agents and developers who read them. A background job reports in the language of whoever started it.

**Content** is in the languages turned on in the site settings, each with its own address prefix and sidebar. With one language, no switch is shown.

A translation is a copy of a page (`document_translations`), written by hand or by AI. It has no versions or discussions, and comments and suggestions belong to the original. Once the original changes, the translation says it is out of date. With no translation, the original shows with a note. AI translation has the browser send runs of blocks, with the text read on the server, and failing part way leaves no half-translated page. Blocks such as code, formulas and diagrams are not translated, and a block too long for one call keeps its original text and says so.

A page can turn off its reading time with `readingTime: false` in its front matter. Pages under 3 minutes do not show one anyway.
