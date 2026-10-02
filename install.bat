@echo off
chcp 65001 >nul
title 🌸 Kirei Adobe MCP — 1-Click Installer

echo ===============================================================
echo   🌸 Kirei Adobe MCP — Unified Installer for Adobe CC
echo ===============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js no está instalado o no se encuentra en el PATH.
    echo Por favor descarga e instala Node.js 20 o superior desde:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [1/3] Configurando clientes MCP (Claude Desktop, Cursor, Antigravity)...
node bin\cli.mjs setup

echo.
echo [2/3] Instalando extensiones Adobe CC y configurando PlayerDebugMode...
node bin\cli.mjs install-plugins

echo.
echo [3/3] Ejecutando verificación y diagnóstico general...
node bin\cli.mjs doctor

echo ===============================================================
echo   ✔ ¡Instalación y configuración completadas con éxito!
echo.
echo   Ya puedes abrir tu cliente MCP (Claude Desktop, Cursor, etc.)
echo   y tus aplicaciones Adobe (Photoshop, Premiere, AE, Illustrator).
echo ===============================================================
echo.
pause
