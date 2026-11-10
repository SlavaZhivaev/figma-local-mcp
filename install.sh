#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/figma-local-mcp}"
cd "$SRC"
python3 build_plugin.py --check
PYTHONWARNINGS=ignore FIGMA_AUTO_RAISE=0 python3 -m unittest -q
node --test tests/test_connection.mjs
python3 deploy.py "$DEST"
for root in "$HOME/.codex" "$HOME/.agents"; do
  if [ -d "$root" ]; then
    mkdir -p "$root/skills/figma-local"
    target="$root/skills/figma-local/SKILL.md"
    if [ -f "$target" ]; then cp -p "$target" "$target.pre-merged.bak"; fi
    cp "$DEST/skill/figma-local/SKILL.md" "$target"
  fi
done
printf 'Installed. Restart all MCP clients and the Figma plugin. Manifest: %s/plugin/manifest.json\n' "$DEST"
