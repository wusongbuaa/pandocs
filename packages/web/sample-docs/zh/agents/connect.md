---
title: 连接智能体
---

把下面的配置放进你的 MCP 客户端，把地址换成你的站点。

::::tabs

:::tab[登录授权]

推荐这种。客户端会打开一个页面，上面写着是谁在请求、能做什么，你点同意就好。

```json
{
  "mcpServers": {
    "pandocs": { "type": "http", "url": "https://docs.example.com/mcp" }
  }
}
```

访问令牌一小时过期，会自动续期。在**账号与令牌**里可以随时断开，马上生效。刷新令牌每用一次就换一个，已经用过的刷新令牌如果又出现，说明它被复制了，这个连接会立即断开，应用需要重新请你授权。

:::

:::tab[令牌]

给不支持 OAuth 的客户端，或者无人值守的任务用。在**账号与令牌**里新建令牌，权限选**智能体**，那里也有现成的配置可以复制。

```json
{
  "mcpServers": {
    "pandocs": {
      "type": "http",
      "url": "https://docs.example.com/mcp",
      "headers": { "Authorization": "Bearer pd_your_token" }
    }
  }
}
```

:::

:::tab[不登录]

只读公开空间，什么都不用配。能列出空间和页面、搜索、阅读，也能报告页面的问题，能看到的和没登录的访客一样。

```json
{
  "mcpServers": {
    "pandocs": { "type": "http", "url": "https://docs.example.com/mcp/public" }
  }
}
```

每个副本限制同一地址每分钟 120 次调用。站点没有公开内容时，这个地址不存在。

:::

:::tab[stdio]

给只支持 stdio 的客户端。

```json
{
  "mcpServers": {
    "pandocs": {
      "command": "pandocs",
      "args": ["mcp"],
      "env": { "PANDOCS_URL": "https://docs.example.com", "PANDOCS_TOKEN": "pd_your_token" }
    }
  }
}
```

:::

::::

连上之后可以这样试：

```prompt title="找文档里的问题" description="贴给已连接的智能体"
读一遍“部署”这一页，和项目里的 .env.example 对照。如果有说法对不上，用 doc_report 报告；如果你知道该怎么改，用 proposal_create 提一条修改建议，不要直接改。
```

## 每种方式能做什么

| | 读 | 评论、提建议 | 直接保存 |
| --- | --- | --- | --- |
| 智能体令牌，或登录授权的客户端 | 主人能读的 | 可以 | 不可以 |
| 个人令牌 | 本人能读的 | 可以 | 有编辑权限就可以 |

标记为只读的令牌只能读。个人令牌代表你本人，只给你愿意让它替你操作的工具。

## 常用工具

| 想做什么 | 工具 |
| --- | --- |
| 搜索，可以按标签 | `doc_search` |
| 报告页面的问题 | `doc_report` |
| 提一处修改建议 | `proposal_create` |
| 跨页面改动 | `change_set_create`、`change_set_add_page`、`change_set_get` |
| 设标签，有编辑权限时 | `doc_labels` |
| 从模板新建页面 | `doc_templates`、`doc_create` |

用接口也能调到同样的工具：`GET /api/v1/tools` 和 `POST /api/v1/tools/{name}`。

## 不用 MCP 也能报告问题

每页的 Markdown 开头都写了反馈地址。这个请求不会改页面，内容会发给保存当前版本的人，也会进**数据与反馈**的列表。

```bash
curl -X POST https://docs.example.com/api/v1/documents/<id>/feedback \
  -H 'content-type: application/json' \
  -d '{"kind":"report","body":"退货期限和政策页对不上。","quote":"七天"}'
```
