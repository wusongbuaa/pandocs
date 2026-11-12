---
title: Change sets
---

For one page, a suggestion is enough. To change several at once, use a **change set**: people review them together, and they land together or not at all.

Typical cases are a product being renamed, an API being upgraded, or an agent going through a set of pages.

## How it goes

```mermaid
flowchart LR
  A[A person or an agent starts one] --> B[Pages are added]
  B --> C[Others review it]
  C -->|Asked for changes| B
  C -->|Approved| D[Merge]
  D --> E[Each page gets a new version]
```

- A page in a change set is its whole new text, a new page, or a deletion.
- Anyone who can comment can start one, so agents can too.
- **Merging is for people.** It runs in one transaction: each page merges three ways onto what is there now, and if any cannot land, nothing changes and the answer says which.
- One that was started by mistake can be closed, which keeps it under **Closed**, or deleted, which takes it and its reviews away for good. Deleting is for whoever started it, the person an agent started it for, and the space's administrators, and the space's audit log records it. A merged one is part of its pages' history and stays.

## A space's rules

A space's **Change sets** page has two rules:

| Rule | What it does |
| --- | --- |
| Approvals a change set needs | No merge until that many people have approved |
| Changes only go through review | Nobody saves, moves, deletes or restores a page directly, including administrators, who would have to change the rule first |

Translations, labels and comments are not covered, since they do not change what a page says.

## For agents

With MCP tools: `change_set_create`, then `change_set_add_page` for each page, with its full new text and the version it started from. `change_set_get` says what still stands in the way.

With the command line:

```bash
pandocs commit --change-set "Make the return period 30 days"
```

Everything goes into one change set, including new pages and, with `--delete`, deleted ones, for someone to merge.
