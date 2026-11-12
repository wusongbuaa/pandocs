---
title: Following and notifications
---

## Following

Click the bell at the top of a page to follow it, or the space it is in. When something changes:

- It shows up under **Notifications**, with a count on the bell at the top right.
- With mail set up, a mail goes out too. It waits for a minute of quiet, and it is one mail per person however many pages changed. An import of a thousand pages is not a thousand mails.

Mentions, replies to you and suggestions waiting for you go to **Notifications** as well.

## Webhooks

A webhook tells something else what happens here: a group chat for people, or your own system. They go out only: a chat bot cannot answer or take commands.

Space administrators set them up under **Webhooks** in the space, and site administrators can add one for the whole site.

| Sends to | Address from |
| --- | --- |
| Feishu or Lark group | Group settings, add a custom bot |
| Slack | An incoming webhook for the channel |
| WeCom group | Group settings, add a group bot |
| DingTalk group | Group settings, add a custom bot |
| Microsoft Teams | A workflow in the channel that posts when a webhook request arrives |
| Your own system | Your own endpoint, with a secret to verify the signature if you want |

A chat gets a message about ten seconds after something happens, with whatever else has happened by then: up to ten lines and a count of the rest.

Pages only some people can read are left out unless you say otherwise, because their titles and comments would go along.

## Sending to your own system

Each event is one `POST` of JSON, with the event's name, a delivery ID and a signature in its headers.

```json
{
  "event": "page.updated",
  "site": "https://docs.example.com",
  "space": { "slug": "handbook", "name": "Handbook" },
  "page": { "title": "Returns", "path": "guides/returns", "url": "https://docs.example.com/handbook/guides/returns" },
  "actor": { "name": "Ana", "kind": "user" },
  "revision": 12,
  "message": "Longer return window"
}
```

A failed event is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours. After 50 failures in a row a hook turns itself off.

Events are recorded in the same transaction as the change, so a change that fails announces nothing, and a change that succeeds is not lost if the server stops a moment later.
