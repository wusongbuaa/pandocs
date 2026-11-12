# Importing files

A page's source of truth is Markdown, because that is what people can comment on line by line, what agents can read, and what merges. Other files are turned into Markdown when they come in, and the page keeps the original.

## What happens to a file

Upload it on a space's **Import and export** page, with `pandocs import`, or through the API.

```bash
pandocs import handbook returns.docx                       # a draft to review
pandocs import handbook returns.docx --publish --as policies/returns
pandocs import handbook q3.pdf --publish --to reports/q3   # a new version of a page
```

1. It is stored as it came, and converted in the background.
2. You get a draft, with the original at the top as a download.
3. Once published, it is a page like any other: searchable, open to comments and suggestions, with versions. Agents read its text, and a copy on disk has the original under `assets/`.

To update it, import the new file to the same page. History keeps the previous text and the previous file.

Who can do what is the same as for any change: people with edit rights can publish, and for everyone else, agents included, the draft waits for someone who can.

## What converts

| Format | What you get |
| --- | --- |
| Word (`.docx`) | Headings, lists, emphasis, tables and images |
| Excel (`.xlsx`) | One table per sheet, up to 5,000 rows each |
| PowerPoint (`.pptx`) | One section per slide, with its text. Not its pictures or layout |
| PDF | Its text, page by page. Not its layout or images |
| HTML | Headings, lists, tables and links |
| CSV, TSV | A table |

A scanned PDF has no text to find, so it becomes a page with just the file, and the import says so. Old Office formats (`.doc`, `.xls`, `.ppt`) are refused with a request to save them in the new format.

Conversion runs on its own thread with a time and memory limit, so an unusual file can only fail its own import.

## A better converter

