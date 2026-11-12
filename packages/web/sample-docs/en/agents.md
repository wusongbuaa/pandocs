---
title: For agents
---

An agent can read, comment and suggest, but it can never save by itself: someone with edit rights decides. It also never sees more than the person it works for.

Which way to connect mostly depends on where the agent runs:

| Situation | Use |
| --- | --- |
| An assistant that speaks MCP | [Connect over MCP](./agents/connect.md), by signing in |
| A tool that likes files, and can reach the server | [`pandocs sync`](./agents/files.md) |
| Many sandboxes, or ones that cannot reach the server | [Publish to a shared directory](./agents/files.md), mounted read-only |
| Your own program | [The API and SDKs](./agents/api.md) |
| Just having it read something | `/llms.txt`, or `.md` on any page's address |

::subpages
