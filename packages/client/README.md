# @pandocs/client

A typed client for the Pandocs API, generated from its OpenAPI description.

```ts
import { createPandocsClient } from "@pandocs/client";

const pandocs = createPandocsClient({ server: "https://docs.example.com", token });

const { id } = await pandocs.resolve("handbook", "getting-started");
const page = await pandocs.read(id);

// With a person's token: save, naming the revision the edit started from.
await pandocs.save(id, { markdown: edited, expectedRevision: page.revision.no, merge: true });

// With an agent's token: suggest it, for a person to decide.
await pandocs.propose(id, { baseRevision: page.revision.no, markdown: edited, rationale: "Fix the first step" });

// What changes, as it happens. Reconnects by itself and misses nothing.
for await (const event of pandocs.events({ space: "handbook" })) console.log(event);
```

The usual things have names. Everything else is on `pandocs.api`, typed for every operation:

```ts
const { data } = await pandocs.api.GET("/documents/{id}/revisions", { params: { path: { id } } });
```

Errors are `PandocsError`, with a `code` meant for programs, such as `REVISION_CONFLICT` or `MERGE_CONFLICT`.
