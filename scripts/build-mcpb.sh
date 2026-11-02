#!/bin/sh
# Builds dist/sidenote.mcpb, the Claude Desktop extension (drag it into Settings → Extensions).
set -e
cd "$(dirname "$0")/.."
rm -rf dist/mcpb && mkdir -p dist/mcpb
cp -R server src package.json LICENSE README.md dist/mcpb/
cp mcpb/manifest.json dist/mcpb/manifest.json
cp assets/icon.png dist/mcpb/icon.png
npx -y @anthropic-ai/mcpb@2 validate dist/mcpb/manifest.json
npx -y @anthropic-ai/mcpb@2 pack dist/mcpb dist/sidenote.mcpb
