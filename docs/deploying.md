# Deploying

Pandocs needs PostgreSQL, and for more than one machine, something speaking the S3 API. Everything else is optional. It uses nothing specific to any cloud, so it runs wherever those two do.

| | What for | Needed |
| --- | --- | --- |
| PostgreSQL 14 or newer | Everything but uploads. No extensions | Always |
| S3 API | Uploads | With more than one machine. Otherwise a directory |
| Shared file system | A read-only copy of chosen spaces for agents to mount | If you want that |
| OpenID Connect or OAuth2 | Signing in with company accounts | If you want that. Otherwise email and password |
| A model API | Asking the documents, summaries, suggestions from discussions, translation | If you want that |

## One machine

```bash
docker compose up
```

Open <http://localhost:8080> and create the administrator. Settings are in [.env.example](../.env.example).

To use it from other machines, set `PANDOCS_URL` to the address they will use, such as `http://192.168.1.20:8080`. Plain HTTP works, but passwords then cross the network unencrypted.

## Kubernetes

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
  --set 'ingress.hosts[0].host=docs.example.com' \
  --set 'ingress.tls[0].secretName=docs-tls' \
  --set 'ingress.tls[0].hosts[0]=docs.example.com'
```

The Secret `docs-tls` holds the certificate, which cert-manager can keep up to date. Where TLS ends before the ingress, at a cloud load balancer, leave `ingress.tls` out; otherwise signing in over plain HTTP does not work, and the chart says so when it installs.

Everything else is in [values.yaml](../deploy/helm/pandocs/values.yaml). The chart refuses to install with settings that could not work, such as several replicas without shared storage.

## On the big clouds

The same chart or containers on each. These are the settings that differ.

| | AWS | Tencent Cloud | Alibaba Cloud |
| --- | --- | --- | --- |
| Run it on | EKS or ECS | TKE | ACK |
| PostgreSQL | RDS or Aurora | TencentDB for PostgreSQL | RDS or PolarDB for PostgreSQL |
| Uploads | S3 | COS | OSS |
| Shared directory | EFS | CFS | NAS |
| Load balancer | ALB | CLB | ALB |

**The settings here follow each vendor's documentation, and have not been run on those clouds' own services.** What has been tested is listed at the end. Please try uploading an image and publishing to the shared directory first.

### Uploads

**AWS S3.** Only the bucket and region. On EKS, give the pods a role rather than keys:

```yaml
storage:
  s3: { bucket: my-docs, region: eu-west-1 }
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/pandocs
```

**Tencent COS.** The bucket name includes your APPID. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` hold a SecretId and SecretKey:

```yaml
storage:
  s3: { bucket: my-docs-1250000000, region: ap-guangzhou, endpoint: "https://cos.ap-guangzhou.myqcloud.com" }
```

**Alibaba OSS.** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` hold an AccessKey pair. If it reports a signature mismatch, the region is the first thing to check:

```yaml
storage:
  s3: { bucket: my-docs, region: cn-hangzhou, endpoint: "https://oss-cn-hangzhou.aliyuncs.com" }
```

Leave `forcePathStyle` off on COS and OSS, which refuse that style. Turn it on for a self-hosted service without a wildcard domain, such as RustFS or SeaweedFS.

### The shared directory

Mount it for the publishing pods, read-write, through a `PersistentVolumeClaim` that many pods can use, and read-only in agents' sandboxes. See [Files and agents](./files-and-agents.md) for what it holds.

```yaml
publish:
  enabled: true
  existingClaim: shared-docs
  spaces: handbook,guide
