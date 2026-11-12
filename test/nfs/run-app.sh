#!/bin/sh
# Mounted from inside the container, so that it is a client of its own with its own cache, as a separate machine would be.
set -e
mkdir -p /mnt/shared
until mount -t nfs -o vers=4.1,hard nfs-server:/ /mnt/shared; do sleep 1; done
exec node main.mjs
