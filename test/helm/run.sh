#!/usr/bin/env bash
# Installs the chart on a real Kubernetes cluster, and checks what it is for: several replicas sharing one database and
# object storage, background work and publishing in pods of their own, and updates that nobody notices.
#
# Needs Docker, kind, helm, kubectl, Go and a pandocs:local image. Leaves nothing behind unless KEEP=1.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
CLUSTER=pandocs-chart-test
export KUBECONFIG="$PWD/.kubeconfig"
NODE="$CLUSTER-control-plane"
BIN="$(mktemp -d)"
ARCH="$(docker version --format '{{.Server.Arch}}')"

cleanup() {
  status=$?
  if [ "$status" != 0 ] && [ -f "$KUBECONFIG" ]; then
    printf '\n== What the cluster looked like when this failed\n'
    kubectl get pods -o wide || true
    kubectl get events --sort-by=.lastTimestamp | tail -30 || true
    # Pods replaced during the test take their logs with them, but the database saw what went wrong.
    kubectl logs deploy/postgres | grep -E 'ERROR|FATAL|DETAIL' | tail -30 || true
    for pod in $(kubectl get pods -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
      printf '\n-- %s\n' "$pod"
      kubectl describe pod "$pod" | sed -n '/^Containers:/,/^Conditions:/p' | grep -E 'State:|Reason:|Exit Code:|Restart Count:|Ready:' || true
      kubectl logs "$pod" --tail=15 || true
      kubectl logs "$pod" --previous --tail=15 2>/dev/null || true
    done
  fi
  if [ "${KEEP:-0}" != 1 ]; then
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
    rm -f "$KUBECONFIG"
  fi
  rm -rf "$BIN"
  [ -n "${WATCH_PID:-}" ] && kill "$WATCH_PID" 2>/dev/null || true
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
drive() { node drive.mjs "$@"; }
pods() { kubectl get pods -l "app.kubernetes.io/component=$1" -o jsonpath='{.items[*].metadata.name}'; }

step "Starting a cluster"
kind create cluster --name "$CLUSTER" --config kind.yaml --wait 120s >/dev/null 2>&1
for image in pandocs:local postgres:18-alpine rustfs/rustfs:1.0.4; do
  # Only this machine's platform: a pulled image may list others that Docker never downloaded.
  docker save --platform "linux/$ARCH" "$image" | docker exec -i "$NODE" ctr --namespace k8s.io images import - >/dev/null
done
kubectl apply -f deps.yaml >/dev/null
kubectl rollout status deploy/postgres --timeout=120s >/dev/null
kubectl rollout status deploy/s3 --timeout=120s >/dev/null
(cd "$ROOT/packages/core" && node "$ROOT/test/helm/make-bucket.mjs")

step "Installing the chart"
helm install pandocs "$ROOT/deploy/helm/pandocs" -f values.yaml --wait --timeout 300s >/dev/null
kubectl get pods -o custom-columns='POD:.metadata.name,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount' --no-headers | grep pandocs

step "Working with it"
TOKEN="$(drive token)"
drive setup "$TOKEN"
drive convert "$TOKEN"

step "Publishing from pods of their own"
for _ in $(seq 1 60); do
  kubectl exec "$(pods publisher | cut -d' ' -f1)" -- cat /mnt/shared/handbook/start.md 2>/dev/null | grep -q "Getting started" && break
  sleep 1
done
kubectl exec "$(pods publisher | cut -d' ' -f1)" -- ls /mnt/shared/handbook /mnt/shared/handbook/.pandocs | tr '\n' ' '
echo
LOCK_HOLDERS="$(kubectl exec deploy/postgres -- psql -U postgres -Atc "select count(*) from pg_locks where locktype = 'advisory' and granted")"
echo "advisory locks held: $LOCK_HOLDERS"

step "Scaling out"
helm upgrade pandocs "$ROOT/deploy/helm/pandocs" -f values.yaml --set replicaCount=4 --wait --timeout 180s >/dev/null
echo "$(pods web | wc -w | tr -d ' ') pods serving"
drive edit "$TOKEN" start "$(printf '# Getting started\n\nAfter scaling out.\n')"

step "An update under load: reads and saves carry on while every pod is replaced"
CGO_ENABLED=0 go build -C "$ROOT/cli" -o "$BIN/pandocs" .
PANDOCS_URL=http://127.0.0.1:18080 PANDOCS_TOKEN="$TOKEN" PANDOCS_CONFIG="$BIN/none" "$BIN/pandocs" sync handbook "$BIN/copy" --watch > "$BIN/watch.log" 2>&1 &
WATCH_PID=$!
for _ in $(seq 1 30); do grep -q Watching "$BIN/watch.log" && break; sleep 1; done
drive hammer "$TOKEN" 70 &
HAMMER_PID=$!
sleep 3
kubectl rollout restart deploy/pandocs-web >/dev/null
kubectl rollout status deploy/pandocs-web --timeout=180s >/dev/null
echo "every pod replaced"
wait "$HAMMER_PID"

step "A copy following along reconnected by itself"
drive edit "$TOKEN" start "$(printf '# Getting started\n\nAfter the update.\n')"
for _ in $(seq 1 60); do grep -q "After the update" "$BIN/copy/start.md" 2>/dev/null && break; sleep 1; done
grep -q "After the update" "$BIN/copy/start.md"
echo "the copy has the latest text"

step "Losing the publishing pod"
HOLDER_IP="$(kubectl exec deploy/postgres -- psql -U postgres -Atc "select a.client_addr from pg_locks l join pg_stat_activity a using (pid) where l.locktype = 'advisory' and l.granted" | head -1 | tr -d '[:space:]')"
LEADER="$(kubectl get pods -l app.kubernetes.io/component=publisher -o jsonpath="{.items[?(@.status.podIP=='$HOLDER_IP')].metadata.name}")"
echo "deleting $LEADER"
kubectl delete pod "$LEADER" --wait=false >/dev/null
drive edit "$TOKEN" start "$(printf '# Getting started\n\nAfter losing a publisher.\n')"
OTHER="$(pods publisher | tr ' ' '\n' | grep -v "$LEADER" | head -1)"
started=$SECONDS
for _ in $(seq 1 90); do
  kubectl exec "$OTHER" -- cat /mnt/shared/handbook/start.md 2>/dev/null | grep -q "After losing" && break
  sleep 1
done
kubectl exec "$OTHER" -- cat /mnt/shared/handbook/start.md | grep -q "After losing"
echo "the other pod published it within $((SECONDS - started)) s"

step "Upgrading the release"
helm upgrade pandocs "$ROOT/deploy/helm/pandocs" -f values.yaml --set replicaCount=4 --set env.PANDOCS_SITE_TITLE=Upgraded --wait --timeout 240s >/dev/null
drive edit "$TOKEN" start "$(printf '# Getting started\n\nAfter the upgrade.\n')"
echo "the site still answers"

step "Pods restarted during all this"
kubectl get pods -o custom-columns='POD:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount' --no-headers | grep pandocs

step "All checks passed"
