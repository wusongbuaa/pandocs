# Changelog

What changes for someone running or using Pandocs. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version can change things that were there before, and says so under *Upgrading*.

## Unreleased

## 0.2.0 - 2026-11-14

### Managing documents

- A deleted space can be deleted for good from the list of deleted spaces. Its pages, version history, discussions and uploads go with it, and it cannot be restored. Deleting a space that is still in use stays as it was: it only leaves the site, and an administrator can still bring it back.
- Restoring a deleted space cannot land it on an address the site keeps for its own pages, such as `login`: it says the address is taken, and restoring at another one works as before. On a site where public spaces are turned off, a space that was public comes back private, as the site's setting says.
- A file over 100 MiB in a Feishu import is left out with a note saying so, and the rest of the space still comes in. It used to read the whole file into memory on the way to refusing it.

### Forms and managing

- Making an administrator, disabling someone's account, merging a change set and removing a member each ask before they take effect, in the words of what they are about to do. Changing a space's default role is recorded in the audit log, as other changes to a space are.

### Agents and AI

- The hourly limit on AI holds when many requests arrive in the same moment: each person's calls line up behind one another, and a call that fails still uses its turn. Calls from an embedded page are counted against the limit for visitors, and asking through an embed waits for the site to let people with no login ask, as asking without a login does.
- Calls to the public MCP address can be as large as those to the signed-in one.

### Running it

- A request that goes on past the size the site keeps is refused while it arrives, rather than read into memory first, and a body that is not valid JSON is answered as a bad request rather than an error from the server.
- The converter lets go of a connection that says nothing within a minute, so one that sends its headers a byte at a time can no longer hold a conversion turn forever, and a request whose length is not a number is answered as a bad request.

## 0.1.3 - 2026-11-13

### Connecting other things

- `pandocs login` signs in through the browser. It opens the site, you say yes there, and it comes back signed in as you, renewing itself until you run `pandocs logout`, which ends it on the server too. Over SSH or without a display it prints the address to open instead. A token still works: `pandocs login --token` asks for one, and a token on stdin, `PANDOCS_TOKEN` and `PANDOCS_URL` work as before, so scripts and CI need no change. The command line shows under **Connected apps**, where it can be signed out from.

## 0.1.2 - 2026-11-13

### Connecting other things

- The command line is on npm: `npm install -g @pandocs/cli`, or `npx @pandocs/cli <command>` with no install. npm picks the binary for macOS, Linux or Windows on x64 or arm64 from a package of its own, such as `@pandocs/cli-linux-x64`, and it is the same build as on the releases page. An MCP client that only speaks stdio can start it with `npx -y @pandocs/cli mcp`.

## 0.1.1 - 2026-11-12

### Writing together

- Coming back from the Markdown source in a shared draft changes only the blocks that are different, and leaves the rest of the page to the others in it. It used to put the whole page back, which could take away a space someone was typing at the end of a paragraph at that moment.

### Running it

- `docker compose up` runs the released images instead of building them, which makes the first start a download of a few minutes rather than a build. `docker compose up --build` still runs what is checked out, and a version not released yet is built as before. To update, `git pull && docker compose pull && docker compose up -d`.
- Images, the command line and the Helm chart come with signed build provenance, the images with an SBOM, and the npm packages with npm's provenance. Check one with `gh attestation verify`; see [Releasing](docs/releasing.md).

## 0.1.0 - 2026-11-12

The first release.

### Reading

- A documentation site with pages from the database: sidebar, outline, search, dark mode and languages, on the Rspress theme. Pages are rendered on the server, and work without a login for spaces opened to the public.
- Markdown with more kinds of blocks: callouts, tabs, steps, cards, diagrams, charts, formulas, code, video, files and API references from an OpenAPI document.
- Present a page as slides, or see it as a mind map.
- Share a page by a link that needs no account, until it expires or is revoked.
- Someone with no login sees where commenting, editing, history and following would be, and using one signs them in over the page, then carries on with it.
- Signing in looks the same on its own page and over a page: a card with the site's logo, name, description and colour, light or dark. The pages for a forgotten password, a new password and authorizing an app have it too.

