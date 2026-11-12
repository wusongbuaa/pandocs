---
title: 开源许可
---

Pandocs 按 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 发布，可以免费使用、修改和再分发，商用也可以。它用到了很多开源项目，这一页列出主要的项目和它们的许可证，以及这些许可证要求随软件提供的声明放在哪里。

## 许可证全文在哪里

| 发布的内容 | 在哪里 |
| --- | --- |
| 容器镜像（服务器和网页） | 站点上的 `/THIRD-PARTY-NOTICES.txt`，也就是镜像里的 `/app/web/THIRD-PARTY-NOTICES.txt`。Pandocs 自己的 `LICENSE` 和 `NOTICE` 在 `/app` |
| 镜像里的 Node.js | `/usr/local/LICENSE`，包含 Node.js 自带的各个组件的许可证 |
| 镜像里的 Debian 软件包 | `/usr/share/doc/<软件包>/copyright` |
| 命令行 | 每次发布附带的 `THIRD-PARTY-NOTICES-cli.txt` |
| 转换服务的镜像（可选） | 镜像里的 `/app/THIRD-PARTY-NOTICES.txt` 是 Python 包的许可证，LibreOffice 等 Debian 软件包在 `/usr/share/doc/<软件包>/copyright` |
| npm 上的客户端库 | 包里的 `LICENSE`，依赖随包管理器安装，各自带着许可证 |

`THIRD-PARTY-NOTICES.txt` 在构建镜像时生成，列出服务器打包进去的每个包、网页构建用到的每个包，带着它们的许可证和 NOTICE 原文。构建时用到的工具也在里面，即使它们不在发布的代码里。

## 主要的开源项目

