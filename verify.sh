#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "== Offline Map Snapshot Lab: build + tests + demo =="
echo "Node: $(node --version)"
echo

npm run verify
