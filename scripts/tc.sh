#!/usr/bin/env bash
# Typecheck pageink-core and show only errors under the given src folders.
# Usage: pnpm tc anchor place     (no arguments: show everything)
set -uo pipefail
cd "$(dirname "$0")/../packages/core"
out=$(npx tsc -p tsconfig.json --pretty false 2>&1)
if [ $# -eq 0 ]; then echo "$out"; [ -z "$out" ]; exit $?; fi
pat=$(printf 'src/%s/|' "$@"); pat="${pat%|}"
hits=$(echo "$out" | grep -E "^($pat)" || true)
if [ -n "$hits" ]; then echo "$hits"; exit 1; fi
echo "ok: no type errors under: $*"
