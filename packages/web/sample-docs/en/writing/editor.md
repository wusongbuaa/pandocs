---
title: The editor
---

Click **Edit** at the top of a page to open the editor. What you see is what readers get: diagrams and charts look as they do when reading, and open their source when the cursor enters them.

## Common things

| To do this | Do this |
| --- | --- |
| Insert a block | Type `/` on an empty line |
| Insert an image | Paste it or drag it in |
| Rewrite, translate or summarize a selection | Select it and use AI in the toolbar (needs a model set up) |
| Edit the Markdown itself | **Edit Markdown source** in the toolbar. Switching back takes what you wrote |
| Change the title | Edit it in place. It saves with the text |

## Editing together

Everyone editing a page shares one draft, and sees each other's text and caret as they type. It needs nothing beyond PostgreSQL, whichever replica people reach.

- **Readers see saved versions.** Typing does not change the page. **Save** turns the draft into a new version, with whoever clicked it as the author and the others credited in its message.
- **A draft stays.** Leaving the editor loses nothing. The page tells anyone who can edit it, and **My drafts** lists it. **Discard changes** when you no longer want it.
- **Undo is your own.** It takes back what you did and leaves what others did.
- **Losing the connection loses nothing.** What you type stays in your browser and merges when the connection is back.

:::tip[Agents do not join the draft]

Agents and Git sync write through the API. A version they make comes into the draft as soon as it exists, where people see it arrive. If it changed the same place, the draft keeps its text and everyone is told, and that version stays in the history.

:::

## When there is no shared draft

In these cases each person has their own draft, and it merges when they save:

- Suggesting and translating, because what they produce is theirs to send.
- Spaces where changes go through [change sets](../collaboration/change-sets.md).
- Pages embedded in another system.
- A proxy blocking WebSockets. The editor says so after a few seconds and carries on alone.
- `PANDOCS_LIVE_EDITING=false` on the site.

## When markup is wrong

A block written wrongly affects nothing else. People who can edit see the problems listed at the top of the page, and readers only see a note on that block. Writes through the API answer with the same problems, and `strict=true` refuses them.
