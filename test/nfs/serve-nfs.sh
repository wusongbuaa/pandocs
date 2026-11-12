#!/bin/sh
# A kernel NFS server, because the point is to see what real clients do with what the publisher writes.
set -e
mkdir -p /export
mountpoint -q /export || mount -t tmpfs tmpfs /export
mountpoint -q /proc/fs/nfsd || mount -t nfsd nfsd /proc/fs/nfsd
echo '/export *(rw,sync,no_subtree_check,no_root_squash,insecure,fsid=0)' > /etc/exports
rpcbind -w 2>/dev/null || rpcbind
exportfs -ra
rpc.nfsd 8
tc qdisc add dev eth0 root netem delay 1ms 2>/dev/null || true
exec rpc.mountd -F
