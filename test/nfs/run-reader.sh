#!/bin/sh
set -e
mkdir -p /mnt/shared /mnt/v3
until mount -t nfs -o vers=4.1,hard,ro nfs-server:/ /mnt/shared; do sleep 1; done
until mount -t nfs -o vers=3,nolock,hard,ro nfs-server:/export /mnt/v3; do sleep 1; done
tc qdisc add dev eth0 root netem delay 1ms 2>/dev/null || true
exec sleep infinity
