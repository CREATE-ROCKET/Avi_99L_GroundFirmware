#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock_hash=$(sha256sum "$repo_dir/package-lock.json" | cut -d ' ' -f 1)
deps_dir="${XDG_CACHE_HOME:-$HOME/.cache}/create-99l-ground-station/$lock_hash"
expected_link="$deps_dir/node_modules"

mkdir -p "$deps_dir"
if [[ ! -d "$expected_link" ]]; then
  install -m 0644 "$repo_dir/package.json" "$deps_dir/package.json"
  install -m 0644 "$repo_dir/package-lock.json" "$deps_dir/package-lock.json"
  (cd "$deps_dir" && npm ci)
fi

if [[ -L "$repo_dir/node_modules" ]]; then
  if [[ $(readlink "$repo_dir/node_modules") != "$expected_link" ]]; then
    echo "node_modules points to an unexpected location" >&2
    exit 1
  fi
elif [[ -e "$repo_dir/node_modules" ]]; then
  echo "node_modules already exists; preserving it" >&2
  exit 1
else
  ln -s "$expected_link" "$repo_dir/node_modules"
fi

printf 'node_modules -> %s\n' "$expected_link"