| 项目 | 用在哪里 | 许可证 |
| --- | --- | --- |
| [Rspress](https://github.com/web-infra-dev/rspress) | 文档站的主题，复制在仓库里 | MIT |
| [React](https://github.com/facebook/react) | 网页界面 | MIT |
| [Base UI](https://github.com/mui/base-ui)、[shadcn/ui](https://github.com/shadcn-ui/ui) | 表单、弹窗和菜单，shadcn/ui 的组件复制在仓库里 | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | 组件的样式 | MIT |
| [unified](https://github.com/unifiedjs/unified)、[remark](https://github.com/remarkjs/remark) | 解析 Markdown | MIT |
| [Tiptap](https://github.com/ueberdosis/tiptap)、[ProseMirror](https://github.com/ProseMirror/prosemirror) | 编辑器 | MIT |
| [Yjs](https://github.com/yjs/yjs)、[Hocuspocus](https://github.com/ueberdosis/hocuspocus) | 多人同时编辑 | MIT |
| [Shiki](https://github.com/shikijs/shiki) | 代码高亮 | MIT |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 公式 | MIT |
| [Mermaid](https://github.com/mermaid-js/mermaid) | 流程图、时序图等 | MIT |
| [Recharts](https://github.com/recharts/recharts) | 图表 | MIT |
| [reveal.js](https://github.com/hakimel/reveal.js) | 把页面当幻灯片放映 | MIT |
| [markmap](https://github.com/markmap/markmap) | 思维导图 | MIT |
| [Scalar](https://github.com/scalar/scalar) | 接口参考 | MIT |
| [FlexSearch](https://github.com/nextapps-de/flexsearch) | 站内搜索 | Apache-2.0 |
| [Lucide](https://github.com/lucide-icons/lucide) | 图标 | ISC |
| [Boring Avatars](https://github.com/boringdesigners/boring-avatars) | 用户头像 | MIT |
| [jsdiff](https://github.com/kpdecker/jsdiff) | 版本对比 | BSD-3-Clause |
| [Node.js](https://github.com/nodejs/node) | 服务器的运行环境 | MIT |
| [Hono](https://github.com/honojs/hono) | 网页服务和接口 | MIT |
| [node-postgres](https://github.com/brianc/node-postgres) | 连接 PostgreSQL | MIT |
| [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3) | 连接兼容 S3 接口的对象存储 | Apache-2.0 |
| [openid-client](https://github.com/panva/openid-client) | 单点登录 | MIT |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MCP 服务 | MIT |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) | 调用模型 | MIT |
| [Nodemailer](https://github.com/nodemailer/nodemailer) | 发邮件 | MIT-0 |
| [Zod](https://github.com/colinhacks/zod) | 校验输入 | MIT |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | 导入 Word 文件 | BSD-2-Clause |
| [read-excel-file](https://gitlab.com/catamphetamine/read-excel-file) | 导入 Excel 文件 | MIT |
| [PDF.js](https://github.com/mozilla/pdf.js)，打包在 [unpdf](https://github.com/unjs/unpdf) 里 | 导入 PDF 文件 | Apache-2.0，unpdf 本身是 MIT |
| [Turndown](https://github.com/mixmark-io/turndown) | 把 HTML 转成 Markdown | MIT |
| [fflate](https://github.com/101arrowz/fflate) | 压缩和解压 | MIT |
| [Docling](https://github.com/docling-project/docling) | 转换服务识别扫描件，单独运行 | MIT |
| [MarkItDown](https://github.com/microsoft/markitdown) | 转换服务没接 Docling 时用它转换 | MIT |
| [LibreOffice](https://www.libreoffice.org) | 转换服务打开旧版 Office 文件 | 主要是 MPL-2.0 |
| [Go](https://github.com/golang/go) 标准库、`golang.org/x/term`、`golang.org/x/sys` | 命令行 | BSD-3-Clause |
| [Debian](https://www.debian.org) 12 | 容器的基础系统 | 每个软件包各有许可证，例如 git 是 GPL-2.0 |

镜像里第三方的包有八百多个，八成是 MIT，其余主要是 ISC、Apache-2.0 和 BSD。没有只能按 GPL、AGPL 或 SSPL 使用的包。

## 需要单独说明的

有的包可以在几种许可证里选一种，有的包里还打包了别的项目，有的包信息写得不完整。

| 包 | 许可证 | 怎么处理 |
| --- | --- | --- |
| elkjs，Mermaid 用它给图排版 | EPL-2.0 或 GPL-3.0 及以上 | 按 EPL-2.0 使用，没有修改。源代码在 [kieler/elkjs](https://github.com/kieler/elkjs) |
| DOMPurify | MPL-2.0 或 Apache-2.0 | 按 Apache-2.0 使用 |
| JSZip | MIT 或 GPL-3.0 及以上 | 按 MIT 使用 |
| json-schema | AFL-2.1 或 BSD-3-Clause | 按 BSD-3-Clause 使用 |
| type-fest | MIT 或 CC0-1.0 | 按 MIT 使用 |
| PDF.js | Apache-2.0 | 打包在 unpdf 里，unpdf 没有带上它的许可证，清单里由我们补上 |
| Rspress 和 shadcn/ui 的复制 | MIT | 原许可证在仓库的 `packages/web/vendor/rspress/LICENSE` 和 `packages/web/vendor/shadcn/LICENSE`，也附在清单最后 |
| khroma | MIT | 包信息里没写许可证，许可证文件是 MIT |
| duck | BSD-2-Clause | 包信息里只写了 BSD |
| lightningcss | MPL-2.0 | 只在构建样式时使用，不在发布的代码里 |
| caniuse-lite | CC-BY-4.0 | 构建时用的浏览器兼容数据，来自 Alexis Deveria 的 [caniuse.com](https://caniuse.com) |
| git，在镜像里 | GPL-2.0 | Git 同步要调用它。这是 Debian 的原版软件包，没有修改，源代码可以从 Debian 获取，例如 `apt-get source git` |

其余的 MIT-0、0BSD、Unlicense、BlueOak-1.0.0、Python-2.0、CC0-1.0 和 Zlib 都是宽松的许可证，保留清单里的声明就够了。

## 再分发时

修改 Pandocs 并再分发时，Apache License 2.0 要求：

- 附上 `LICENSE`，保留 `NOTICE` 和 `THIRD-PARTY-NOTICES.txt`。
- 在改过的文件里写明改过。

这一页是对依赖的说明，不是法律意见。拿不准时以清单里的许可证原文为准。
