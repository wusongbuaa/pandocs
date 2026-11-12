#!/usr/bin/env bash
# Publishes a large space to a real kernel NFS server and checks what another client sees: how soon, whether a file is
# ever half-written, how a copy starts from it, and what happens when the publishing replica goes away.
#
# Needs Docker with privileged containers, and Go. Leaves nothing behind unless KEEP=1.
#   PAGES=10000 test/nfs/run.sh
set -euo pipefail

cd "$(dirname "$0")"
PAGES="${PAGES:-10000}"
SPACE=handbook
SERVER=http://proxy:8080
ARCH="$(docker version --format '{{.Server.Arch}}')"

dc() { docker compose "$@"; }
cleanup() {
  if [ "${KEEP:-0}" != 1 ]; then
    # In this order. A client with a hard mount cannot be killed once its server has gone, and a kernel server holds up
    # its own container for a long time unless it is told to stop first.
    dc stop -t 2 reader app-1 app-2 proxy >/dev/null 2>&1 || true
    dc exec -T nfs-server sh -c 'exportfs -ua; rpc.nfsd 0' >/dev/null 2>&1 || true
    dc down -v --timeout 5 >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }

step "Building"
mkdir -p .bin
(cd ../../cli && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -o ../test/nfs/.bin/pandocs .)
(cd probe && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -o ../.bin/probe .)
docker image inspect pandocs:local >/dev/null 2>&1 || docker build -t pandocs:local ../..
dc build --quiet ${DOCKER_BUILD_ARGS:-}

step "Starting: PostgreSQL, a kernel NFS server, two replicas, a proxy, and a reader on its own NFS client"
dc up -d --wait --wait-timeout 30 postgres
dc up -d
sleep 3

in_reader() { dc exec -T -e PANDOCS_TOKEN="${TOKEN:-}" -e PANDOCS_URL="$SERVER" -e PROBE_POLL_MS="${PROBE_POLL_MS:-5}" reader "$@"; }
probe() { in_reader /opt/rig/.bin/probe "$1" "$SERVER" "${@:2}"; }
TOKEN="$(probe setup)"

step "Seeding $PAGES pages of 4 KB through the API"
probe seed "$SPACE" "$PAGES" 4000
probe compare "$SPACE" /mnt/shared 300

step "Rebuilding the whole directory from nothing"
dc exec -T app-1 sh -c "rm -rf /mnt/shared/$SPACE"
dc restart -t 3 app-1 app-2 >/dev/null
probe compare "$SPACE" /mnt/shared 600

step "How soon another NFS client sees a save (NFSv4.1, default mount options)"
probe latency "$SPACE" /mnt/shared 40
step "The same on NFSv3"
probe latency "$SPACE" /mnt/v3 20
step "NFSv3, for a reader that checks twice a second instead of without pause"
PROBE_POLL_MS=500 probe latency "$SPACE" /mnt/v3 10

step "Whether a reader ever sees half a file"
probe torn "$SPACE" /mnt/shared 20

step "Starting a copy from the shared directory, without a server"
in_reader sh -c "
  set -e
  export PANDOCS_CONFIG=/tmp/none PANDOCS_URL= PANDOCS_TOKEN=
  sleep 25 # let the pack catch up with the last writes
  ls -la /mnt/shared/$SPACE/.pandocs/ | sed 1d
  start=\$(date +%s%N)
  /opt/rig/.bin/pandocs sync $SPACE /tmp/copy --from /mnt/shared/$SPACE --json > /tmp/report.json
  echo \"sync --from: \$(( (\$(date +%s%N) - start) / 1000000 )) ms, \$(grep -c '\.md' /tmp/report.json) files\"
  start=\$(date +%s%N); grep -rl needle50 /tmp/copy --include=*.md | wc -l
  echo \"grep on the copy: \$(( (\$(date +%s%N) - start) / 1000000 )) ms\"
  start=\$(date +%s%N); grep -rl needle50 /mnt/shared/$SPACE --include=*.md | wc -l
  echo \"grep on NFS: \$(( (\$(date +%s%N) - start) / 1000000 )) ms\"
  cd /tmp/copy && PANDOCS_CONFIG=/tmp/none /opt/rig/.bin/pandocs status | tail -1
"

step "A hung mount must only delay the files, not the site"
dc exec -T nfs-server tc qdisc replace dev eth0 root netem loss 100%
sleep 2
probe edit "$SPACE" p3-3 "$(printf '# Changed\n\nwhile the mount was hung\n')"
sleep 2
started="$(date +%s%N)"
for number in 1 2 3 4 5 6 7 8 9 10; do
  in_reader wget -q -O /dev/null "$SERVER/healthz"
  probe edit "$SPACE" p4-4 "$(printf '# Changed\n\nedit %s while the mount was hung\n' "$number")"
done
echo "20 requests while the NFS server was unreachable: $(( ($(date +%s%N) - started) / 1000000 )) ms in all"
dc exec -T nfs-server tc qdisc replace dev eth0 root netem delay 1ms
printf 'the files caught up after the mount came back in '
probe wait-text "/mnt/shared/$SPACE/p4-4.md" 'edit 10 while' 300
probe compare "$SPACE" /mnt/shared 300

step "Following with --watch through the proxy, while the replica answering it goes away"
in_reader sh -c "/opt/rig/.bin/pandocs sync $SPACE /tmp/watched --watch > /tmp/watch.log 2>&1 & echo \$! > /tmp/watch.pid"
for _ in $(seq 1 120); do
  in_reader grep -q Watching /tmp/watch.log && break
  sleep 1
done
probe edit "$SPACE" p1-1 "$(printf '# Changed\n\nbefore a replica stops\n')"
for _ in $(seq 1 30); do
  in_reader grep -q 'before a replica' /tmp/watched/p1-1.md && break
  sleep 0.5
done
in_reader grep -q 'before a replica' /tmp/watched/p1-1.md
echo "the copy followed a save"
LEADER="$(dc exec -T postgres psql -U postgres -Atc "SELECT a.client_addr FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.locktype = 'advisory' AND l.granted" | head -1)"
echo "publisher lock held from $LEADER"
for name in app-1 app-2; do
  address="$(dc exec -T "$name" hostname -i | tr -d '[:space:]')"
  if [ "$address" = "$LEADER" ]; then
    STOPPED="$name"
    KEPT="$([ "$name" = app-1 ] && echo app-2 || echo app-1)"
  fi
done
echo "stopping $STOPPED, the replica publishing"
dc stop -t 2 "$STOPPED" >/dev/null
probe edit "$SPACE" p2-2 "$(printf '# Changed\n\nafter a replica stopped\n')"
printf '%s took over publishing, and the change was there in ' "$KEPT"
probe wait-text "/mnt/shared/$SPACE/p2-2.md" 'after a replica' 120
probe compare "$SPACE" /mnt/shared 300
for _ in $(seq 1 60); do
  in_reader grep -q 'after a replica' /tmp/watched/p2-2.md && break
  sleep 0.5
done
in_reader grep -q 'after a replica' /tmp/watched/p2-2.md
echo "the copy reconnected and caught up"
dc start "$STOPPED" >/dev/null
in_reader sh -c 'kill "$(cat /tmp/watch.pid)"'

step "Memory"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $(dc ps -q app-1 app-2 postgres)

step "All checks passed"
