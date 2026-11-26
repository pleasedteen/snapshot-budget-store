#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mode="${1:-all}"

case "$mode" in
  test|tests)
    npm test
    ;;
  demo)
    npm run demo
    ;;
  all|verify)
    npm run verify
    ;;
  *)
    echo "用法: ./run.sh [test|demo|all]" >&2
    exit 64
    ;;
esac
