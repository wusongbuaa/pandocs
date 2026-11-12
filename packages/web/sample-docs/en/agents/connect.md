---
title: Connecting agents
---

Put one of these in your MCP client, with your site's address.

::::tabs

:::tab[By signing in]

This is the one to use if you can. The client opens a page saying who is asking and what it may do, and you say yes.

```json
{
  "mcpServers": {
    "pandocs": { "type": "http", "url": "https://docs.example.com/mcp" }
  }
}
```

Access tokens last an hour and renew themselves. Disconnect any time under **Account and tokens**, which stops it at once. A refresh token changes each time it is used, and one that comes back after it was spent must have been copied, so the connection ends at once and the app asks you again.

:::

:::tab[With a token]

For a client that does not do OAuth, or something unattended. Create an agent token under **Account and tokens**, which also shows these settings ready to paste.

```json
{
  "mcpServers": {
    "pandocs": {
      "type": "http",
      "url": "https://docs.example.com/mcp",
      "headers": { "Authorization": "Bearer pd_your_token" }
    }
  }
}
```

:::

:::tab[With no login]

For a site's public spaces, nothing is needed. It can list spaces and pages, search, read, and report what is wrong with a page, and sees what someone with no login would.

```json
{
  "mcpServers": {
    "pandocs": { "type": "http", "url": "https://docs.example.com/mcp/public" }
  }
}
```

Each replica allows one address 120 calls a minute. On a site with nothing public this address does not exist.

:::

:::tab[stdio]

For a client that only speaks stdio.

```json
{
  "mcpServers": {
    "pandocs": {
      "command": "pandocs",
      "args": ["mcp"],
      "env": { "PANDOCS_URL": "https://docs.example.com", "PANDOCS_TOKEN": "pd_your_token" }
    }
  }
}
```

:::

::::

Once connected, try this:

```prompt title="Find what is wrong" description="Paste this to a connected agent"
Read the Deploying page and compare it with the project's .env.example. If something does not match, report it with doc_report. If you know how it should read, suggest that with proposal_create rather than changing it.
```

## What each way can do

| | Read | Comment and suggest | Save directly |
| --- | --- | --- | --- |
| Agent token, or a client connected by signing in | What its person can | Yes | No |
| A person's token | What they can | Yes | If they have edit rights |

A token marked read-only can only read. A person's own token acts as them, so give those only to tools you would let act as you.

## Common tools

| To do this | Tool |
| --- | --- |
| Search, by label too | `doc_search` |
| Report what is wrong with a page | `doc_report` |
| Suggest an edit | `proposal_create` |
| Change several pages | `change_set_create`, `change_set_add_page`, `change_set_get` |
| Set labels, with edit rights | `doc_labels` |
| Start a page from a template | `doc_templates`, `doc_create` |

The API reaches the same tools: `GET /api/v1/tools` and `POST /api/v1/tools/{name}`.

## Reporting without MCP

The top of a page's Markdown says where to send it. This changes nothing on the page. It goes to whoever saved the current version, and to the list under **Insights**.

```bash
curl -X POST https://docs.example.com/api/v1/documents/<id>/feedback \
  -H 'content-type: application/json' \
  -d '{"kind":"report","body":"The refund period contradicts the policy page.","quote":"seven days"}'
```
