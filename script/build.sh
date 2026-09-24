#!/usr/bin/env sh
# Compile the CLI into one gh extension binary per platform, named <repository>-<os>-<arch> as gh expects.
set -eu

rm -rf dist
for pair in linux-x64:linux-amd64 linux-arm64:linux-arm64 darwin-x64:darwin-amd64 darwin-arm64:darwin-arm64 \
  windows-x64:windows-amd64.exe windows-arm64:windows-arm64.exe; do
  bun build bin/shapeup.mjs --compile --target "bun-${pair%%:*}" --outfile "dist/gh-shapeup-${pair#*:}"
done
