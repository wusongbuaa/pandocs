---
title: 文件和命令行
---

很多智能体更习惯读文件。但文档的事实源在数据库里，文件只是**副本**：读文件不受限制，改内容一定要经过服务器。这样不管从哪个入口进来，都不会多出第二个事实源。

| | 读 | 写 |
| --- | --- | --- |
| 网页 | 实时 | 保存成版本 |
| 接口、MCP、`pandocs call` | 实时，按人过滤 | 版本，智能体是修改建议 |
| `pandocs sync` | 本地副本，按人过滤 | `pandocs commit` |
| 共享目录 | 选定空间的只读副本，所有人一样 | 设计上不能写 |

## 命令行

命令行是单文件程序，支持 macOS、Linux 和 Windows，不需要装运行时。`login` 会在浏览器里打开站点，你确认授权后就保持登录，直到 `pandocs logout`。脚本和 CI 改用**账号与令牌**里新建的令牌：`pandocs login --token`，或者设置 `PANDOCS_TOKEN`。

```bash
pandocs login --server https://docs.example.com
pandocs sync handbook          # 同步到 ./handbook
cd handbook
$EDITOR getting-started.md
pandocs status
pandocs commit -m "修正第一步"
```

- **`sync` 不会覆盖你的修改。** 只有文件和服务器上次给的一样时才会替换。加 `--watch` 能在一秒左右跟上变化。
- **`commit` 会说明每处修改基于哪个版本。** 服务器上有新内容时按块合并，结果写回你的文件。两边改了同一处时，命令以退出码 3 停下，两个版本都不动。
- **智能体令牌的 `commit` 是提建议。** 修改变成修改建议，新文件变成待发布的导入，由人决定。其他人也可以用 `--propose` 这样做。
- **一批改动一起评审。** `pandocs commit --change-set "标题"` 把所有改动放进一个[变更集](../collaboration/change-sets.md)。

`pandocs tools` 和 `pandocs call <tool>` 能调到服务器提供的所有工具，服务器加了新功能不用更新命令行。

## 共享目录

很多沙箱共用一个文件系统，或者沙箱连不上服务器时，可以把选定的空间发布到共享目录。沙箱里不用运行任何东西，能读文件的工具都能用。NFS、腾讯云 CFS、AWS EFS、阿里云 NAS，或者普通目录都行。

```bash
PANDOCS_PUBLISH_DIR=/mnt/shared/pandocs
PANDOCS_PUBLISH_SPACES=handbook,guide   # 或者 * 表示全部
```

能挂载的人都能读到发布的内容，所以空间列表必须写明，没有默认值。受限页面和只有它们用到的图片不会写出去。

每个空间的目录是这样的：

```tree
handbook
├── getting-started.md
├── getting-started
│   └── first-steps.md
├── assets
│   └── <sha256>.png
├── llms.txt
└── .pandocs
    ├── README.md          # 给第一次看到这个目录的智能体看的说明
    ├── MANIFEST.json      # 每个文件的哈希和版本
    ├── CURRENT            # 有任何变化，这个小文件就会变
    ├── CHANGES.ndjson     # 最近的变化
    └── pack.tar.gz        # 所有页面打成一个包，解压到本地用
```

## 读共享目录时要知道的

下面的数字是在内核 NFS 服务器上测的（两个独立客户端，一万个页面，默认挂载参数），不是哪家云的服务。数字当参考，规则才是重点。

- **按文件名读，读到的就是当前内容，不会读到半个文件。** 文件靠重命名替换，不会就地改写。一次保存传到另一个客户端，NFSv4 大约半秒，NFSv3 大约 6 秒。
- **找新文件要列目录或读 `MANIFEST.json`。** 刚才还不存在的路径，客户端可能最多记一分钟。挂载时加 `lookupcache=positive` 可以去掉这段等待。
- **轮询读 `CURRENT`。** `stat` 可能滞后几十秒，文件变更通知跨不了 NFS 客户端。
- **全文搜索先解压 `pack.tar.gz` 到本地。** 在 NFS 上 `grep` 一万个文件要 80 秒，本地只要 26 毫秒。这个包可能落后几分钟。

:::tip

这些文件什么都不依赖。删掉目录会自动重建，有人改了里面的文件，下一轮也会改回来。

:::

## 对变化做出反应

- `GET /api/v1/events`：服务器推送的事件流，按人过滤，断线后带 `Last-Event-ID` 重连。
- `GET /api/v1/changes?since=<next>`：同样的内容，用轮询取。
- `GET /api/v1/spaces/{space}/manifest` 和 `/snapshot`：把空间当作一组文件取。
