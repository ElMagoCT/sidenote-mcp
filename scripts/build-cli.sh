#!/bin/sh
# Bundles the CLI (server/cli.js and src/) into one file, dist/sidenote.mjs, which the
# website serves at /sidenote.mjs so people and agents can run it without installing.
set -e
cd "$(dirname "$0")/.."
npx -y esbuild@0.25.12 server/cli.js --bundle --platform=node --format=esm --target=node20 \
  --legal-comments=none --log-level=warning --outfile=dist/sidenote.mjs
echo "built dist/sidenote.mjs ($(wc -c < dist/sidenote.mjs | tr -d ' ') bytes)"