```

Pods serving pages do not need the mount. Publishing runs in pods of its own, so a mount that hangs only delays the files.

The NFS version matters more than the vendor:

| | Version | Mount options |
| --- | --- | --- |
| EFS | NFSv4.1 | What the EFS CSI driver sets |
| CFS | NFSv4.0 | `vers=4.0,noresvport`. Tencent recommends v3 for metadata speed, but see below |
| NAS | NFSv4.0 if the file system offers it, otherwise v3 | `noresvport` |

In our tests a save reached another NFSv4 client in about half a second, and an NFSv3 client in about six. If six seconds is fine for your agents, v3 works, and nothing is ever half-written either way. On v3, a process holding a file open also gets a stale handle error when the file is replaced, so tools should read files and close them.

For agents, `lookupcache=positive` means a new file can be opened as soon as it exists, rather than up to a minute later.

### PostgreSQL

Use a recent minor version of 14 or newer. Migrations run by themselves at start, one replica at a time, and only ever add things, so old replicas keep working during an update. A replica leaves the tables alone unless the schema has changed. When it has, it works through it one statement at a time and gives way to requests, so people can keep saving throughout.

**With a connection pooler.** `LISTEN` and session locks need a real connection, so with PgBouncer in transaction mode, or a proxy like RDS Proxy that does not support them, point `PANDOCS_DATABASE_LISTEN_URL` straight at the database. Live updates and publishing use it, and everything else goes through `DATABASE_URL`.

**Sharing a server.** A write transaction left open anywhere on the same PostgreSQL server holds live updates back until it ends. Nothing is lost. If other applications run long writes there, give Pandocs its own server.

### Load balancers

- **Live events** are long-lived responses. Turn off response buffering for them. Heartbeats every 25 seconds keep them open through an idle timeout of 30 seconds or more.
- **Editing together** uses a WebSocket at `/api/v1/live`, with a ping every 30 seconds. If a balancer does not pass it on, the editor works alone and says so. See [Editing together](./live-editing.md).
- **Idle timeouts.** Pandocs keeps connections for 65 seconds, so that a balancer with the common 60-second timeout never reuses one just closed. If yours is longer, lower it to 60.
- **Updates.** When told to stop, a replica says it is not ready, keeps answering for 5 seconds (`PANDOCS_DRAIN_SECONDS`) while it moves clients to new connections, then ends. If your balancer takes longer to notice, raise that.
- **Below a path of another site.** To have the site at `https://example.com/docs`, set `PANDOCS_URL=https://example.com/docs` and have the load balancer send everything under `/docs` here with the path as it is, without taking `/docs` off. Pages, the API, files, sign-in, MCP and the WebSocket all live below it, cookies stay below it, and every address the site writes, in pages, mail, webhooks and to agents, starts with it. One build works at any path. `/healthz` and `/readyz` also answer at the root, for whatever runs the process. An agent signing in through MCP looks for `/.well-known/oauth-authorization-server/docs` and `/.well-known/oauth-protected-resource/docs/mcp` at the root of the host, so send those two here as well for that; an agent with a token needs nothing more. Crawlers read the host's own `robots.txt`, so copy what `/docs/robots.txt` says into it.
- **Addresses.** Set `PANDOCS_TRUST_PROXY=true` behind a proxy that sets `X-Forwarded-For`, which the chart does, so login throttling sees people's real addresses. Only the last address in the header is believed, since a client can write anything before it. With more proxies in front, such as a CDN before a load balancer, give their number instead: `PANDOCS_TRUST_PROXY=2`. Do not set it without one, or anyone could claim any address.

## Updating

Start the new version. It updates the database when it starts, one replica at a time, and replicas still on the old version keep working meanwhile. With the chart that is `helm upgrade`, and on one machine `git pull && docker compose up -d --build`. Read the [changelog](../CHANGELOG.md) first: anything you have to do is under *Upgrading*.

Going back to the version before works the same way, since updates only add to the database. Make a backup first all the same.

## People

Whoever first opens a new site creates the administrator. To have that settled before anyone can reach it, set `PANDOCS_ADMIN_EMAIL` and `PANDOCS_ADMIN_PASSWORD`.

Under *Users*, an administrator adds someone and gets a link for them to choose a password. It works once, within 7 days, and a newer one replaces it. Until it is used it is a way into that account, so send it somewhere private. *Reset password* makes a new one the same way, and using it signs that person out everywhere else.

With mail set up (`PANDOCS_SMTP_HOST`), the link also goes to their mailbox, and *Forgot your password?* on the sign-in page sends one that works for an hour. Without mail, that page says to ask an administrator.

With `PANDOCS_PASSWORD_LOGIN=false`, accounts come from the company's login and there are no passwords to set.

