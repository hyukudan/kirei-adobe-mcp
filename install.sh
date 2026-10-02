#!/usr/bin/env bash
set -e

echo "==============================================================="
echo "  🌸 Kirei Adobe MCP — Unified Installer for Adobe CC"
echo "==============================================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js no está instalado o no se encuentra en el PATH."
    echo "Por favor descarga e instala Node.js 20 o superior desde: https://nodejs.org/"
    exit 1
fi

echo "[1/3] Configurando clientes MCP..."
node bin/cli.mjs setup

echo ""
echo "[2/3] Instalando extensiones Adobe CC..."
node bin/cli.mjs install-plugins

echo ""
echo "[3/3] Ejecutando verificación..."
node bin/cli.mjs doctor

echo "==============================================================="
echo "  ✔ ¡Instalación y configuración completadas con éxito!"
echo "==============================================================="
