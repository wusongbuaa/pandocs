---
title: 智能问答和阅读数据
---

配置模型后，大家能在搜索框旁边提问，选中文字时能用模型改写、翻译、总结和解释，还能根据讨论生成修改建议。

## 打开它

```bash
PANDOCS_LLM_PROTOCOL=openai      # 或 anthropic，大多数服务用 openai
PANDOCS_LLM_API_KEY=...
PANDOCS_LLM_MODEL=...
PANDOCS_LLM_BASE_URL=https://api.example.com/v1   # 不用官方地址时才需要
```

不配置的话，这些入口都不会出现，其他功能不受影响。

## 通过模型网关

Pandocs 只连一个模型。想在几个模型之间分流、一个出错时换另一个、把各家的密钥放在一处管理，或者统计花费，可以在前面放一个模型网关，让 Pandocs 用 `openai` 协议连它。每人的次数限制仍由 Pandocs 计算，因为网关只看得到 Pandocs 这一个密钥。

| 网关 | 许可证 | 怎么配 |
| --- | --- | --- |
| [LiteLLM](https://github.com/BerriAI/litellm) | MIT，`enterprise` 目录除外 | 地址填网关，密钥填网关发的密钥，模型填网关配置里的模型名 |
| [Portkey Gateway](https://github.com/Portkey-AI/gateway) | MIT | 地址填网关，调用哪家写在 `PANDOCS_LLM_HEADERS` 里 |
| [Higress](https://github.com/alibaba/higress) | Apache-2.0 | 地址填在 Higress 里给模型配置的路由，密钥填消费者的密钥 |

`PANDOCS_LLM_HEADERS` 是每次调用都会带上的请求头，写成 JSON 对象，给靠请求头决定转发到哪里的网关用。这里写的请求头会替换 Pandocs 自己的同名请求头，包括 `Authorization`。以 Portkey 为例：

```bash
PANDOCS_LLM_BASE_URL=http://portkey:8787/v1
PANDOCS_LLM_API_KEY=...                  # 模型服务商的密钥
PANDOCS_LLM_MODEL=claude-opus-5-5
PANDOCS_LLM_HEADERS='{"x-portkey-provider":"anthropic"}'
```

LiteLLM 和 Portkey 都用 Pandocs 的真实调用试过。国内常用的 New API 是 AGPL-3.0 许可证，改了代码再对外提供服务，要公开修改的部分。

## 智能问答怎么工作

智能问答不需要向量库和索引，也不需要 PostgreSQL 扩展。模型和其他人一样，用同样的搜索和阅读工具查页面，所以模型要支持工具调用。

- **按提问人的权限。** 它只能读到提问的人能读的页面，回答里的内容都链接到来源页面。
- **有次数限制。** `PANDOCS_LLM_HOURLY_LIMIT` 是每人每小时的次数，默认 60。一个问题算一次，不管读了几轮，但读得多花费也多。
- **访客默认不能问。** 要在**站点设置**里打开，因为费用由站点承担。打开后所有访客共用 `PANDOCS_LLM_VISITOR_HOURLY_LIMIT`（默认 60），每个地址每小时在每个副本上最多 20 个问题。

## 翻译

每种语言有自己的地址和目录。页面可以手动翻译，也可以用机器翻译。代码、公式和图表不会被翻译，某段太长时保留原文。

原文改了之后，译文会提示已经过期。没有译文时显示原文，并提示还没翻译。评论和修改建议都属于原文。

## 阅读数据

**数据与反馈**给空间的编辑者和管理员看：

- 页面被读了多少次，人和智能体分开计。
- 搜了什么，哪些没搜到。
- 智能问答被问了什么，哪些页面里没有答案。
- 读者和智能体说哪里有问题。

:::info[只有计数]

这些是每天的计数，不记录地址、Cookie 和姓名，只存在你自己的 PostgreSQL 里。搜索词和问题 180 天后删除，阅读数 400 天后删除。设置 `PANDOCS_READING_STATS=false` 就什么都不记。

:::