A site below a path of another (see *Load balancers*) can sign people in with that site's own session instead, set with `PANDOCS_HOST_SESSION_URL` and the other `PANDOCS_HOST_` settings in `.env.example`. The browser sends the other site's cookie here too. Pandocs sends the cookies named in `PANDOCS_HOST_SESSION_COOKIES`, and no others, to that address, which answers with who it is in JSON. Their account is made the first time, linked to the host's identifier, and their name, roles (as groups) and whether they administer the site follow the host's answer every time. Answers count for `PANDOCS_HOST_SESSION_SECONDS`, a minute unless set, and a host that is down only keeps out those it was not asked about lately. Someone with no session is sent to `PANDOCS_HOST_LOGIN_URL`, and signing out goes to `PANDOCS_HOST_LOGOUT_URL`. An answer with no email gives the account an address ending in `.invalid`, which no mail goes to. Tokens for agents and the command line are made in *Account and tokens* as usual. Since both sites are on one host, a script that one of them lets run could act in the other as whoever is reading: the policy Pandocs sends allows none from pages, and the host should hold to the same.

## A public documentation site

Any space can be opened to people with no login, one at a time, from its settings page. Space administrators can do this, and it is recorded in the audit log.

A visitor can read that space's pages, search them, and see the images they use. Everything else stays closed: restricted pages, comments, suggestions, version history, who wrote what, other spaces, and all of the API not listed as public in [the API description](./api/openapi.yaml). With nothing public, the site answers exactly as a closed one does.

