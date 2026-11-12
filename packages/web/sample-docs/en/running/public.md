---
title: Public spaces and sharing
---

## Opening a space to the public

Space administrators can do this one at a time from a space's **General** page, and it is recorded in the audit log.

A visitor can read that space's pages, search them, and see the images they use. Everything else stays closed: restricted pages, comments, suggestions, version history, who wrote what, other spaces, and all of the API not listed as public in its description.

They still see where commenting, editing, history and following would be, at the top of a page, under it and on text they select. Using one opens sign-in over the page, and once they are in, they carry on with what they picked: straight into the editor, for instance.

| | |
| --- | --- |
| Ruling it out for a site | `PANDOCS_PUBLIC_SPACES=false`, for instance on an internal deployment |
| Limits | Each replica allows one address 600 requests a minute, of which 120 can be searches. Anything more determined is for a CDN or a firewall |
| What is closed looks like what is missing | Someone with no login gets a 404 either way, with a note that it may be behind a login |

## For search engines and agents

- Pages leave the server finished, with a title, a description and share cards, along with `/sitemap.xml` and `/robots.txt`.
- Addresses that do not exist answer 404, and ones that moved answer 301.
- Agents find `/llms.txt`, `/llms-full.txt` and each page's Markdown, and `/mcp/public` is read-only MCP with no login.

## Share links

Someone who can edit a page can make a link at the top of it that lets anyone read it with no login: the page, and optionally its subpages, until the link expires or is revoked.

The visitor sees nothing else on the site, cannot comment, and is not offered search. A restricted page cannot be shared this way, and one that becomes restricted stops working at once.
