# Connecting agents

An agent can read, comment and suggest, but it can never save by itself. Someone with edit rights decides. It also never sees more than the person it works for.

## An MCP client, by signing in

Point it at your site. It will send you to a page to say yes, and that is all.

```json
{
  "mcpServers": {
    "pandocs": { "type": "http", "url": "https://docs.example.com/mcp" }
  }
}
```

It finds the rest by itself: `/mcp` answers with where to sign in, the client registers, and you approve on a page that says who is asking and what it may do. Access tokens last an hour and renew themselves. Disconnect any time under **Account and tokens**, which stops it at once.

This follows the [MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization): protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591), and PKCE. Tested with the official MCP SDK's client.

The parts that keep a connection safe:

- **Refresh tokens change each time they are used.** One that comes back after it was spent must have been copied, and nobody can tell the app from whoever copied it, so the connection ends and the app asks the person again (RFC 9700). The same goes for a code that comes back after it was exchanged.
- **Answers say who they are from**, in an `iss` parameter (RFC 9207), so an app connected to several servers cannot be handed this one's code by another.
- **An app can give up its connection itself**, at `/oauth/revoke` with either of its tokens (RFC 7009).
- **Any app can register, under any name.** The page asking the person says so, and shows where the app returns to.
- **Only the command line signs in as the person.** `pandocs login` uses this flow too, as a client the server comes with, `pandocs-cli`, which can only return to `127.0.0.1`. Its tokens act as the person, so `pandocs commit` saves. Anything that registers itself, whatever it is called, connects as an agent.

## An MCP client, with a token

For a client that does not do OAuth, or something unattended. Create an agent token under **Account and tokens**, which also shows these settings ready to paste:

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

## An MCP client, with no login

For the public spaces of a site, nothing is needed at all:

```json
{
  "mcpServers": {
    "pandocs": { "type": "http", "url": "https://docs.example.com/mcp/public" }
  }
}
```

It can list spaces and pages, search, read, and report what is wrong with a page, and sees no more than someone with no login would. It has an address of its own because `/mcp` answering without a token would leave a client no reason to sign in, and the people using it only the public pages. Each replica allows one address 120 calls a minute. On a site with nothing public this address does not exist.

## An MCP client that only speaks stdio

```json
{
  "mcpServers": {
    "pandocs": {
      "command": "npx",
      "args": ["-y", "@pandocs/cli", "mcp"],
      "env": { "PANDOCS_URL": "https://docs.example.com", "PANDOCS_TOKEN": "pd_your_token" }
    }
  }
}
```

With the command line installed, `"command": "pandocs", "args": ["mcp"]` does the same without asking npm first.

## Telling people what is wrong

An agent that finds a mistake can say so with the `doc_report` tool. Without MCP, the top of a page's Markdown says where to send it:

```bash
curl -X POST https://docs.example.com/api/v1/documents/<id>/feedback \
  -H 'content-type: application/json' \
  -d '{"kind":"report","body":"The refund period contradicts the policy page.","quote":"seven days"}'
```

This changes nothing on the page. It goes to whoever saved the current version, and to the list under *Insights*. To suggest the fix as well, use `proposal_create`, which takes a token.

## Changes across pages

An agent changing several pages should use a change set rather than separate proposals, so a person reviews them together and they land together or not at all: `change_set_create`, then `change_set_add_page` for each page, with its full new text, the revision it started from, or `delete`. A page that does not exist yet needs its `path` and `title`. `change_set_get` says what still stands in the way. Merging is for people.

## Finding pages by label

`doc_search` takes a `label` as well as, or instead of, a `query`. Someone with a token and edit rights can set labels with `doc_labels`, and start a page from a template with `doc_templates` and `doc_create`.

## Something that works on files

Use `pandocs sync` and `pandocs commit`, or mount a shared directory. See [Files and agents](./files-and-agents.md).

## Your own code

Typed clients for [TypeScript](../packages/client/README.md) and [Go](../sdks/go/README.md), generated from the [API description](./api/openapi.yaml), which any OpenAPI generator can make a client from in another language. Or call `GET /api/v1/tools` and `POST /api/v1/tools/{name}`, the same tools MCP offers.

## What each way can do

| | Read | Comment and suggest | Save directly |
| --- | --- | --- | --- |
| Agent token, or a client connected by signing in | What its person can | Yes | No |
| A person's token | What they can | Yes | If they have edit rights |

A token marked read-only can only read. A person's own token acts as them, so give those only to tools you would let act as you.
