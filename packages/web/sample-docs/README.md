# Sample documents

Pandocs' own documentation, in Markdown, for a site to import with one click and see what it can do. *All spaces* offers it to administrators, as does the front page of a new site.

- `zh/` and `en/` hold the same pages. A page's first front matter line is its title. The site's default language decides which is the original, and the other becomes its translation if the site has that language turned on.
- `packages/web/src/manage/sample-docs.ts` lists the pages in sidebar order, so a new page goes there too.
- `examples.json` is the comment and the suggestion made on one page, to have something to try. The text it quotes has to stay on that page.
- `assets/` holds images, written in pages as `assets/<name>`, which become the uploaded file's path when imported.

These describe the product, so they change with it. `packages/web/test/sample-docs.test.ts` checks what a test can: the two languages have the same pages, every block is valid, links and images lead somewhere, and every setting they mention exists. What they claim still needs reading against `docs/`.
