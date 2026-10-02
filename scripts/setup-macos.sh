#!/usr/bin/env bash
# 🌸 Kirei Adobe MCP - macOS 1-Click Setup Script
set -e

echo "================================================="
echo "  🌸 Kirei Adobe MCP — macOS Setup Wizard"
echo "================================================="
echo ""

# 1. Check Node.js
echo "[1/4] Verifying Node.js environment..."
node -v || { echo "Node.js not found. Please install Node.js 20+ from https://nodejs.org"; exit 1; }

# 2. Run CLI Setup
echo "[2/4] Configuring MCP clients..."
node bin/cli.mjs setup

# 3. Install Plugins
echo "[3/4] Installing Adobe extensions..."
node bin/cli.mjs install-plugins

# 4. Run Doctor
echo "[4/4] Running system diagnostic..."
node bin/cli.mjs doctor

echo "================================================="
echo "  ✔ Installation completed successfully."
echo "================================================="
