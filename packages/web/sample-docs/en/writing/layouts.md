---
title: Page layouts
---

A page's layout goes in the front matter at the top of its Markdown, as in Rspress. Only these fields are read, and angle brackets and dangerous links are removed from them, so what third parties and agents write stays safe.

The editor does not show front matter. Change it with **Edit Markdown source**. Ordinary editing leaves it alone, and it goes back as it was on save.

| Field | What it does |
| --- | --- |
| `pageType` | `home` for a front page, `doc` for a normal page, `doc-wide` for a wider one |
| `hero` | The top of a front page: `name`, `text`, `tagline`, `badge`, `image`, `actions` |
| `features` | The cards on a front page: `title`, `details`, `icon`, `link`, `span` |
| `outline` | Whether to show the outline on the right |
| `sidebar` | Whether to show the sidebar on the left |
| `footer` | Whether to show the previous and next links in the footer |
| `navbar` | Whether to show the top bar |
| `readingTime` | `false` to hide the reading time |
| `description` | What share cards and search engines see |

## A front page

The page at the path `index` is the space's front page. This space's is written like this:

```yaml
---
pageType: home
hero:
  name: Pandocs
  text: People and agents, on the same page
  actions:
    - theme: brand
      text: Five-minute start
      link: ./start
features:
  - title: Collaboration on the page
    details: Select text to comment, suggest edits, accept them piece by piece.
    icon: 💬
    link: ./collaboration/comments
    span: 4
---
```

## A page that is only an API reference

A page with nothing but one `::openapi` block gets the whole width, and the reference's own navigation. See the [API reference](../agents/api-reference.md).

## Presenting

Any page can be shown as slides. Choose **Present** in the menu next to **Copy Markdown** at the top of the page, or add `?view=slides` to its address.

Slides break at headings and at `---` dividers, and a long section breaks again at its next level of headings. Arrow keys move through them, and Escape leaves. Try it on this page.
