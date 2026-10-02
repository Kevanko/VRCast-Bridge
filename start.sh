#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 20 или новее." >&2
  exit 1
fi
exec node src/server.js