- **Rule it out for a whole site** with `PANDOCS_PUBLIC_SPACES=false`, for instance on an internal deployment.
- **Limits.** Each replica allows one address 600 requests a minute, of which 120 can be searches, and shares its most expensive answers between visitors for a few seconds. Anything more determined is for a CDN or a firewall in front.
- **What is closed looks like what is missing.** Someone with no login gets a 404 for an address they cannot see, the same as for one that does not exist, with a note that it may be behind a login. Only the app's own pages under `/_/` send them to log in. On a site with nothing public, everything does.
- **Search engines** get finished pages (see [below](#how-pages-are-rendered)), with a title, a description and share cards, `/sitemap.xml` and `/robots.txt`. Addresses that do not exist answer 404, ones that moved answer 301, and each page has one address that the others lead to. A site with nothing public tells crawlers to stay out.
- **Agents** find `/llms.txt` and `/llms-full.txt`, also per space and language, and each page's Markdown at `/<space>/<path>.md` or by asking for `text/markdown`. `/mcp/public` is read-only MCP with no login. See [Connecting agents](./connecting-agents.md).

## Share links

Someone who can edit a page can make a link that lets anyone read it with no login: the page, and optionally its subpages, until the link expires or is revoked. The visitor sees nothing else on the site, not even other public pages, cannot comment, and is not offered search. A page only some people can read cannot be shared this way, and one that becomes so stops working at once.

`PANDOCS_PUBLIC_SPACES=false` turns these off along with public spaces.

## AI

Set `PANDOCS_LLM_API_KEY`, `PANDOCS_LLM_MODEL` and, for anything other than the provider's own address, `PANDOCS_LLM_BASE_URL`. `PANDOCS_LLM_PROTOCOL` is `openai`, which most services speak, or `anthropic`. That gives people summaries, suggestions from discussions, translation and *Ask AI* next to the search box, which answers from the pages they can read, with links to them.

- **It needs no embeddings or search index**, and no PostgreSQL extension: the model looks things up with the same search and reading as everyone else. The model has to support tool calls.
- **Limits.** `PANDOCS_LLM_HOURLY_LIMIT` is per person, 60 by default, and one question counts once however many turns it takes. Several turns of reading do cost more than one call.
- **Visitors.** Someone with no login can only ask once you turn it on under *Site settings*, since the site pays for it. They share `PANDOCS_LLM_VISITOR_HOURLY_LIMIT` (60 by default) across the site, and each address gets 20 questions an hour on each replica. Check your provider's bill after turning this on.

### Through a model gateway

Pandocs calls one model. To spread calls over several, fall back to another when one fails, keep the providers' keys in one place or see what it all costs, put a gateway in front and point Pandocs at it, with `PANDOCS_LLM_PROTOCOL=openai`. Pandocs still counts per person, because the gateway only sees Pandocs' key.

| Gateway | License | Settings |
| --- | --- | --- |
| [LiteLLM](https://github.com/BerriAI/litellm) | MIT, apart from its `enterprise` folder | `PANDOCS_LLM_BASE_URL` is the gateway, such as `http://litellm:4000`. The key is one of its keys, and the model one of its `model_name`s |
| [Portkey Gateway](https://github.com/Portkey-AI/gateway) | MIT | `PANDOCS_LLM_BASE_URL` such as `http://portkey:8787/v1`, and what to call in `PANDOCS_LLM_HEADERS` |
| [Higress](https://github.com/alibaba/higress) | Apache-2.0 | The address of its AI route, and a consumer's key |

`PANDOCS_LLM_HEADERS` is a JSON object of headers sent with every call, for a gateway that is told what to do by header. A header named there takes the place of Pandocs' own, `Authorization` included. For Portkey, which takes the provider's key in `Authorization`:

```bash
PANDOCS_LLM_BASE_URL=http://portkey:8787/v1
PANDOCS_LLM_API_KEY=the provider's key
PANDOCS_LLM_MODEL=claude-opus-5-5
PANDOCS_LLM_HEADERS='{"x-portkey-provider":"anthropic"}'
```

A whole Portkey config, with retries and fallbacks, goes in an `x-portkey-config` header the same way. With LiteLLM the routing is in its own config, and Pandocs only names a model:

```yaml
model_list:
  - model_name: docs-assistant
    litellm_params: { model: anthropic/claude-opus-5-5, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: docs-backup
    litellm_params: { model: deepseek/deepseek-chat, api_key: os.environ/DEEPSEEK_API_KEY }
litellm_settings:
  fallbacks: [{ docs-assistant: [docs-backup] }]
```

*Ask AI* needs tool calls, which both pass on. Both were tried with Pandocs' own calls: LiteLLM answering from a stand-in model, and Portkey passing the calls on to it by header. Higress is set up from its documentation and has not been tried. Some gateways are licensed differently: [New API](https://github.com/QuantumNous/new-api), common in China, is AGPL-3.0, so changing it and offering it as a service means publishing the changes.

## Reading numbers

*Insights*, for a space's editors and for administrators, shows how much pages are read, by people and by agents and tools, what is searched for, what finds nothing, what the AI is asked, and what readers and agents say about pages.

These are counts per day, with no addresses, cookies or names, and they stay in your PostgreSQL. Questions are kept as they were written, without who asked, so someone could still write something private in one: they are visible to those same people. Search terms and questions go after 180 days, reading numbers after 400. To keep none of it, set `PANDOCS_READING_STATS=false`. Feedback people leave is not affected, since they wrote it to be read.

## How pages are rendered

Pages leave the server finished, and the browser takes them over from there. It runs on worker threads, so a long page does not hold up anything else: one thread for each language being read, which starts on first use and stops after a minute with nothing to do. A page renders once for the same input, so what many people read the same costs very little. Someone signed in has a view of their own, and that is rendered for them, no more often than it changes.

This costs speed if it goes wrong, not the page. A render that fails or does not come back within 3 seconds gets the request a page for the browser to render, as if this were off; the log says `web.render_failed`, and the next person gets the finished page if it was only slow. A document with more than 200 KB of Markdown is always left to the browser, because rendering takes about 1.2 MB of memory for each KB of it. Everything else that needs a browser, such as the editor, charts and the pages under `/_/`, is drawn by the browser within a finished page. Embedded pages are not rendered on the server, since they get their identity from their host once they run.

Set `PANDOCS_RENDER_PAGES=false` to have the browser do all of it.

Measured on a laptop, in a container limited to 1 GiB:

| | |
| --- | --- |
| A page rendered before | 7 ms, about 1,000 a second |
| A new 15 KB page with code and tables | 50-130 ms, about 70 a second on one thread |
| A new 150 KB page | 0.5-0.7 s |
| A thread starting | about 0.1 s |
| Memory at its highest, long pages in two languages at once | 740 MiB, with other requests still answering in 2 ms |

## Languages

The interface is in English and Chinese. Each person's browser decides, and they can pick one on their account page. On a site with several languages of content, reading pages in one of those languages switches to it. Messages from the API follow `Accept-Language`, and are in English without one, so agents and scripts get English. Mail goes out in the language of whoever caused it.

The languages of the content are a separate setting, under *Site settings*. A new site starts with English. If you write in something else, change it there first, since each language other than the default has its own address prefix.

## Scaling out

Replicas keep nothing in memory that matters: sessions, login throttling, background jobs and model limits all live in PostgreSQL. Add more when they are busy.

```yaml
autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 10 }
```

To set a number yourself, change `replicaCount` and run `helm upgrade`, rather than using `kubectl scale`. Helm 4 refuses to upgrade over a field something else has changed.

Roughly what to expect from one replica on a laptop, on 10,000 pages (`scripts/bench.mjs`):

| | |
| --- | --- |
| Reading a 4 KB page | 1,700 requests a second |
| Saving a page | 490 a second |
| Searching for a rare word | 670 a second, 6 ms |
| First load of the site | 25 a second, 80 ms |

That whole load test ran in a container limited to 768 MB without trouble. A replica with more uses more, since Node only clears memory once it needs to, so high numbers are not by themselves a leak. The chart's limit is 1 GiB. To split work further, `worker.separate` gives background jobs pods of their own.

## Backups

Back up PostgreSQL and the files: the bucket, or with Docker Compose the `data` volume. That is everything. The shared directory is derived, and rebuilds itself if removed.

Dump the database first and copy the files after it. Files are only ever added, so a copy taken afterwards has everything the dump refers to. With Docker Compose:

```bash
docker compose exec -T postgres pg_dump -U pandocs -Fc pandocs > pandocs.dump
docker compose exec -T pandocs tar czf - -C /data . > pandocs-files.tgz
```

To restore, start from an installation whose volumes are empty, and only start the site once both are back:

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U pandocs -d pandocs --no-owner < pandocs.dump
docker compose run --rm --no-deps -T pandocs tar xzf - -C /data < pandocs-files.tgz
docker compose up -d
```

Restore into the same version or a newer one, which brings the database up to date when it starts. This was tried on a site with pages, pictures, comments, suggestions and accounts: every table came back with the same rows and every file with the same checksum, people signed in with their own passwords, and new uploads worked. Copying a bucket, with your provider's tools or `rclone`, has not been tried here.

Keep backups as carefully as passwords. Passwords and API tokens are only there as hashes, but what has to be sent to other systems cannot be: Git tokens, webhook addresses and their secrets, and share links are in the database as they are.

## What has been tested

- **`test/helm/run.sh`**, on a real Kubernetes cluster with `kind`: several replicas on one database and object store, background work and publishing in pods of their own. A rolling update of 4 pods under load had no failed requests out of about 115,000 reads and 650 saves. Losing the publishing pod was covered within a second.
- **`test/nfs/run.sh`**, on a kernel NFS server with separate clients and 10,000 pages: no partial reads out of about 21,000, and the site kept answering while the mount hung.
- **S3 API**: RustFS and SeaweedFS for real. For COS and OSS only that requests carry none of the checksums some services refuse.
- **Feishu**: the document conversion, on real documents read through the API with a person's login, and the shapes of the API's answers. Everything else, including an app's own credentials and images, against a stand-in written from the API's documentation.
- **Editing together**: in Chromium, with people on two replicas on one database, a replica stopping and coming back, lost connections and permissions being withdrawn, on the production build. Not behind a real load balancer, and not in Safari or Firefox.
- **Git sync**: against Git's own HTTP server on this machine, including partial clones, tokens, refused redirects, SHA-256 repositories and pushes losing a race. Not against GitHub, GitLab or any other real host.
- **Not tested**: the clouds' own services, including CFS, EFS, NAS, COS and OSS. They speak the same protocols, but they are not the same software. Real Notion and Confluence exports: the importers work from what those tools are documented and reported to produce. Real chat services: messages match their documentation, except DingTalk's, whose documentation could not be read at the time and which follows others' working code.
