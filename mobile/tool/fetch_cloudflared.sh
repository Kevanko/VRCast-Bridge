#!/usr/bin/env bash
# Кладёт cloudflared в приложение как нативную библиотеку: так бесплатная ссылка Cloudflare работает с телефона без ПК.
# Нужно один раз перед сборкой: ./tool/fetch_cloudflared.sh [arm64|all]
#   arm64 — настоящие телефоны (по умолчанию), all — ещё и эмулятор x86_64 (только для отладочной сборки: в релиз не попадает).
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-arm64}"
base="https://github.com/cloudflare/cloudflared/releases/latest/download"
fetch() { # <файл релиза> <папка ABI> <набор исходников>
  local dir="android/app/src/$3/jniLibs/$2"
  mkdir -p "$dir"
  echo "Скачиваю $1 → $dir/libcloudflared.so"
  curl -fL --retry 3 -o "$dir/libcloudflared.so" "$base/$1"
  chmod 755 "$dir/libcloudflared.so"
}
fetch cloudflared-linux-arm64 arm64-v8a main
[ "$target" = all ] && fetch cloudflared-linux-amd64 x86_64 debug
echo "Готово. Собирайте: flutter build apk --release --target-platform android-arm64"
