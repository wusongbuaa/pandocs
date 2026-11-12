---
title: Five-minute start
---

From starting the server to your first page takes about five minutes, on any machine with Docker.

:::steps

### Start the server

In the project's directory:

```bash
docker compose up
```

The first run builds the image. PostgreSQL starts along with it, so there is nothing else to prepare.

To use it from other machines, first set `PANDOCS_URL` to the address they will use, such as `http://192.168.1.20:8080`.

### Create the administrator

Open [http://localhost:8080](http://localhost:8080). Whoever first opens a new site creates the administrator.

To have that settled before anyone can reach it, set `PANDOCS_ADMIN_EMAIL` and `PANDOCS_ADMIN_PASSWORD`.

### Make a space

A space is a set of pages with its own structure, members and trash. While the site is empty, its front page has a **New space** button. Later, click your avatar at the top right, choose **Manage documents**, and go to **All spaces**.

Give it a name and an address, and choose what **People signed in can by default** do. If you are not sure, choose **Can read**, and give people more under its members later.

### Write the first page

Click **New page** at the bottom of the sidebar, give it a title, and you are in the editor.

Type `/` to insert a block: callouts, steps, tabs, diagrams and charts are all there. Click **Save**, and readers see this new version.

### Invite people

Under **Users**, add a colleague to get a link for them to choose a password. It works once, within 7 days. With mail set up, the link goes to their mailbox too.

If you already have company accounts, connect [OIDC or OAuth2](./running/people.md) instead.

:::

## Where to go next

::::cards

:::card[Concepts]{href="./concepts.md"}

What spaces, pages, versions, drafts and roles are.

:::

:::card[Content blocks]{href="./writing/blocks.md"}

What you can write beyond Markdown, each with its result and source.

:::

:::card[Comments and suggestions]{href="./collaboration/comments.md"}

Try selecting some text.

:::

:::card[Connecting agents]{href="./agents/connect.md"}

Let your assistant read these documents, and suggest what it finds wrong.

:::

::::
