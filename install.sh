#!/bin/bash
#
# Install agent-metrics globally
#
# Usage:
#   ./install.sh           # Install from current directory
#   ./install.sh --unlink  # Remove global link
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_TOOLS_DIR="$HOME/.claude/tools/agent-metrics"

case "$1" in
  --unlink)
    echo "Removing global agent-metrics link..."
    npm unlink -g @claude-workflows/agent-metrics 2>/dev/null || true
    echo "✓ Unlinked"
    exit 0
    ;;
  --help|-h)
    echo "Install agent-metrics globally"
    echo ""
    echo "Usage:"
    echo "  ./install.sh           Install from current directory"
    echo "  ./install.sh --unlink  Remove global link"
    echo "  ./install.sh --help    Show this help"
    exit 0
    ;;
esac

echo "Installing agent-metrics..."
echo ""

# Check if we're in the right directory
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  echo "Error: package.json not found. Run this script from the agent-metrics directory."
  exit 1
fi

cd "$SCRIPT_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "→ Installing dependencies..."
  npm install
fi

# Build if needed
if [ ! -d "dist" ]; then
  echo "→ Building..."
  npm run build
fi

# Create global link
echo "→ Creating global link..."
npm link

# Copy to ~/.claude/tools for persistence
echo "→ Copying to ~/.claude/tools..."
mkdir -p "$HOME/.claude/tools"
cp -r "$SCRIPT_DIR" "$CLAUDE_TOOLS_DIR"

echo ""
echo "✓ Installation complete!"
echo ""
echo "The 'agent-metrics' command is now available globally."
echo ""
echo "Quick test:"
echo "  agent-metrics --version"
echo "  agent-metrics list"
echo ""
echo "Installed to:"
echo "  Global:  $(which agent-metrics)"
echo "  Backup:  $CLAUDE_TOOLS_DIR"
