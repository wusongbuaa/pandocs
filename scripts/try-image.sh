#!/usr/bin/env bash
# Starts an image the way someone would, with an empty database next to it, and looks at what it does.
set -euo pipefail
IMAGE="${1:?usage: try-image.sh <image> <version>}"
VERSION="${2:?usage: try-image.sh <image> <version>}"
RUN="pandocs-try-$$"
cleanup() {
  docker rm -f "$RUN-site" "$RUN-db" >/dev/null 2>&1 || true
  docker network rm "$RUN" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$RUN" >/dev/null
docker run -d --name "$RUN-db" --network "$RUN" -e POSTGRES_PASSWORD=try postgres:18-alpine >/dev/null
for attempt in $(seq 1 30); do
  docker exec "$RUN-db" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker run -d --name "$RUN-site" --network "$RUN" -e "DATABASE_URL=postgres://postgres:try@$RUN-db:5432/postgres" -e PANDOCS_URL=http://localhost:8080 "$IMAGE" >/dev/null

ask() { docker exec "$RUN-site" node -e "fetch('http://127.0.0.1:8080$1', { redirect: 'manual' }).then(async r => console.log(r.status, (await r.text()).length)).catch(e => { console.log('failed', e.message); process.exit(1); })"; }

for attempt in $(seq 1 60); do
  if [ "$(docker exec "$RUN-site" node -e "fetch('http://127.0.0.1:8080/readyz').then(r => console.log(r.status)).catch(() => console.log(0))" 2>/dev/null)" = "200" ]; then break; fi
  if [ "$attempt" = 60 ]; then docker logs "$RUN-site" | tail -20; echo "it never became ready"; exit 1; fi
  sleep 2
done

fail() { docker logs "$RUN-site" | tail -20; echo "$1"; exit 1; }
docker logs "$RUN-site" 2>&1 | grep -q "\"version\":\"$VERSION\"" || fail "it does not say it is $VERSION"
if docker logs "$RUN-site" 2>&1 | grep -qi 'warning'; then fail "it warns about something when it starts"; fi
[ "$(ask /login | cut -d' ' -f1)" = 200 ] || fail "the sign-in page does not answer"
[ "$(ask /assets/no-such-file.js | cut -d' ' -f1)" != 500 ] || fail "it fails on a missing file"
[ "$(docker exec "$RUN-site" id -u)" != 0 ] || fail "it runs as root"
docker exec "$RUN-site" git --version >/dev/null || fail "there is no Git for keeping spaces in step with repositories"
docker exec "$RUN-site" sh -c 'test -s /app/LICENSE && test -s /app/NOTICE' || fail "the license is not in the image"
[ "$(ask /THIRD-PARTY-NOTICES.txt | cut -d' ' -f1)" = 200 ] || fail "the licenses of what is bundled are not served"
for carried in "PDF.js, built into unpdf" "packages/web/vendor/rspress," "packages/web/vendor/shadcn,"; do
  docker exec "$RUN-site" grep -qF "$carried" /app/web/THIRD-PARTY-NOTICES.txt || fail "the licenses of what is bundled leave out $carried"
done
docker exec "$RUN-site" sh -c 'test -z "$(find /app -name "*.node" | head -1)"' || fail "there is a native module in the image, so building once for every platform no longer works"
[ "$(docker exec "$RUN-site" sh -c 'test ! -e /app/web/ssr/worker.mjs || echo rendered')" = rendered ] || fail "pages would not be rendered on the server"
echo "$IMAGE works, as $VERSION"
