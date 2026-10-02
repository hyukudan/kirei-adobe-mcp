@echo off
chcp 65001 >nul
title 🌸 Kirei Adobe MCP — 1-Click Installer

echo ===============================================================
echo   🌸 Kirei Adobe MCP — Unified Installer for Adobe CC
echo ===============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in system PATH.
    echo Please download and install Node.js 20 or higher from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [1/3] Configuring MCP clients (Claude Desktop, Cursor, Antigravity)...
node bin\cli.mjs setup

echo.
echo [2/3] Installing Adobe CC extensions and enabling PlayerDebugMode...
node bin\cli.mjs install-plugins

echo.
echo [3/3] Running verification and diagnostic health check...
node bin\cli.mjs doctor

echo ===============================================================
echo   ✔ Installation and configuration completed successfully!
echo.
echo   You can now launch your MCP client (Claude Desktop, Cursor, etc.)
echo   and your Adobe apps (Photoshop, Premiere, AE, Illustrator).
echo ===============================================================
echo.
pause
