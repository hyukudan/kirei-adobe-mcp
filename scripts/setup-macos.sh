#!/usr/bin/env bash
# 🌸 Kirei Adobe MCP - macOS 1-Click Setup Script
set -e

echo "================================================="
echo "  🌸 Kirei Adobe MCP — macOS Setup Wizard"
echo "================================================="
echo ""

# 1. Check Node.js
echo "[1/4] Verificando Node.js..."
node -v || { echo "Node.js no encontrado. Instala Node.js 20+ desde https://nodejs.org"; exit 1; }

# 2. Run CLI Setup
echo "[2/4] Configurando clientes MCP..."
node bin/cli.mjs setup

# 3. Install Plugins
echo "[3/4] Instalando extensiones Adobe..."
node bin/cli.mjs install-plugins

# 4. Run Doctor
echo "[4/4] Ejecutando diagnóstico..."
node bin/cli.mjs doctor

echo "================================================="
echo "  ✔ Instalación completada con éxito."
echo "================================================="
