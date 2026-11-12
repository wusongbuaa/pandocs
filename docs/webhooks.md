# Webhooks

A webhook tells something else what happens here: a group chat for people, or your own system as signed JSON. They go out only. A chat bot cannot answer or take commands.

Space administrators set them up under **Webhooks** in the space's management pages, for that space. Site administrators can add one for the whole site. You choose what it hears about, and it hears nothing about pages only some people can read unless you say so, because their titles and comments would go wherever the hook sends them.

| Sends to | Address from | Secret |
| --- | --- | --- |
| Feishu or Lark group | Group settings, add a custom bot | Turn on signature verification |
| Slack | An incoming webhook for the channel | None |
| WeCom group | Group settings, add a group bot | None |
| DingTalk group | Group settings, add a custom bot | Choose signing as its security setting |
| Microsoft Teams | A workflow in the channel that posts when a webhook request arrives. Office 365 connectors no longer exist | None |
| Another system | Your own endpoint | Anything you choose, to verify the signature with |

**Send a test** in the list tries the stored address right away and tells you what came back.

## What gets sent

| Event | When |
| --- | --- |
| `page.created` | A page is created, by hand or through an import |
| `page.updated` | A new version is saved |
| `page.moved` | A page gets a new place or address |
| `page.deleted` | A page goes to the trash |
| `page.restored` | A page comes back from the trash |
| `comment.created` | Someone starts a discussion or replies |
| `thread.resolved` | A discussion is marked as resolved |
| `proposal.created` | A change is suggested |
| `proposal.decided` | A suggestion is accepted or rejected |
| `feedback.created` | A reader leaves words about a page. A plain vote is not sent |
| `change_set.created` | A change set is started |
| `change_set.reviewed` | Someone approves one or asks for changes |
| `change_set.merged` | One is merged. Each page in it also sends its own `page.created`, `page.updated` or `page.deleted` |
| `change_set.closed` | One is closed without merging |

Events are recorded in the same transaction as the change, so a change that fails announces nothing, and a change that succeeds is not lost if the server stops a moment later.

A chat gets a message about ten seconds after something happens, with whatever else has happened by then: up to ten lines and a count of the rest. An import of a thousand pages is a few messages rather than a thousand, which chat services would refuse anyway. Messages are in the site's default language.

## Your own system

Each event is one `POST` of JSON, sent as soon as it can be:

```json
{
  "id": "0d5c1a44-7f7a-4e58-9a53-6a4ec2b3f0a1",
  "site": "https://docs.example.com",
  "event": "page.updated",
  "occurredAt": "2026-11-07T08:30:12.345Z",
  "space": { "slug": "handbook", "name": "Handbook" },
  "page": { "id": "6f3f1b70-5b0f-4a0e-9d38-0c8f4c7f6a11", "title": "Returns", "path": "guides/returns", "restricted": false, "url": "https://docs.example.com/handbook/guides/returns" },
  "actor": { "name": "Ana", "kind": "user" },
  "revision": 12,
  "message": "Longer return window"
}
```

Depending on the event there is also `from` (where a moved page was), `thread` (`id`, `comment`), `proposal` (`id`, `status`, `rationale`), `feedback` (`kind`, `body`, `quote`) or `changeSet` (`id`, `title`, and `verdict` or `pages`, with no `page`). `actor.name` is empty for someone with no login, and `actor.kind` is `agent` for an agent.

The headers say what it is:

| Header | |
| --- | --- |
| `X-Pandocs-Event` | The event's name |
| `X-Pandocs-Delivery` | The same as `id`. It stays the same across retries, so use it to tell a repeat from something new |
| `X-Pandocs-Signature` | `t=<unix seconds>,v1=<hex>`, when the hook has a secret |

The signature is HMAC-SHA256 of the time, a dot and the raw body, keyed with the secret. Refuse anything old, so that a captured message cannot be replayed:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(header, rawBody, secret, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map(part => part.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Answer with any `2xx` within ten seconds. Do the work afterwards if it takes longer.

## When sending fails

Anything other than a `2xx` is a failure, and redirects are not followed. For Feishu, WeCom and DingTalk, so is a `200` whose body reports an error, which is how they say a signature or keyword was wrong.

A failed event is tried five more times, after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, and then gives up. Order is not guaranteed across retries. The hook's **Log** shows the last 50 with their results, and lets you send one again. Records are kept for 30 days.

After 50 failures in a row a hook turns itself off, since by then it has probably gone for good. Turning it back on starts the count again and carries on with what was still waiting.

## Addresses and secrets

Neither can be read back once saved, because the address of a chat hook is all anyone needs to post there. The list shows only the host. They are stored unencrypted in PostgreSQL, like everything else there, so treat the database as sensitive.

Hooks cannot reach private networks, loopback or cloud metadata addresses, checked at the moment of connecting so a name that later resolves somewhere else gets no further. A space administrator should not be able to reach inside your network from your server. If everything your hooks talk to really is inside, set `PANDOCS_WEBHOOK_ALLOW_PRIVATE=true`.

Requests go directly to the address: `HTTP_PROXY` and the like are not used. A server that can only reach the internet through a proxy cannot send to chat services yet.
