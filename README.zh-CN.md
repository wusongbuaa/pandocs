<p align="center"><img src="packages/web/public/logo.svg" width="96" height="96" alt=""></p>

<p align="center">
  <a href="https://github.com/wusongbuaa/pandocs/actions/workflows/ci.yml"><img src="https://github.com/wusongbuaa/pandocs/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/wusongbuaa/pandocs/releases/latest"><img src="https://img.shields.io/github/v/release/wusongbuaa/pandocs?sort=semver" alt="Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/wusongbuaa/pandocs" alt="License: Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/@pandocs/client"><img src="https://img.shields.io/npm/v/@pandocs/client?label=%40pandocs%2Fclient" alt="npm"></a>
  <a href="https://pkg.go.dev/github.com/wusongbuaa/pandocs/sdks/go"><img src="https://pkg.go.dev/badge/github.com/wusongbuaa/pandocs/sdks/go.svg" alt="Go Reference"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/wusongbuaa/pandocs"><img src="https://api.scorecard.dev/projects/github.com/wusongbuaa/pandocs/badge" alt="OpenSSF Scorecard"></a>
</p>

# Pandocs

Pandocs 让人和智能体在同一页上协作：一个事实源，两个入口。人在网页上协作，智能体通过文件和工具协作，结果都落在同一份带版本的文档里。名字由英文的熊猫（panda）和文档（docs）拼成，徽标是一只扒着书往外看的熊猫。

[English](./README.md)。下面链接到的详细文档目前只有英文版。

![Pandocs 自带文档中的一页：侧边栏、带评论、编辑、历史和关注工具的页面，以及目录](./docs/images/screenshot.png)

- **动态文档站。** 基于 Rspress 主题的 Markdown，支持步骤、标签页、卡片、流程图、图表、公式和幻灯片。改了页面不用重新构建，页面从服务端出来就是完整的，有真正的 404、站点地图和分享卡片。可以按空间一键公开，也可以全部放在登录之后。
- **从文档里找答案。** 搜索框旁边的“智能问答”按提问人的权限查找和阅读页面，回答都链接到来源页面。不需要向量库，任何支持工具调用的模型都能用。
- **看得见文档的状况。** 哪些页面被人和智能体读，搜了什么没搜到，智能问答答不上什么，读者和智能体说哪里有问题。只有计数，不记录是谁。
- **多人实时编辑。** 编辑同一页面的人共用一份草稿，能看到彼此的输入和光标。除 PostgreSQL 外不依赖别的组件，副本可以随意扩展。智能体和 Git 保存的内容会实时并入草稿，有人保存后读者才看到新版本。详见[实时编辑](./docs/live-editing.md)。
- **在页面上协作。** 划词评论、提修改建议、逐条接受，每个版本都能回看。
- **跨页面的改动。** 人和智能体都可以用变更集一次改多个页面，由别人一起评审，要么一起生效，要么都不生效。空间可以要求批准人数，或要求所有改动都走评审。
- **也为智能体而做。** 助手登录授权就能连上的 MCP 工具（公开空间不用登录）、`llms.txt`、每页都能按地址或按请求类型拿到 Markdown；智能体令牌只能读取、评论和提建议，由人来决定，权限不超过它的主人。
- **Git 同步。** 让空间和 Git 仓库的一个目录双向保持一致。提交会变成页面版本并保留作者名，这边的编辑也会变成提交，合并不了的内容会变成修改建议，由人来决定。详见[Git 同步](./docs/git-sync.md)。
- **接口参考页。** 上传 OpenAPI 文档，页面就变成可交互的接口参考。每个站点也在 `/_/api` 展示自己的接口，文档地址是 `/api/v1/openapi.yaml`。
- **有变化及时知道。** 关注页面或空间，在站内和邮件里收到更新。Webhook 可以通知飞书、Lark、Slack、企业微信、钉钉和 Teams 的群，也可以发给你自己的系统。详见[Webhook 说明](./docs/webhooks.md)。
- **把页面分享给任何人。** 拿到链接不用登录就能读页面，也可以包括子页面，直到链接过期或被撤销。
- **标签、模板和你自己的样式。** 标签能找到相似的页面，新页面可以从模板开始，还能设置网站图标、品牌色和自定义 CSS。
- **有文件，但不多出一个事实源。** `pandocs sync` 把空间同步到本地，`pandocs commit` 把修改合并回去，支持 macOS、Linux 和 Windows。也可以把选定的空间发布到 NFS、CFS、EFS、NAS 这类共享文件系统，让沙箱只读挂载。详见[文件和智能体](./docs/files-and-agents.md)和[连接智能体](./docs/connecting-agents.md)。
- **也支持其他文件。** Word、Excel、PowerPoint、PDF、HTML 和 CSV 会转成可以评论的页面，原文件留在页面上。也可以接入你自己的转换服务。还能从 Notion 和 Confluence 的导出文件，以及飞书或 Lark 的文档和知识库，整批导入页面。详见[导入文件](./docs/importing-files.md)。
- **嵌进你自己的系统。** 用 Web Component 或 React 把页面放进其他网页应用，查看、评论和建议都和站内一样，由你的系统告诉它用户是谁。详见[嵌入](./docs/embedding.md)。
- **接入你的身份系统。** 支持任何 OpenID Connect 提供方和普通 OAuth2，分组可以映射成权限，也支持邮箱密码。
- **英文和中文。** 界面和提示跟随每个人的语言，内容也可以有自己的译文。
- **部署在你的环境里。** 只需要 PostgreSQL 和兼容 S3 接口的存储。一个实例不够时，无状态副本可以直接横向扩容。

