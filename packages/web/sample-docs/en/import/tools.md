---
title: From another tool
---

Under **Import and export** in a space, **From another tool** brings in a whole set of pages at once, in the background, with progress and a report of anything that did not come over.

Pages go straight in, without drafts to publish one by one. It can be run again: a page at the same address gets a new version only when its text differs, so history shows only what has changed since.

:::warning

The Notion and Confluence importers work from what those tools are documented to produce and what other open-source importers handle, and have not been run on real exports. Feishu's document conversion has been run on real documents, while an app's own credentials and images were tested against a stand-in. Check the report after your first import.

:::

::::tabs

:::tab[Notion]

In Notion, export with the format **Markdown & CSV** and with subpages included, then upload the zip, up to 100 MB. A large export comes as parts, each to be imported in turn.

| In Notion | Here |
| --- | --- |
| Pages and their nesting | Pages and their nesting. The export says nothing about order, so they are alphabetical |
| Links between pages | Links that keep working when pages move |
| Images and files | Stored here |
| Callouts and toggles | Tip blocks and collapsible blocks |
| Databases | A table with all columns, and a page for each row. Views, formulas and relations are only what the export wrote as text |

:::

:::tab[Confluence]

In the space's settings, export the space as **HTML**, then upload the zip, up to 100 MB. Confluence's XML export cannot be read.

| In Confluence | Here |
| --- | --- |
| The page tree | The page tree, in its order |
| Code, info, tip, note and warning macros | Code blocks and callouts |
| Expand | Collapsible blocks |
| Task lists and tables | Task lists and tables. A cell spanning rows does not survive |
| Images and attachments | Stored here |
| Links between pages | Links that keep working when pages move |

Who wrote what, comments and page history are not in this kind of export.

:::

:::tab[Feishu and Lark]

There is nothing to export: this reads documents directly, using an app you create.

**Anyone who can edit a space here can bring in whatever the app can read**, so give it access only to what you are happy with.

1. In the developer console, create a custom app and add the Bot capability.
2. Add the permissions `wiki:wiki:readonly`, `docx:document:readonly` and `docs:document.media:download`, then publish a version.
3. Give it access to what it should read: for a knowledge base, add a group holding its bot to the members. For one document, add the app from the document's menu.
4. Set `PANDOCS_FEISHU_APP_ID` and `PANDOCS_FEISHU_APP_SECRET` on the server and restart it. For Lark, also set `PANDOCS_FEISHU_BASE_URL=https://open.larksuite.com`.

Then paste the address of a document, a page in a knowledge base, or a whole knowledge base.

| In Feishu | Here |
| --- | --- |
| Text, headings, lists, to-dos, quotes, code, formulas | The same |
| Callouts and columns | Callouts and column blocks |
| Tables | Tables, with the first row as the header. Merged cells come apart |
| Images and files | Stored here |
| Whiteboards | A picture of them |
| Spreadsheets, multidimensional tables, mind maps | A note on the page with a link back |

Comments, version history and who wrote what are not brought over.

:::

::::

## Exporting a space and bringing it back

**Import and export** can also pack a whole space into an archive, for bringing into this site or another. A page at the same address gets a new version only when its text differs, so importing the same archive twice adds nothing.
