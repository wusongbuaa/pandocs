---
title: The API and SDKs
---

Nearly everything you can do on the web you can do through the API. It is described at `/api/v1/openapi.yaml`, and tests keep that in step with the routes and with what the server really sends. Each site also shows its own API at `/_/api`, where you can try calls.

## Signing in

Create a token under **Account and tokens**, and put it in a header:

```bash
curl https://docs.example.com/api/v1/spaces \
  -H 'Authorization: Bearer pd_your_token'
```

## SDKs

Clients for TypeScript and Go are generated from the API description. For another language, generate one from the description at `/api/v1/openapi.yaml` with the generator you prefer.

::::tabs{group="language"}

:::tab[TypeScript]

In `packages/client`.

```ts
import { createPandocsClient } from "@pandocs/client";

const pandocs = createPandocsClient({ server: "https://docs.example.com", token });

const { id } = await pandocs.resolve("handbook", "getting-started");
const page = await pandocs.read(id);

// With a person's token: save, naming the version the edit started from.
await pandocs.save(id, { markdown: edited, expectedRevision: page.revision.no, merge: true });

// With an agent's token: suggest it, for a person to decide.
await pandocs.propose(id, { baseRevision: page.revision.no, markdown: edited, rationale: "Fix the first step" });

// What changes, as it happens. Reconnects by itself and misses nothing.
for await (const event of pandocs.events({ space: "handbook" })) console.log(event);
```

:::

:::tab[Go]

In `sdks/go`, with one method for every operation.

```go
client, err := pandocs.New("https://docs.example.com", token)
if err != nil {
	return err
}
page, err := client.GetDocumentWithResponse(ctx, id, nil)
if err != nil {
	return err
}
fmt.Println(page.JSON200.Data.Revision.No)
```

:::

::::

## Rules for writing

- Saves carry `expectedRevision`, and a conflict answers 409.
- REST writes need an `Idempotency-Key`, so a retry does not write twice.
- A change can be a whole page or these operations: `str_replace`, `block_replace`, `block_insert_after`, `block_delete`, `block_move_after`.
- Blocks written wrongly come back in `diagnostics`, and `strict=true` refuses them.
- Messages follow `Accept-Language`, and are in English without one, so agents and scripts get English.

## Reading Markdown

Every page has Markdown: add `.md` to its address, or ask for `text/markdown`. Sites also have `/llms.txt` and `/llms-full.txt`, also per space and language.

## Everything else

See the [API reference](./api-reference.md).
