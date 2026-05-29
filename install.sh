#!/bin/bash
set -e

# Install @uluops/agent-metrics from the local source tree:
#   1. Build it
#   2. Install the CLI globally (npm install -g .)
#   3. Refresh the persistent hook copy at ~/.claude/tools/agent-metrics
#
# Usage:
#   ./install.sh             Install / reinstall
#   ./install.sh --unlink    Remove the global CLI and hook copy
#   ./install.sh --help

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_DIR="$HOME/.claude/tools/agent-metrics"

case "$1" in
  --unlink)
    echo "→ Removing global CLI..."
    npm uninstall -g @uluops/agent-metrics 2>/dev/null || true
    echo "→ Removing hook copy at $HOOK_DIR..."
    rm -rf "$HOOK_DIR"
    echo "✓ Removed. (settings.json hook entry left intact — edit manually.)"
    exit 0
    ;;
  --help|-h)
    cat <<'EOF'
Install @uluops/agent-metrics from the local source tree:
  1. Build it
  2. Install the CLI globally (npm install -g .)
  3. Refresh the persistent hook copy at ~/.claude/tools/agent-metrics

Usage:
  ./install.sh             Install / reinstall
  ./install.sh --unlink    Remove the global CLI and hook copy
  ./install.sh --help
EOF
    exit 0
    ;;
esac

cd "$SCRIPT_DIR"

[ ! -f package.json ] && { echo "Error: run from agent-metrics directory."; exit 1; }

echo "→ Installing dependencies..."
npm install --silent

echo "→ Building..."
npm run build

echo "→ Installing global CLI..."
npm install -g . --silent

echo "→ Refreshing hook copy at $HOOK_DIR..."
rm -rf "$HOOK_DIR"
mkdir -p "$HOOK_DIR"
cp -r dist "$HOOK_DIR/"
cp package.json "$HOOK_DIR/"

INSTALLED_VERSION=$(node -p "require('$HOOK_DIR/package.json').version")
GLOBAL_VERSION=$(agent-metrics --version 2>/dev/null || echo "?")

echo ""
echo "✓ Installed @uluops/agent-metrics v$INSTALLED_VERSION"
echo "  Global CLI:   $(which agent-metrics)  (reports v$GLOBAL_VERSION)"
echo "  Hook script:  $HOOK_DIR/dist/hook.js"
echo ""
if [ "$INSTALLED_VERSION" != "$GLOBAL_VERSION" ]; then
  echo "⚠  Global CLI version differs from hook copy. Check 'which -a agent-metrics' for shadowed installs."
fi
