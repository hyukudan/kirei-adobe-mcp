# 🌸 Kirei Adobe MCP - Windows 1-Click Setup Script
$ErrorActionPreference = "Stop"

Write-Host "=================================================" -ForegroundColor Magenta
Write-Host "  🌸 Kirei Adobe MCP — Windows Setup Wizard" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Magenta
Write-Host ""

# 1. Check Node.js
Write-Host "[1/4] Verifying Node.js environment..." -ForegroundColor Yellow
$nodeVer = node -v
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✔ Node.js detected: $nodeVer" -ForegroundColor Green
} else {
    Write-Host "  ✖ Node.js not found. Please install Node 20+ from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# 2. Run CLI Setup
Write-Host "[2/4] Configuring MCP clients (Claude Desktop, Cursor, Antigravity)..." -ForegroundColor Yellow
node bin/cli.mjs setup

# 3. Install Plugins and enable PlayerDebugMode
Write-Host "[3/4] Installing Adobe extensions and configuring PlayerDebugMode..." -ForegroundColor Yellow
node bin/cli.mjs install-plugins

# 4. Run Doctor
Write-Host "[4/4] Running diagnostic health check..." -ForegroundColor Yellow
node bin/cli.mjs doctor

Write-Host "=================================================" -ForegroundColor Magenta
Write-Host "  ✔ Installation completed successfully." -ForegroundColor Green
Write-Host "  You can now open Photoshop, Premiere Pro, After Effects" -ForegroundColor Cyan
Write-Host "  or Illustrator and interact with your AI assistant." -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Magenta