The built-in conversion cannot read scans or old Office formats. `deploy/converter` is a converter for those: old Office files are saved in their new format by LibreOffice, and then [Docling](https://github.com/docling-project/docling) turns them into Markdown, recognizing the text of scans, or [MarkItDown](https://github.com/microsoft/markitdown) does without Docling. Docling runs as a service of its own, [docling-serve](https://github.com/docling-project/docling-serve), whose CPU image is about 7 GB.

```bash
PANDOCS_EXTRACT_URL=http://converter:8090/convert
PANDOCS_EXTRACT_TOKEN=a-long-random-token
PANDOCS_EXTRACT_FALLBACK=true
```

With `PANDOCS_EXTRACT_FALLBACK=true`, a file goes to the converter only when the built-in conversion cannot read it: a PDF with next to no text, or an old Office format. If the converter says no to a scan, the page keeps just the file, as it would without one. Without it, every file goes to the converter, which with Docling finds the headings, tables and pictures of any PDF.

**Docker Compose** has both behind profiles. Neither publishes a port, and neither can reach the database, so there the converter runs without a token unless `PANDOCS_EXTRACT_TOKEN` sets one. In `.env`:

```bash
COMPOSE_PROFILES=converter,docling
DOCLING_URL=http://docling:5001
PANDOCS_EXTRACT_URL=http://converter:8090/convert
PANDOCS_EXTRACT_FALLBACK=true
```

**Kubernetes**: run the converter, whose image each release publishes as `ghcr.io/<owner>/pandocs-converter`, and docling-serve if you want it, as Deployments with a Service each. Every pod in the cluster can reach a Service, so give the converter a token in `CONVERTER_TOKEN`, and Pandocs the same one and the address, the token through the Secret and the address through the chart's `env`:

```yaml
env:
  PANDOCS_EXTRACT_URL: http://pandocs-converter:8090/convert
  PANDOCS_EXTRACT_FALLBACK: "true"
```

The converter is set up by its environment:

| | |
| --- | --- |
| `DOCLING_URL` | docling-serve, such as `http://docling:5001`. Without it, MarkItDown converts |
| `CONVERTER_TOKEN` | The bearer token it asks for, which is `PANDOCS_EXTRACT_TOKEN` on Pandocs' side. It does not start without one |
| `CONVERTER_REQUIRE_TOKEN` | `false` lets it start without a token, for where nothing but Pandocs can reach it, as in Docker Compose |
| `CONVERTER_CONCURRENCY` | Files converted at once, 2 by default. Reading a long scan takes a lot of memory |
| `CONVERTER_MAX_BYTES` | 100 MiB by default, like Pandocs' own limit |

Built with `--build-arg LIBREOFFICE=false`, the image is smaller and refuses old Office formats. `deploy/converter/tests` are its own tests, and `packages/server/test/converter.test.ts` runs Pandocs' side against a running one. Both run in CI, with MarkItDown. With Docling it was tried by hand: a scanned form in Chinese and English came back word for word, and old Word and Excel files and new Word and PowerPoint files with their pictures.

### A converter of your own

It gets a `POST` with the file's bytes as the body, its type as `Content-Type`, its name URL-encoded in `X-Filename`, and the language of whoever imported it as `Accept-Language`, `zh` or `en`. It answers with Markdown as text, or with JSON:

```json
{
  "markdown": "# Title\n\nText, and ![a diagram](assets/<sha256>.png)",
  "title": "Optional title",
  "warnings": ["Optional things to tell the person"],
  "files": [{ "path": "assets/<sha256>.png", "data": "<the picture in Base64>" }]
}
```

`files` are the pictures taken out of the file. Each is named by the SHA-256 of what it holds and referred to by that name, as the built-in conversion does. Pandocs checks each name against its content, and leaves out, with a warning, any that does not match. PNG, JPEG, GIF, WebP and BMP are shown.

A `4xx` answer means this file will never work, and the person is told, with the reason in the answer's `error` field if it has one. Anything else failing is tried again.

## Your own formats

The import pipeline routes by channel and content type to a chain of processors. Embedding Pandocs' core, you can add a processor and a route for anything else, through the `processors` port in `packages/core/src/ports.ts`.

## From another tool

Under *Import and export* in a space, **From another tool** brings in a whole set of pages at once, in the background, with progress and a report of anything that did not come over. Pages go straight in, as the person who started the import, without drafts to publish one by one. It can be run again: a page at the same address gets a new version when its text differs, and otherwise nothing happens, so only what has changed since shows up in its history. A page renamed at the source gets a new address, and so comes in as a new page.

These work from what the tools are documented to produce, and from what other open-source importers handle. Check the report after your first import of a real export.

### Notion

In Notion, export with the format **Markdown & CSV** and with subpages included, then upload the zip. Up to 100 MB. A large export comes as parts, each to be imported in turn.

| In Notion | Here |
| --- | --- |
| Pages and their nesting | Pages and their nesting. Notion's export says nothing about order, so they are in alphabetical order |
| Links between pages | Links that keep working when pages move, including ones written as `notion.so` addresses |
| Images and files | Stored here. A file becomes a file block, at the end of the page if it was in the middle of a sentence |
| Callouts and toggles | Tip blocks and collapsible blocks |
| Databases | A table with all columns, and a page for each row below it. Views, formulas and relations are only what the export wrote as text |

A link to a page that is not in the export keeps its words and loses the link.

### Confluence

In the space's settings, export the space as **HTML**, then upload the zip. Up to 100 MB, so a space with many attachments may need to leave them out of the export. Confluence's XML export cannot be read.

| In Confluence | Here |
| --- | --- |
| The page tree | The page tree, in its order, using each page's breadcrumbs for any the index leaves out |
| Code, info, tip, note and warning macros | Code blocks and callouts |
| Expand | Collapsible blocks |
| Task lists and tables | Task lists and tables. A cell spanning rows does not survive |
| Images and attachments | Stored here. Attachments the page's text does not show are added at its end |
| Links between pages | Links that keep working when pages move |

Other macros become what they rendered as in the export. The table of contents is left out, since each page here has one anyway. Who wrote what, comments and page history are not in this kind of export.

### Feishu and Lark

There is nothing to export: this reads documents directly through the Feishu API, using an app you create. Give it access only to what you are happy with, because **anyone who can edit a space here can bring in whatever the app can read**.

1. In the [Feishu developer console](https://open.feishu.cn/app) (or [Lark's](https://open.larksuite.com/app)) create a custom app, and add the **Bot** capability.
2. Under permissions, add `wiki:wiki:readonly`, `docx:document:readonly` and `docs:document.media:download`. For whiteboards to come over as pictures it also needs permission to read whiteboards. Publish a version of the app.
3. Give it access to what it should read. API permissions are not enough on their own:
   - For a whole knowledge base, put the app's bot in a group, then in the knowledge base's member settings add that group.
   - For one document, use **… > More > Add document app** on the document. It covers everything below that page in a knowledge base.
4. Set these on the server and restart it. **From another tool** then offers Feishu:

   ```bash
   PANDOCS_FEISHU_APP_ID=cli_xxxxxxxxxxxx
   PANDOCS_FEISHU_APP_SECRET=xxxxxxxxxxxx
   # For Lark:
   # PANDOCS_FEISHU_BASE_URL=https://open.larksuite.com
   ```

Then paste an address:

| Address | What comes in |
| --- | --- |
| `https://example.feishu.cn/wiki/<token>` | That page in a knowledge base, and if you say so the pages under it |
| `https://example.feishu.cn/wiki/settings/<id>` | A whole knowledge base |
| `https://example.feishu.cn/docx/<token>` | One document |

| In Feishu | Here |
| --- | --- |
| Text, headings, lists, to-dos, quotes, code, dividers, formulas | The same. Headings start one level down when the document uses the top level, since the page's title takes that place |
| Callouts | Tip, warning, danger, info or note blocks, by background colour |
| Columns | Column blocks |
| Tables | Tables, with the first row as the header. Merged cells come apart, which the report notes |
| Images, files | Stored here |
| Whiteboards | A picture of them, which can no longer be edited as a whiteboard |
| Links to pages in the same import, and mentions of documents | Links that keep working when pages move. Mentions of people become "@someone" |
| Spreadsheets, multidimensional tables, mind maps, diagrams, tasks and widgets | A note on the page with a link back to the original |
| Old-format documents | A page with a link back. Upgrade them in Feishu to import them |

It keeps to Feishu's limits, which are low: a knowledge base of a thousand pages takes a good while. It stays at 5,000 pages at a time.

Comments, version history and who wrote what are not brought over.
