# What the shared-directory test needs on top of the normal images: tools to serve and mount NFS.
FROM alpine:3 AS nfs
RUN apk add --no-cache nfs-utils iproute2 tar grep findutils coreutils

FROM pandocs:local AS app
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nfs-common iproute2 && rm -rf /var/lib/apt/lists/*
