# Editing together

Everyone editing a page works in one shared draft. They see each other's text as it is typed and where each other's caret is, on whichever server they reached. It needs nothing beyond PostgreSQL.

## What people see

- **Readers see saved versions.** Typing does not change the page. **Save** turns what is in the draft into a new version, with whoever clicked it as the author and the others credited in its message. That person goes back to reading, and everyone else stays in the draft and is told.
- **A draft stays until someone saves or discards it.** Leaving the editor leaves the draft there. The page tells anyone who can edit it, and *My drafts* lists it for those who wrote in it. **Discard changes** takes the draft back to the saved page, for everyone in it.
- **Undo is your own.** It takes back what you did and leaves what others did.
- **Losing the connection loses nothing.** What you type stays in your browser and merges when the connection is back, in whatever order things happened.
- **The Markdown source** is a private view while you are in it. Coming back merges it with what others did meanwhile.

## Agents and everything else

Agents do not join the draft. They go on proposing and committing through the API, MCP and the CLI, as does Git sync. A version made any of those ways comes into the draft as soon as it exists, where people see it arrive:

| The version and the draft changed | Result |
| --- | --- |
| Different places | Both are kept, and the version's changes appear in everyone's editor |
| The same place | The draft keeps its text, and everyone in it is told. The next save replaces that part, and the version stays in the page's history |

So a person's save does not undo an agent's work without them having been told about it.

## When it is not used

People work alone, and merge when they save, in these cases:

- **Suggesting and translating.** Each person has their own draft for those, because what they produce is theirs to send.
- **Spaces where changes go through change sets.** Editing there is writing a suggestion.
- **Pages embedded in another system.** Their tokens run out and are renewed from outside, which the connection does not follow yet.
- **When the connection cannot get through.** If a proxy blocks WebSockets, the editor says so after a few seconds and carries on alone.
- **A draft someone left behind on their own computer.** Going back to it carries on as it started.
- **`PANDOCS_LIVE_EDITING=false`** turns it off for the site.

## Running it

The connection is a WebSocket at `/api/v1/live` on the same address as everything else, and it answers to the same login and permissions as a request. Someone who loses access is sent away within 30 seconds (`PANDOCS_LIVE_RECHECK_SECONDS`), and nothing more is taken from them.

- **Load balancers** have to pass WebSockets on, which most do by themselves, including Caddy, ingress-nginx, ALB and CLB. Replicas ping every 30 seconds, so idle timeouts of 60 seconds or more are fine. No sticky sessions are needed.
- **Scaling out** needs nothing extra. Replicas tell each other about changes through PostgreSQL `NOTIFY`, and what is true is in the database, written within eight seconds at most, so a replica that missed a message finds it there within 15 seconds. `LISTEN` needs a real connection, so with a pooler in transaction mode, set `PANDOCS_DATABASE_LISTEN_URL`.
- **Replicas stopping** write down what they hold first. People reconnect to another one and notice nothing, apart from a moment of *Not connected*.
- **What it costs.** A draft in use is held in memory, and stored as about seven times the size of its text. A draft nobody has been in for five minutes that says what the page says is removed. One with unsaved work stays until someone deals with it.
