#!/usr/bin/env bash
# Packs what gets published, and uses each from outside this repository the way someone installing it would.
# What it leaves in the output directory is what a release publishes.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="${1:?usage: try-packages.sh <version> [output directory]}"
OUT="${2:-$ROOT/out}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT/npm" "$OUT/chart"

echo "== npm"
for name in client embed; do
  pnpm --filter "@pandocs/$name" pack --pack-destination "$OUT/npm" >/dev/null
  tar -tzf "$OUT/npm/pandocs-$name-$VERSION.tgz" | sort > "$WORK/$name.files"
  for required in package/LICENSE package/README.md package/package.json package/dist/index.js package/dist/index.d.ts; do
    grep -qx "$required" "$WORK/$name.files" || { echo "$name has no $required"; exit 1; }
  done
  if grep -E '^package/(src|test|node_modules)/|\.tsbuildinfo$' "$WORK/$name.files"; then echo "$name has files it should not"; exit 1; fi
  tar -xzOf "$OUT/npm/pandocs-$name-$VERSION.tgz" package/package.json > "$WORK/$name.json"
  if grep -E 'workspace:|"\./src/' "$WORK/$name.json"; then echo "$name still points inside this repository"; exit 1; fi
done

mkdir "$WORK/npm-use"
cat > "$WORK/npm-use/package.json" <<JSON
{ "name": "try", "private": true, "type": "module", "dependencies": {
  "@pandocs/client": "file:$OUT/npm/pandocs-client-$VERSION.tgz",
  "@pandocs/embed": "file:$OUT/npm/pandocs-embed-$VERSION.tgz",
  "react": "^19.0.0", "@types/react": "^19.0.0", "typescript": "^5.9.0", "@types/node": "^24.0.0", "esbuild": "^0.25.0"
} }
JSON
(cd "$WORK/npm-use" && npm install --silent --no-audit --no-fund)
cp "$ROOT/scripts/try-packages/use-npm.ts" "$ROOT/scripts/try-packages/use-npm-types.tsx" "$WORK/npm-use/"
for resolution in nodenext bundler; do
  module=esnext
  if [ "$resolution" = nodenext ]; then module=nodenext; fi
  (cd "$WORK/npm-use" && npx tsc --noEmit --strict --skipLibCheck false --target es2022 --lib es2022,dom --jsx react-jsx --module "$module" --moduleResolution "$resolution" --types node use-npm-types.tsx)
done
(cd "$WORK/npm-use" && npx esbuild use-npm.ts --bundle --platform=node --format=esm --packages=external --outfile=use-npm.mjs --log-level=warning && node use-npm.mjs)
# What a bundler makes of it, for a page that puts it on the screen.
(cd "$WORK/npm-use" && npx esbuild use-npm-types.tsx --bundle --format=esm --jsx=automatic --outfile=page.js --log-level=warning)

echo "== go"
mkdir "$WORK/go-use"
cp scripts/try-packages/use_go.go "$WORK/go-use/main.go"
(cd "$WORK/go-use" && go mod init try >/dev/null 2>&1 && go mod edit -replace "github.com/wusongbuaa/pandocs/sdks/go=$ROOT/sdks/go" && go mod edit -require github.com/wusongbuaa/pandocs/sdks/go@v0.0.0 && go mod tidy >/dev/null 2>&1 && go run .)

echo "== chart"
helm="${HELM:-helm}"
$helm lint deploy/helm/pandocs --set url=https://docs.example.com,existingSecret=s,storage.s3.bucket=b >/dev/null
$helm package deploy/helm/pandocs --version "$VERSION" --app-version "$VERSION" --destination "$OUT/chart" >/dev/null
$helm template pandocs "$OUT/chart/pandocs-$VERSION.tgz" --set url=https://docs.example.com,existingSecret=s,storage.s3.bucket=b > "$WORK/chart.yaml"
grep -q "image: .*:$VERSION\"\?$" "$WORK/chart.yaml" || { echo "the chart does not run this version's image"; exit 1; }

echo "== all of it"
(cd "$OUT" && find . -type f | sort)
