#!/usr/bin/env bash
# Generates the clients from docs/api/openapi.yaml. CI runs this and fails if anything changes, so they cannot drift.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
SPEC="$ROOT/docs/api/openapi.yaml"

pnpm --filter @pandocs/client run generate

(cd sdks/go && go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.2 -config oapi.yaml "$SPEC" && go mod tidy)
