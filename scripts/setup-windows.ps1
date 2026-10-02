# 🌸 Kirei Adobe MCP - Windows 1-Click Setup Script
$ErrorActionPreference = "Stop"

Write-Host "=================================================" -ForegroundColor Magenta
Write-Host "  🌸 Kirei Adobe MCP — Windows Setup Wizard" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Magenta
Write-Host ""

# 1. Check Node.js
Write-Host "[1/4] Verificando Node.js..." -ForegroundColor Yellow
$nodeVer = node -v
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✔ Node.js detectado: $nodeVer" -ForegroundColor Green
} else {
    Write-Host "  ✖ Node.js no encontrado. Por favor instala Node 20+ desde https://nodejs.org" -ForegroundColor Red
    exit 1
}

# 2. Run CLI Setup
Write-Host "[2/4] Configurando clientes MCP (Claude Desktop, Cursor, etc.)..." -ForegroundColor Yellow
node bin/cli.mjs setup

# 3. Install Plugins and enable PlayerDebugMode
Write-Host "[3/4] Instalando extensiones Adobe y habilitando PlayerDebugMode..." -ForegroundColor Yellow
node bin/cli.mjs install-plugins

# 4. Run Doctor
Write-Host "[4/4] Ejecutando chequeo general..." -ForegroundColor Yellow
node bin/cli.mjs doctor

Write-Host "=================================================" -ForegroundColor Magenta
Write-Host "  ✔ Instalación completada con éxito." -ForegroundColor Green
Write-Host "  Ya puedes abrir Photoshop, Premiere, After Effects" -ForegroundColor Cyan
Write-Host "  o Illustrator e interactuar con tu asistente de IA." -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Magenta
