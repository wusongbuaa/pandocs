---
title: Deploying
---

Only PostgreSQL is required. With more than one machine you also need something speaking the S3 API, and everything else is optional. It uses nothing specific to any cloud.

| | What for | Needed |
| --- | --- | --- |
| PostgreSQL 14 or newer | Everything but uploads. No extensions | Always |
| S3 API | Uploads | With more than one machine. Otherwise a directory |
| Shared file system | A read-only copy for agents to mount | If you want that |
| OpenID Connect or OAuth2 | Signing in with company accounts | If you want that. Otherwise email and password |
| A model API | Ask AI, summaries, translation | If you want that |

## How to deploy

::::tabs

:::tab[One machine]

```bash
docker compose up
```

Open `http://localhost:8080` and create the administrator. Settings are in `.env.example`.

To use it from other machines, set `PANDOCS_URL` to the address they will use. Plain HTTP works, but passwords then cross the network unencrypted.

To put it below a path of a site you already have, such as `https://example.com/docs`, give `PANDOCS_URL` that path and have the load balancer send everything under `/docs` here as it is, without taking `/docs` off.

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

The chart refuses to install with settings that could not work, such as several replicas without shared storage.

:::

:::tab[Several replicas on one machine]

```bash
docker compose -f compose.yaml -f deploy/scale/compose.yaml up --scale pandocs=3
```

:::

::::

## On the big clouds

The same chart or containers on each. These are the settings that differ.

| | AWS | Tencent Cloud | Alibaba Cloud |
| --- | --- | --- | --- |
| Run it on | EKS or ECS | TKE | ACK |
| PostgreSQL | RDS or Aurora | TencentDB for PostgreSQL | RDS or PolarDB for PostgreSQL |
| Uploads | S3 | COS | OSS |
| Shared directory | EFS | CFS | NAS |
| Load balancer | ALB | CLB | ALB |

:::warning[These have not been run on those clouds]

The settings follow each vendor's documentation, and have not been run on their own services. Try uploading an image and publishing to the shared directory first.

:::

## Scaling out

Replicas keep nothing in memory that matters: sessions, login throttling, background jobs and model limits all live in PostgreSQL. Add more when they are busy.

```yaml
autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 10 }
```

`PANDOCS_ROLES` splits the work: `web` serves pages and the API, `worker` runs background jobs, and `publisher` writes the shared directory.

Roughly what to expect from one replica on a laptop, on 10,000 pages (`scripts/bench.mjs`):

| | |
| --- | --- |
| Reading a 4 KB page | 1,700 requests a second |
| Saving a page | 490 a second |
| Searching for a rare word | 670 a second, 6 ms |
| First load of the site | 25 a second, 80 ms |

## Load balancers

- Live events are long-lived responses, so turn off response buffering for them.
- Editing together uses a WebSocket at `/api/v1/live`. If a balancer does not pass it on, the editor says so and works alone.
- Behind a proxy that sets `X-Forwarded-For`, set `PANDOCS_TRUST_PROXY=true`, so login throttling sees real addresses. With more proxies in front, give their number. Do not set it without one.

## Updating and backups

**Updating.** Start the new version. It updates the database when it starts, one replica at a time, and replicas on the old version keep working meanwhile. With the chart that is `helm upgrade`, and on one machine `git pull && docker compose up -d --build`. Read the changelog first: anything you have to do is under *Upgrading*.

**Backups.** Back up PostgreSQL and the files, which are in the bucket, or with Docker Compose in the `data` volume. The shared directory rebuilds itself. Dump the database first and copy the files after, so that the copy has everything the dump refers to. With Docker Compose, these have been tried:

```bash
# Back up
docker compose exec -T postgres pg_dump -U pandocs -Fc pandocs > pandocs.dump
docker compose exec -T pandocs tar czf - -C /data . > pandocs-files.tgz

# Restore into an installation whose volumes are empty
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U pandocs -d pandocs --no-owner < pandocs.dump
docker compose run --rm --no-deps -T pandocs tar xzf - -C /data < pandocs-files.tgz
docker compose up -d
```

Keep backups as carefully as passwords: Git tokens, webhook addresses and share links are in the database as they are.

## What has been tested

- **Helm**, on a real `kind` cluster: a rolling update of 4 pods with no failed requests out of about 115,000 reads and 650 saves.
- **NFS**, on a kernel NFS server with separate clients and 10,000 pages: no partial reads out of about 21,000, and the site kept answering while the mount hung.
- **The S3 API**: RustFS and SeaweedFS for real. For COS and OSS only that requests carry none of the checksums they refuse.
- **Editing together**: in Chromium, with people on two replicas, including a replica restarting, lost connections and permissions being withdrawn. Not behind a real load balancer, and not in Safari or Firefox.
- **Not tested**: the clouds' own services, including CFS, EFS, NAS, COS and OSS. Real Notion and Confluence exports. Real chat services.