- Pandocs' own documentation, in both languages, for a site to import with one click and see what it can do.
- A page with a percent sign or a hash in its address no longer stops the pages around it from opening. New addresses cannot have either, end in `.html`, or be `index` anywhere but a space's front page, all of which the site would open as something else. Pages that have such an address from before move, with what is under them, to the nearest one that opens, the first time the new version starts; their old addresses lead there. A page deleted after someone opened its address gives the page for nothing there, rather than an empty one, and a code block in a language without colours, such as `curl`, shows as plain code instead of taking its page down.
- Searching finds a page with exactly the code or title typed, even where many pages are alike and the search index ranked their neighbours first. Leftover translations into the site's own language, from before it changed, no longer show in titles and search.
- A caret or tilde written as `\^` or `\~`, or as a character reference, stays as written on the page, as it does in the editor, instead of making superscript or subscript.
- The menu beside a page's title can be opened and moved through from the keyboard, and has a name a screen reader says. Tabs in a page are tabs too, reached with Tab and moved between with the arrow keys.
- A link to a part of a page inside a tab not chosen or a folded block opens it and scrolls there, and printing or exporting a PDF includes folded blocks and every tab, under its name. Tabs in a group follow each other by name, so groups with other tabs or another order show the same one, and one without it stays as it was.
- With many spaces, the top bar lists those that fit and puts the rest under *More spaces*, instead of squeezing every name into a column the window cut off.
- Opening a comment on text near the end of a long prompt scrolls to that text once the prompt has opened, rather than to the prompt's start.

### Writing together

- An editor that writes Markdown, with a slash menu and a floating toolbar. Editing together in one shared draft is on by default, and saving makes a version of it.
- Comments on selected text, on a block or on the whole page. Suggestions that someone with edit rights accepts or rejects.
- A comment next to an emoji can be posted, and the page around it saved: the text kept around a comment could cut an emoji in two, which the database refused. A comment on a sentence written twice no longer moves to the other copy when its own is rewritten, a discussion reopened finds its words in the page as it is now, and one whose every comment was taken back leaves the page. Someone mentioned is who the directory says, by their own name, and a notice goes when its comment does. The inbox shows the latest of what someone can read, however much there is about pages they cannot.
- Two people saving the same translation keep both, merged as for a page, and a change to the same place is refused instead of undoing the other's. A page made under another as that one is deleted or moved goes with it, or is refused, and two people moving pages under each other at once hear that the other got there first.
- A blank title or name, an order out of range or a title with line breaks in it are answered as such, instead of with an error from the server, and a page imported from an archive with a blank title is left out and reported. A deleted space whose address was taken since can be restored at another one, and the last administrator who can sign in can no longer be removed by another at the same moment.
- Version history and comparison, and change sets that review several pages together, with rules for what it takes to merge. One that was never merged can be deleted by whoever started it or an administrator of its space.
- Where changes go through review, renaming a page, changing its order and bringing it back from the trash do too, and a change set can now bring a page back from the trash. Labels, translations, the glossary and comments are not held back, and the setting says so. Something imported there waits as a draft, which only a change set lands.
- A change set is for those who can comment in its space, as in the app. A page someone cannot read stays out of what they see of a change set after it goes to the trash or is deleted for good.
- The editor keeps a picture inside a line of text, a heading, a list item or a table cell. Opening such a page used to drop the whole paragraph or cell, and saving anything then published that. Checkboxes under a numbered step stay side by side, and a second paragraph typed into a footnote stays in it.
- In a shared draft, text written in the Markdown source joins the draft when it is saved or left, with what others did meanwhile. Saving it used to put back what someone had just changed, moved or restored, and leaving lost it while saying it was kept.
- The link button in the toolbar opens a box that stays open for the address. Copying within the editor keeps blocks' titles, card links, tab names, videos, files and footnotes, and two people changing a picture's caption and its alignment keep both.
- Templates, labels, following pages and spaces, and a trash that keeps what was deleted.
- Dragging a whole table by its handle no longer leaves an empty table where it was, which saving then published. Saving a page someone moved meanwhile opens it at its new address, with its links read from there. Version history goes back past the latest 50 versions.
- When a page moves, a link to another page written as its address, such as `./guide`, keeps leading there, as `./guide.md` always did.
- A page laid out as a front page opens in the editor again, shown as a document while it is edited.
- Everyone has a marbled picture in the logo's ink and greens, made from their account, so it stays the same when they change their name. It shows on comments, in the editor when others are in the same draft, and on the account menu.

### Agents and AI

