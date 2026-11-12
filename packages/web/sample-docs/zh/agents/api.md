---
title: 接口和客户端库
---

能在网页上做的事，基本都能用接口做。接口描述在 `/api/v1/openapi.yaml`，有测试保证它和路由、和服务器实际返回的内容一致。每个站点也在 `/_/api` 展示自己的接口，可以直接试着调用。

## 认证

在**账号与令牌**里新建令牌，放在请求头里：

```bash
curl https://docs.example.com/api/v1/spaces \
  -H 'Authorization: Bearer pd_your_token'
```

## 客户端库

TypeScript 和 Go 的客户端都从接口描述生成。其他语言可以用你习惯的生成器，从 `/api/v1/openapi.yaml` 的接口描述生成一个。

::::tabs{group="language"}

:::tab[TypeScript]

代码在 `packages/client`。

```ts
import { createPandocsClient } from "@pandocs/client";

const pandocs = createPandocsClient({ server: "https://docs.example.com", token });

const { id } = await pandocs.resolve("handbook", "getting-started");
const page = await pandocs.read(id);

// 个人令牌：保存，写明这次修改基于哪个版本。
await pandocs.save(id, { markdown: edited, expectedRevision: page.revision.no, merge: true });

// 智能体令牌：提建议，由人决定。
await pandocs.propose(id, { baseRevision: page.revision.no, markdown: edited, rationale: "修正第一步" });

// 变化实时推送，断线自动重连，不会漏。
for await (const event of pandocs.events({ space: "handbook" })) console.log(event);
```

:::

:::tab[Go]

代码在 `sdks/go`，每个接口对应一个方法。

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

## 写入的规矩

- 保存要带 `expectedRevision`，内容已经变了会返回 409。
- REST 写入要带 `Idempotency-Key`，重试不会写两次。
- 改动可以是整页，也可以是这几种操作：`str_replace`、`block_replace`、`block_insert_after`、`block_delete`、`block_move_after`。
- 块写错时返回结果里有 `diagnostics`，加 `strict=true` 直接拒绝。
- 错误信息跟随 `Accept-Language`，没有时用英文，所以智能体和脚本拿到的是英文。

## 读 Markdown

任何页面都能拿到 Markdown：地址加 `.md`，或者请求时带 `Accept: text/markdown`。站点也提供 `/llms.txt` 和 `/llms-full.txt`，按空间和语言都有一份。

## 完整列表

看[接口参考](./api-reference.md)。
