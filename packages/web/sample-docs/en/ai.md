---
title: Ask AI and reading numbers
---

With a model set up, people can ask questions next to the search box, have the AI rewrite, translate, summarize and explain a selection, and get a suggestion from a discussion.

## Turning it on

```bash
PANDOCS_LLM_PROTOCOL=openai      # or anthropic; most services speak openai
PANDOCS_LLM_API_KEY=...
PANDOCS_LLM_MODEL=...
PANDOCS_LLM_BASE_URL=https://api.example.com/v1   # for anything but the provider's own address
```

Without it, none of these show up, and everything else works as usual.

## Through a model gateway

Pandocs calls one model. To spread calls over several, fall back to another when one fails, keep the providers' keys in one place or see what it costs, put a model gateway in front and have Pandocs reach it with the `openai` protocol. Pandocs still keeps each person to their limit, because the gateway only sees Pandocs' one key.

| Gateway | License | Settings |
| --- | --- | --- |
| [LiteLLM](https://github.com/BerriAI/litellm) | MIT, apart from its `enterprise` folder | The address is the gateway, the key one of its keys, and the model a name from its config |
| [Portkey Gateway](https://github.com/Portkey-AI/gateway) | MIT | The address is the gateway, and which provider to call goes in `PANDOCS_LLM_HEADERS` |
| [Higress](https://github.com/alibaba/higress) | Apache-2.0 | The address of its AI route, and a consumer's key |

`PANDOCS_LLM_HEADERS` is a JSON object of headers sent with every call, for a gateway that is told by header where to send it. A header named there takes the place of Pandocs' own, `Authorization` included. With Portkey:

```bash
PANDOCS_LLM_BASE_URL=http://portkey:8787/v1
PANDOCS_LLM_API_KEY=...                  # the provider's key
PANDOCS_LLM_MODEL=claude-opus-5-5
PANDOCS_LLM_HEADERS='{"x-portkey-provider":"anthropic"}'
```

LiteLLM and Portkey were both tried with Pandocs' own calls. New API, common in China, is AGPL-3.0: changing it and offering it as a service means publishing the changes.

## How Ask AI works

It needs no vector database, no search index and no PostgreSQL extension. The model looks things up with the same search and reading as everyone else, so it has to support tool calls.

- **With the permissions of whoever is asking.** It only reads what they can read, and links what it says to those pages.
- **With limits.** `PANDOCS_LLM_HOURLY_LIMIT` is per person, 60 by default. One question counts once however many turns it takes, though more reading costs more.
- **Visitors cannot ask by default.** Turn it on under **Site settings**, since the site pays for it. They share `PANDOCS_LLM_VISITOR_HOURLY_LIMIT` (60 by default), and each address gets 20 questions an hour on each replica.

## Translation

Each language has its own address and sidebar. Pages can be translated by hand or by AI. Code, formulas and diagrams are not translated, and a passage too long keeps the original text.

Once the original changes, the translation says it is out of date. With no translation, the original shows with a note. Comments and suggestions belong to the original.

## Reading numbers

**Insights**, for a space's editors and for administrators, shows:

- How much pages are read, by people and by agents.
- What is searched for, and what finds nothing.
- What the AI is asked, and what the pages did not have.
- What readers and agents say is wrong.

:::info[Counts only]

These are counts per day, with no addresses, cookies or names, and they stay in your PostgreSQL. Search terms and questions go after 180 days, reading numbers after 400. `PANDOCS_READING_STATS=false` keeps none of it.

:::