- MCP tools an assistant connects to by signing in, with a token or, for public spaces, with no login. Agents read, comment and suggest, and a person decides.
- Connecting an app by signing in: a refresh token or code that comes back after it was spent ends the connection, answers carry `iss` (RFC 9207), an app can give its connection up at `/oauth/revoke`, and the page asking the person says that apps name themselves.
- `llms.txt` and every page as Markdown, by its address or by asking for it.
- The Markdown and `llms.txt` addresses a shared page gives agents work with the link.
- Someone who could read a page and no longer can, because it was restricted, hears from the change feed that it has gone for them, and older rows stop showing where it was.
- A shared directory of files, read-only and derived from the database, for agents that want files.
- With a model set up: asking the documents, explaining and rewriting a selection, turning a discussion into a suggestion, summaries and translation.
- A model gateway such as LiteLLM, Portkey or Higress can sit in front of the model. `PANDOCS_LLM_HEADERS` sends the headers some gateways route by.

### Forms and managing

- Forms, dropdowns and dialogs look the same everywhere, in dark mode and with the site's brand colour: dropdowns that can be searched where the list can grow, switches for settings, and tooltips on icon buttons.
- A form says what is wrong under the field it is about, including what the server answers, and Enter submits it.
- Choosing *All* again in a filter, such as the audit log's, shows everything again.
- The management sidebar shows one space at a time, with a switcher, instead of every page of every space.
- Site settings take a favicon, which every page and the sign-in page show. Until one is set, it is the Pandocs icon, which comes as SVG, ICO and an icon for phones' home screens.

### Connecting other things

- An HTTP API described by OpenAPI, typed clients for TypeScript and Go, and a command line for macOS, Linux and Windows that keeps a space as files. It never writes through a link out of the folder, and follows a page renamed only in letter case.
- Embedding a page in another web app as a web component, with its own sign-in.
- Webhooks for other systems, and for Slack, Feishu, WeCom, DingTalk and Teams.
- Importing Word, Excel, PowerPoint, PDF, HTML and CSV files, and whole sets of pages from Notion, Confluence and Feishu.
- Imported files keep more of what they say. CSV and web pages saved in GB18030 or UTF-16, as Chinese Windows saves them, are read as such, with a warning where the encoding was a guess, and what a CSV or Excel cell holds stays text even where it looks like Markdown or HTML. Times of day and percentages in Excel show as their cells show them, slides come in the order the deck plays, and a PDF in fonts it does not carry, as most Chinese PDFs are written, gives its text. Word lists keep their numbering, and a link to a Word bookmark or to a part of a web page leads to that heading. A Confluence attachment linked by its download address comes in with the page, and one the export left out is reported.
- An import that worked when tried again no longer shows the error from before. Publishing an imported draft starts from the place and address it was imported for, and puts it where the form shows.
- After a conflict, `pandocs commit` says which revision it conflicted with, and `pandocs commit --resolved` sends a file whose conflict was worked out by hand, instead of conflicting again.
- Searching through the API in another of the site's languages, with `lang`, finds pages by their translation, under its title, and the rest as written, as the site's search does on a large site. Reading by keyword takes `context=0`, for the matching blocks alone, as the MCP tool does, and version history pages back with `before`.
- Looking someone up to mention them finds them by name or by their whole email address. Part of an address, such as the company's domain, finds nobody, rather than everyone.
- The shared directory of files puts back a file that something else wrote over, the next time it checks the files.
- A converter for what the built-in conversion cannot read, in `deploy/converter` and as an image of its own: scans, whose text Docling recognizes, and old Office formats, which LibreOffice opens. `PANDOCS_EXTRACT_FALLBACK=true` sends it only those, and Docker Compose starts it with a profile. A conversion service can now hand back the pictures it takes out of a file, and its reason for refusing one is passed on. The converter does not start without a token unless `CONVERTER_REQUIRE_TOKEN=false` says nothing but Pandocs can reach it, as in Docker Compose.
- Keeping a space and a folder of a Git repository the same, both ways.

### Running it

- Docker Compose for one machine, with the database on a network only Pandocs can reach, and a Helm chart for Kubernetes. Add replicas as needed, with uploads in S3 or anything speaking its API.
- `pnpm dev` renders pages on the server again: the file watcher's messages to the rendering threads were taken for pages that had failed.
- Email and password with invitation links, and OpenID Connect or OAuth for company accounts. Roles per space and per page, and a record of who did what.
- A site can live below a path of another site's host, such as `https://example.com/docs`, by giving `PANDOCS_URL` that path. The same build works at any path.
- Such a site can sign people in with the other site's own session: it asks that site who the cookie belongs to, makes their account the first time, and keeps their name and roles as it says (`PANDOCS_HOST_SESSION_URL` and the rest in `.env.example`).
- Reading numbers and feedback from readers, with no cookies or addresses kept.
