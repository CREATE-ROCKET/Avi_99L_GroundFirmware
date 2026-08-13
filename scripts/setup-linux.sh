#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js LTS が必要です。distributionのpackage managerで導入してください。" >&2
  exit 1
fi

npm install
npm test
npm run dev
