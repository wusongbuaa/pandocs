---
title: 账号和权限
---

## 账号

第一个打开新站点的人创建管理员。要提前定好，就设置 `PANDOCS_ADMIN_EMAIL` 和 `PANDOCS_ADMIN_PASSWORD`。

管理员在**用户**里添加人后，会生成一个设置密码的链接。它用过一次就失效，有效期 7 天，再生成新的会让旧的作废。这个链接在使用之前等于这个账号的钥匙，要私下发。配置了邮件服务（`PANDOCS_SMTP_HOST`）时，链接也会发到对方邮箱，登录页的“忘记密码”也才能用。

有人离开时，在**用户**里停用他的账号。他会马上被登出，他建的分享链接也会一起撤销。之后重新启用账号，这些链接也不会恢复。

## 接入公司账号

:::tip

设置 `PANDOCS_PASSWORD_LOGIN=false` 后，账号全部来自公司登录，没有密码可设。

:::

::::tabs

:::tab[OpenID Connect]

只要提供方有标准的发现文档（`/.well-known/openid-configuration`）就可以。在提供方那里登记的回调地址是 `<PANDOCS_URL>/auth/oidc/callback`。

```bash
PANDOCS_OIDC_ISSUER=https://id.example.com
PANDOCS_OIDC_CLIENT_ID=...
PANDOCS_OIDC_CLIENT_SECRET=...
PANDOCS_OIDC_NAME=公司账号
PANDOCS_OIDC_SCOPES=openid profile email groups
PANDOCS_OIDC_GROUPS_CLAIM=groups
PANDOCS_OIDC_ADMIN_GROUP=docs-admins
PANDOCS_OIDC_ALLOWED_DOMAINS=example.com
```

:::

:::tab[OAuth2]

给不支持 OpenID Connect 的提供方。回调地址是 `<PANDOCS_URL>/auth/oauth/callback`。

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

:::tab[主站登录]

适合部署在一个自带登录的站点的路径下，比如 `https://example.com/docs`（见[部署](./deploy.md)）。浏览器会把主站的登录 cookie 一起带过来，Pandocs 拿它去问主站这是谁。不用再登录一次，这边也不用维护账号：第一次来时自动建号，名字和角色每次都按主站说的同步。

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

`PANDOCS_HOST_SESSION_URL` 只会收到这里列出的 cookie，返回 JSON，各个 `_CLAIM` 指明信息在 JSON 里的位置。角色会变成分组，在空间成员里给分组授权就行。没登录的人会被带到 `PANDOCS_HOST_LOGIN_URL`，其中的 `{url}` 是登录后回来的页面。主站的回答缓存一分钟（`PANDOCS_HOST_SESSION_SECONDS`），在主站退出后，最多这么久这边也会退出。

:::

::::

## 给人权限

权限按空间给，有三层：

1. **空间的默认角色。** 登录的人默认能做什么，新建空间时选。
2. **空间的成员。** 给某个人或某个分组单独的角色。提供方的分组可以直接用。
3. **受限页面。** 只有被单独授权的人能看到。对其他人来说，它们不会出现在目录、搜索和公开内容里。

角色分别能做什么，看[基本概念](../concepts.md)。

## 留痕

每个空间都有**操作记录**，谁在什么时候做了什么：改权限、公开空间、删除页面。每个版本也记录了作者和渠道（网页、接口、命令行、MCP）。

## 令牌

**账号与令牌**里可以建三种令牌：

- **以我的身份读写**代表你本人，有编辑权限就能直接保存。
- **智能体**就是智能体令牌，只能读、评论和提建议。
- **以我的身份只读**只能读。

令牌的权限永远不会超过你本人。
