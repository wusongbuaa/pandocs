---
title: 部署
---

只有 PostgreSQL 是必需的。多台机器时要有兼容 S3 接口的存储，其余都是可选的。它不依赖任何一家云的专有服务。

| | 用来做什么 | 什么时候需要 |
| --- | --- | --- |
| PostgreSQL 14 或更新 | 除上传文件外的所有内容，不需要扩展 | 一直需要 |
| S3 接口 | 上传的文件 | 多台机器时。一台机器可以用目录 |
| 共享文件系统 | 给智能体挂载的只读副本 | 想要时 |
| OpenID Connect 或 OAuth2 | 用公司账号登录 | 想要时，否则用邮箱和密码 |
| 模型接口 | 智能问答、总结、翻译 | 想要时 |

## 怎么部署

::::tabs

:::tab[一台机器]

```bash
docker compose up
```

打开 `http://localhost:8080`，创建管理员。配置项都在 `.env.example` 里。

要让其他机器访问，把 `PANDOCS_URL` 设成它们用的地址。纯 HTTP 能用，但密码会明文经过网络。

要放在已有站点的某个路径下，比如 `https://example.com/docs`，就把 `PANDOCS_URL` 设成带这个路径的地址，再让负载均衡把 `/docs` 下的请求原样转过来，不要去掉 `/docs`。

:::

:::tab[Kubernetes]

```bash
kubectl create secret generic pandocs \
  --from-literal=DATABASE_URL='postgres://user:password@db.internal:5432/pandocs' \
  --from-literal=AWS_ACCESS_KEY_ID=... \
  --from-literal=AWS_SECRET_ACCESS_KEY=...

helm install pandocs deploy/helm/pandocs \
  --set url=https://docs.example.com \
  --set existingSecret=pandocs \
  --set storage.s3.bucket=my-docs \
  --set ingress.enabled=true \
  --set 'ingress.hosts[0].host=docs.example.com'
```

配置不可能工作时 Chart 会拒绝安装，比如多个副本却没有共享存储。

:::

:::tab[在一台机器上试多副本]

```bash
docker compose -f compose.yaml -f deploy/scale/compose.yaml up --scale pandocs=3
```

:::

::::

## 在各家云上

用的是同一个 Chart 或容器，差别只在下面这些配置。

| | AWS | 腾讯云 | 阿里云 |
| --- | --- | --- | --- |
| 运行 | EKS 或 ECS | TKE | ACK |
| PostgreSQL | RDS 或 Aurora | TencentDB for PostgreSQL | RDS 或 PolarDB for PostgreSQL |
| 上传文件 | S3 | COS | OSS |
| 共享目录 | EFS | CFS | NAS |
| 负载均衡 | ALB | CLB | ALB |

:::warning[这些配置还没有在云上跑过]

配置是按各家的文档写的，没有在这些云的服务上实际运行过。请先试试上传一张图片、发布到共享目录。

:::

## 横向扩容

副本不在内存里保存关键状态：会话、登录限流、后台任务和模型限额都在 PostgreSQL 里，多加几个就行。

```yaml
autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 10 }
```

用 `PANDOCS_ROLES` 可以把网页和后台任务分开：`web` 提供页面和接口，`worker` 运行后台任务，`publisher` 写共享目录。

一个副本在笔记本上、一万个页面时大致的数字（`scripts/bench.mjs`）：

| | |
| --- | --- |
| 读 4 KB 的页面 | 每秒 1700 次 |
| 保存页面 | 每秒 490 次 |
| 搜一个少见的词 | 每秒 670 次，6 毫秒 |
| 首次打开站点 | 每秒 25 次，80 毫秒 |

## 负载均衡要注意

- 事件流是长连接，要关闭响应缓冲。
- 多人编辑用 `/api/v1/live` 的 WebSocket。负载均衡不转发时，编辑器会提示并继续单人编辑。
- 在设置 `X-Forwarded-For` 的代理后面要设 `PANDOCS_TRUST_PROXY=true`，这样登录限流才能看到真实地址。前面有多层代理时写层数。没有代理时不要设。

## 更新和备份

**更新**：启动新版本就行，数据库在启动时一个副本接一个副本地更新，旧版本的副本同时继续工作。Chart 用 `helm upgrade`，单机用 `git pull && docker compose up -d --build`。先读一下更新记录（英文），需要你做的事都写在“Upgrading”一节。

**备份**：备份 PostgreSQL 和文件就够了，文件在存储桶里，用 Docker Compose 时在 `data` 卷里；共享目录会自己重建。先导出数据库，再复制文件，这样复制到的文件包含数据库里用到的全部。用 Docker Compose 时，下面这些命令实际试过：

```bash
# 备份
docker compose exec -T postgres pg_dump -U pandocs -Fc pandocs > pandocs.dump
docker compose exec -T pandocs tar czf - -C /data . > pandocs-files.tgz

# 恢复到卷是空的新安装
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U pandocs -d pandocs --no-owner < pandocs.dump
docker compose run --rm --no-deps -T pandocs tar xzf - -C /data < pandocs-files.tgz
docker compose up -d
```

备份要和密码一样小心：Git 令牌、Webhook 地址和分享链接在数据库里是原样存的。

## 测过什么

- **Helm**：在真实的 `kind` 集群上，4 个副本滚动更新，约 11.5 万次读和 650 次保存没有失败。
- **NFS**：内核 NFS 服务器加独立客户端，一万个页面，约 2.1 万次读没有读到不完整的内容，挂载卡住时站点继续响应。
- **S3 接口**：RustFS 和 SeaweedFS 真实跑过。COS 和 OSS 只确认了请求不带它们拒绝的校验和。
- **多人编辑**：Chromium，两个副本共用一个数据库，包括副本重启、断线和撤销权限。没有在真实负载均衡后面测过，也没有测过 Safari 和 Firefox。
- **没测过**：各家云自己的服务，包括 CFS、EFS、NAS、COS 和 OSS；真实的 Notion、Confluence 导出；真实的群聊服务。
