---
title: Look and languages
---

## The site's look

Administrators can change these under **Site settings**:

- The site's title, description, logo and footer.
- A favicon, the icon in browser tabs and bookmarks, as PNG, SVG or ICO of at most 16 KB. Without one, it is the Pandocs icon.
- A brand colour, which buttons, links and selected items follow. It is Pandocs' green unless you choose another.
- Custom CSS, added to every page, for what the theme does not do.

The sign-in page and the sign-in box over a page look the same, with the site's logo, description and brand colour, light or dark. Custom CSS is not added to the sign-in page itself.

## Languages

There are two separate things here.

**The interface** is in English and Chinese. Each person's browser decides, and they can pick one on the **Account and tokens** page. The API follows `Accept-Language`, and uses English without one.

**The languages of the content** are turned on under **Site settings**. Each has its own address prefix and sidebar, so pages in a language other than the default are under a prefix such as `/zh/`. With one language, no switch is shown.

:::warning

A new site starts with English. If you write in something else, change the default language there first, before writing.

:::

## Labels

Labels belong to the page rather than its text, so changing one makes no new version. Add them at the top of a page, and click one to find other pages with it. Agents can search by label with `doc_search`.

## Templates

Each space can have templates of its own, chosen when making a page. `{{title}}` and `{{date}}` are filled in once at that moment, and changing a template later touches nothing made from it.

## Glossary

Each space has one. A term gets a dotted underline and its meaning the first time it appears, with no change to the text. It can be imported from a table on a page, with the term in the first column and its meaning in the second.

## Feedback

Every page has a vote at its end, with room for some words. Words and unhelpful votes reach whoever saved the current version, and show up under **Insights**.
