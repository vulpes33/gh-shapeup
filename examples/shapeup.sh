#!/usr/bin/env sh
# Run the github-shapeup CLI in Docker with the caller's gh login.
# The token is passed through the environment, never on the command line.
set -eu

version=v1.0.0

root=$(git rev-parse --show-toplevel)
cd "$root"
host=$(pwd -W 2>/dev/null || pwd)

GH_TOKEN=$(gh auth token)
SHAPEUP_REPOSITORY=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
export GH_TOKEN SHAPEUP_REPOSITORY

MSYS_NO_PATHCONV=1 exec docker run --rm -i -e GH_TOKEN -e SHAPEUP_REPOSITORY \
  -v "$host:/workspace:ro" -w /workspace -v github-shapeup-npm:/root/.npm \
  node:24-bookworm-slim \
  npx --yes "https://codeload.github.com/vulpes33/github-shapeup/tar.gz/$version" "$@"
