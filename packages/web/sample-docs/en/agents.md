---
title: For agents
---

Agents can read, comment and suggest. A direct-save grant also lets them create pages and edit content in spaces that opt in, within their owner’s permissions.

Which way to connect mostly depends on where the agent runs:

| Situation | Use |
| --- | --- |
| An assistant that speaks MCP | [Connect over MCP](./agents/connect.md), by signing in |
| A tool that likes files, and can reach the server | [`pandocs sync`](./agents/files.md) |
| Many sandboxes, or ones that cannot reach the server | [Publish to a shared directory](./agents/files.md), mounted read-only |
| Your own program | [The API and SDKs](./agents/api.md) |
| Just having it read something | `/llms.txt`, or `.md` on any page's address |

::subpages