## 试用

```bash
docker compose up
```

默认运行发布好的镜像，要运行检出的代码就用 `docker compose up --build`。打开 <http://localhost:8080>，创建管理员账号。配置项见 [.env.example](./.env.example)。想看看效果，点**导入示例文档**，一键导入 Pandocs 自己的使用文档。

## 目录

| 路径 | 内容 |
| --- | --- |
| `packages/i18n` | 界面文字：代码里写英文，其他语言从字典查。 |
| `packages/markdown` | 内容格式：方言、块注册表、可见文本、锚点、编辑操作、合并。不依赖 React 和 Node。 |
| `packages/core` | 领域服务、端口、HTTP 处理器、工具目录、入库管线。接收标准的 `Request` 对象和身份，也能嵌进别的应用。 |
| `packages/server` | 服务进程：账号、OIDC 和 OAuth、访问令牌、MCP、模型调用、提供网页应用。 |
| `packages/web` | 网页应用，基于原样复制的 Rspress 主题。 |
| `packages/embed` | `<pandocs-doc>` Web Component 和它的 React 封装。 |
| `cli` | `pandocs` 命令行，用 Go 写的单文件程序，不需要安装运行时。 |
| `packages/client`、`sdks/go` | 从接口描述生成的 TypeScript 和 Go 强类型客户端。 |
| `docs/api/openapi.yaml` | HTTP 接口。有测试保证它和路由、和服务器实际返回的内容一致。 |

## 正式部署

[部署指南](./docs/deploying.md)里有 Kubernetes 的 Helm Chart（`deploy/helm`）用法，以及 AWS、腾讯云、阿里云各自的配置。它只需要 PostgreSQL 和兼容 S3 接口的存储，不绑定任何一家云。

副本不在内存里保存任何关键状态，横向扩容就是多加几个。在一台机器上试：

```bash
docker compose -f compose.yaml -f deploy/scale/compose.yaml up --scale pandocs=3
```

## 开发

另见[贡献指南](./CONTRIBUTING.md)。改动记录见[更新记录](./CHANGELOG.md)。需要 Node 26、pnpm、Go 和一个 PostgreSQL，或者直接用[开发容器](./.devcontainer/devcontainer.json)，里面都装好了。有问题请到 [Discussions](https://github.com/wusongbuaa/pandocs/discussions) 提问，见[获取帮助](./SUPPORT.md)和[项目治理](./GOVERNANCE.md)。

```bash
pnpm install
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
pnpm typecheck && pnpm lint && pnpm test
pnpm build
pnpm test:e2e   # 真实浏览器流程，需要 Playwright 的 Chromium
node scripts/bench.mjs http://localhost:8080 pd_xxx 10000   # 对运行中的服务压测
```

从源码运行：

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/pandocs pnpm dev
```

内容格式、写入和讨论的设计见[设计说明](./docs/design.md)。

## 许可证

[Apache-2.0](./LICENSE)。仓库里复制的 Rspress 主题和 shadcn/ui 组件使用 MIT 许可证，见[第三方声明](./NOTICE)。用到的开源项目和它们的许可证见[开源许可](./packages/web/sample-docs/zh/running/licenses.md)，运行中的站点在 `/THIRD-PARTY-NOTICES.txt` 提供全部许可证原文。
