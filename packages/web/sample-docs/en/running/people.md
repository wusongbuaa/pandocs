---
title: People and permissions
---

## Accounts

Whoever first opens a new site creates the administrator. To have that settled before anyone can reach it, set `PANDOCS_ADMIN_EMAIL` and `PANDOCS_ADMIN_PASSWORD`.

Under **Users**, an administrator adds someone and gets a link for them to choose a password. It works once, within 7 days, and a newer one replaces it. Until it is used it is a way into that account, so send it somewhere private. With mail set up (`PANDOCS_SMTP_HOST`), the link also goes to their mailbox, and *Forgot your password?* on the sign-in page works.

When someone leaves, disable their account under **Users**. They are signed out at once, and the share links they made are revoked with it. Enabling the account again does not bring those links back.

## Company accounts

:::tip

With `PANDOCS_PASSWORD_LOGIN=false`, accounts come from the company's login and there are no passwords to set.

:::

::::tabs

:::tab[OpenID Connect]

Any provider with a discovery document. The redirect address to register with it is `<PANDOCS_URL>/auth/oidc/callback`.

```bash
PANDOCS_OIDC_ISSUER=https://id.example.com
PANDOCS_OIDC_CLIENT_ID=...
PANDOCS_OIDC_CLIENT_SECRET=...
PANDOCS_OIDC_NAME=Company account
PANDOCS_OIDC_SCOPES=openid profile email groups
PANDOCS_OIDC_GROUPS_CLAIM=groups
PANDOCS_OIDC_ADMIN_GROUP=docs-admins
PANDOCS_OIDC_ALLOWED_DOMAINS=example.com
```

:::

:::tab[OAuth2]

For providers without OpenID Connect. The redirect address is `<PANDOCS_URL>/auth/oauth/callback`.

```bash
PANDOCS_OAUTH_AUTHORIZATION_URL=...
PANDOCS_OAUTH_TOKEN_URL=...
PANDOCS_OAUTH_USERINFO_URL=...
PANDOCS_OAUTH_CLIENT_ID=...
PANDOCS_OAUTH_CLIENT_SECRET=...
PANDOCS_OAUTH_SUBJECT_CLAIM=id
PANDOCS_OAUTH_EMAIL_CLAIM=email
PANDOCS_OAUTH_NAME_CLAIM=name
PANDOCS_OAUTH_GROUPS_CLAIM=groups
```

:::

:::tab[The site it lives beside]

For a site below a path of one that has its own login, such as `https://example.com/docs` (see [Deploying](./deploy.md)). The browser sends that site's session cookie here too, and Pandocs asks it who the cookie belongs to. Nobody signs in again, and there are no accounts to keep here: someone's account is made the first time they come, and their name and roles follow what the site says each time.

```bash
PANDOCS_URL=https://example.com/docs
PANDOCS_PASSWORD_LOGIN=false
PANDOCS_HOST_SESSION_URL=http://main.internal/api/me
PANDOCS_HOST_SESSION_COOKIES=SESSION_ID
PANDOCS_HOST_LOGIN_URL=https://example.com/login?redirect={url}
PANDOCS_HOST_LOGOUT_URL=https://example.com/logout
PANDOCS_HOST_SUBJECT_CLAIM=data.id
PANDOCS_HOST_EMAIL_CLAIM=data.email
PANDOCS_HOST_NAME_CLAIM=data.name
PANDOCS_HOST_GROUPS_CLAIM=data.roles
PANDOCS_HOST_ADMIN_GROUP=admin
```

The address in `PANDOCS_HOST_SESSION_URL` gets only the cookies named, and answers with JSON. Each `_CLAIM` says where in it a thing is. Roles become groups, which a space gives roles to like any other. Someone with no session goes to `PANDOCS_HOST_LOGIN_URL`, and `{url}` there is the page to come back to. An answer counts for a minute (`PANDOCS_HOST_SESSION_SECONDS`), which is also how long signing out there takes to reach here.

:::

::::

## Giving people access

Access goes by space, in three layers:

1. **A space's default role.** What people signed in can do by default, chosen when it is made.
2. **A space's members.** A role of their own for a person or a group. Your provider's groups can be used directly.
3. **Restricted pages.** Only those given access can see them. For anyone else, they do not appear in the structure, in search or in anything public.

What each role can do is in [Concepts](../concepts.md).

## Keeping track

Each space has an **Audit log** of who did what and when: changing access, opening a space to the public, deleting pages. Each version also records its author and channel (web, API, command line or MCP).

## Tokens

**Account and tokens** makes three kinds:

- **Read and write as me** acts as you, and can save if you have edit rights.
- **Agent** can only read, comment and suggest.
- **Read only, as me** can only read.

A token can never do more than you can.
