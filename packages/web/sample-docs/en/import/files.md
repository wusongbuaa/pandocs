---
title: Importing files
---

A page's source of truth is Markdown, because that is what people can comment on line by line, what agents can read, and what merges. Other files are turned into Markdown when they come in, and the page keeps the original.

Upload one on a space's **Import and export** page, or with the command line:

```bash
pandocs import handbook returns.docx                       # a draft to review
pandocs import handbook returns.docx --publish --as policies/returns
pandocs import handbook q3.pdf --publish --to reports/q3   # a new version of a page
```

Once published it is a page like any other: searchable, open to comments and suggestions, with versions. To update it, import the new file to the same page, and history keeps the previous text and file.

People with edit rights can publish. For everyone else, agents included, the draft waits for someone who can.

## What converts

| Format | What you get |
| --- | --- |
| Word (`.docx`) | Headings, lists, emphasis, tables and images |
| Excel (`.xlsx`) | One table per sheet, up to 5,000 rows each |
| PowerPoint (`.pptx`) | One section per slide, with its text. Not its pictures or layout |
| PDF | Its text, page by page. Not its layout or images |
| HTML | Headings, lists, tables and links |
| CSV, TSV | A table |

A scanned PDF has no text to find, so it becomes a page with just the file, and the import says so. Old Office formats (`.doc`, `.xls`, `.ppt`) are refused with a request to save them in the new format. The converter below reads both.

Conversion runs on its own thread with a time and memory limit, so an unusual file can only fail its own import.

## A better converter

The built-in conversion cannot read scans or old Office formats. Pandocs comes with a converter for those, in `deploy/converter` in its repository: old Office files are saved in their new format by LibreOffice, and then Docling or MarkItDown turns them into Markdown.

| Engine | For | What it takes |
| --- | --- | --- |
| Docling | Recognizing the text of scans, Chinese as well as English, and the headings, tables and pictures of PDFs | A service of its own, with an image of about 7 GB |
| MarkItDown | Old Office formats only | Nothing more: it is inside the converter |

With Docker Compose, add these lines to `.env` and run `docker compose up -d`:

```bash
COMPOSE_PROFILES=converter,docling        # just converter, without Docling
DOCLING_URL=http://docling:5001           # leave this out without Docling
PANDOCS_EXTRACT_URL=http://converter:8090/convert
PANDOCS_EXTRACT_FALLBACK=true             # only what the built-in conversion cannot read
```

With `PANDOCS_EXTRACT_FALLBACK=true`, only scans and old Office files go to the converter, and everything else stays with the faster built-in conversion. Without it, every file goes there, which is what you want for the headings and tables of every PDF.

### A converter of your own

It gets a `POST` with the file's bytes as the body, its type as `Content-Type`, its name URL-encoded in `X-Filename`, and the language of whoever imported it as `Accept-Language`. It answers with Markdown as text, or with JSON:

```json
{
  "markdown": "# Title\n\n![Diagram](assets/<sha256>.png)",
  "title": "Optional title",
  "warnings": ["Optional things to tell the person"],
  "files": [{ "path": "assets/<sha256>.png", "data": "<the picture in Base64>" }]
}
```

`files` are pictures taken out of the file, each named by the SHA-256 of what it holds, which Pandocs checks. A `4xx` answer means this file will never work, and the reason in its `error` field is passed on to whoever imported it. Anything else failing is tried again.
