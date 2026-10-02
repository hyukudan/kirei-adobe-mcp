#!/usr/bin/env bash
set -e

echo "==============================================================="
echo "  🌸 Kirei Adobe MCP — Unified Installer for Adobe CC"
echo "==============================================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed or not in system PATH."
    echo "Please download and install Node.js 20 or higher from: https://nodejs.org/"
    exit 1
fi

echo "[1/3] Configuring MCP clients..."
node bin/cli.mjs setup

echo ""
echo "[2/3] Installing Adobe CC extensions..."
node bin/cli.mjs install-plugins

echo ""
echo "[3/3] Running verification and diagnostic check..."
node bin/cli.mjs doctor

echo "==============================================================="
echo "  ✔ Installation and configuration completed successfully!"
echo "==============================================================="
