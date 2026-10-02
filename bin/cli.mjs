#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { localTokenPath, loadOrCreateLocalToken } from "@adobe-mcp/protocol";
import { startGateway } from "../apps/gateway/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const args = process.argv.slice(2);
const command = args[0] || "stdio";

function log(msg = "") {
  console.log(msg);
}

function success(msg) {
  console.log(`\x1b[32m✔\x1b[0m ${msg}`);
}

function info(msg) {
  console.log(`\x1b[36mℹ\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
}

function getAppPaths() {
  const isWin = platform() === "win32";
  const isMac = platform() === "darwin";
  const results = {
    photoshop: [],
    premiere: [],
    afterEffects: [],
    illustrator: [],
    cepExtensionDir: isWin
      ? join(process.env.APPDATA || "", "Adobe", "CEP", "extensions")
      : join(homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions"),
    claudeConfig: isWin
      ? join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
      : join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    cursorConfig: join(process.cwd(), ".cursor", "mcp.json"),
    antigravityConfig: join(homedir(), ".gemini", "antigravity-cli", "mcp.json"),
    windsurfConfig: join(homedir(), ".codeium", "windsurf", "mcp_config.json")
  };

  if (isWin) {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const adobeDir = join(programFiles, "Adobe");
    if (existsSync(adobeDir)) {
      try {
        const entries = readdirSync(adobeDir);
        for (const entry of entries) {
          const lower = entry.toLowerCase();
          const full = join(adobeDir, entry);
          if (lower.includes("photoshop")) results.photoshop.push(full);
          else if (lower.includes("premiere pro")) results.premiere.push(full);
          else if (lower.includes("after effects")) results.afterEffects.push(full);
          else if (lower.includes("illustrator")) results.illustrator.push(full);
        }
      } catch {}
    }
  } else if (isMac) {
    const appsDir = "/Applications";
    if (existsSync(appsDir)) {
      try {
        const entries = readdirSync(appsDir);
        for (const entry of entries) {
          const lower = entry.toLowerCase();
          const full = join(appsDir, entry);
          if (lower.includes("photoshop")) results.photoshop.push(full);
          else if (lower.includes("premiere pro")) results.premiere.push(full);
          else if (lower.includes("after effects")) results.afterEffects.push(full);
          else if (lower.includes("illustrator")) results.illustrator.push(full);
        }
      } catch {}
    }
  }

  return results;
}

function printBanner() {
  log("\x1b[35m╔═══════════════════════════════════════════════════════════════╗\x1b[0m");
  log("\x1b[35m║\x1b[0m   \x1b[1;36m🌸 kirei-adobe-mcp\x1b[0m — Unified Adobe Creative Cloud MCP Server \x1b[35m║\x1b[0m");
  log("\x1b[35m╚═══════════════════════════════════════════════════════════════╝\x1b[0m\n");
}

async function runDoctor() {
  printBanner();
  info("Ejecutando diagnóstico del sistema (kirei doctor)...\n");

  // 1. Node.js version
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1).split(".")[0], 10);
  if (major >= 20) {
    success(`Node.js runtime: ${nodeVer} (Compatible)`);
  } else {
    warn(`Node.js runtime: ${nodeVer} (Se recomienda Node 20+)`);
  }

  // 2. Token & Security
  try {
    const token = loadOrCreateLocalToken();
    const tokenFile = localTokenPath();
    success(`Auth Token (HMAC-SHA256): ${tokenFile} (Activo, ${token.length} chars)`);
  } catch (err) {
    error(`Error cargando Auth Token: ${err.message}`);
  }

  // 3. Port check
  const port = process.env.ADOBE_MCP_DAEMON_PORT || "49152";
  info(`Daemon Loopback Port: 127.0.0.1:${port}`);

  // 4. Adobe CC Applications
  const apps = getAppPaths();
  log("\n\x1b[1mAplicaciones Adobe detectadas:\x1b[0m");
  if (apps.photoshop.length > 0) success(`Photoshop: ${apps.photoshop.join(", ")}`);
  else warn("Photoshop: No detectado en rutas estándar");

  if (apps.premiere.length > 0) success(`Premiere Pro: ${apps.premiere.join(", ")}`);
  else warn("Premiere Pro: No detectado en rutas estándar");

  if (apps.afterEffects.length > 0) success(`After Effects: ${apps.afterEffects.join(", ")}`);
  else warn("After Effects: No detectado en rutas estándar");

  if (apps.illustrator.length > 0) success(`Illustrator: ${apps.illustrator.join(", ")}`);
  else warn("Illustrator: No detectado en rutas estándar");

  // 5. CEP Extension Folder & Debug Mode
  log("\n\x1b[1mEntorno de Extensiones (CEP & UXP):\x1b[0m");
  if (existsSync(apps.cepExtensionDir)) {
    success(`Directorio CEP: ${apps.cepExtensionDir}`);
  } else {
    info(`Directorio CEP no existe aún (se creará al instalar plugins): ${apps.cepExtensionDir}`);
  }

  if (platform() === "win32") {
    try {
      const regOut = execSync('reg query "HKCU\\Software\\Adobe\\CSXS.11" /v PlayerDebugMode', { stdio: ["pipe", "pipe", "ignore"] }).toString();
      if (regOut.includes("0x1") || regOut.includes("1")) {
        success("CSXS PlayerDebugMode: Habilitado (1)");
      } else {
        warn("CSXS PlayerDebugMode: Deshabilitado. Ejecuta `kirei-adobe-mcp install-plugins` para habilitarlo.");
      }
    } catch {
      warn("CSXS PlayerDebugMode: No configurado. Ejecuta `kirei-adobe-mcp install-plugins` para configurarlo automáticamente.");
    }
  }

  log("\n\x1b[32mDiagnóstico completado con éxito.\x1b[0m\n");
}

function getMcpConfigJson() {
  return {
    mcpServers: {
      "kirei-adobe": {
        command: "npx",
        args: ["-y", "kirei-adobe-mcp"]
      }
    }
  };
}

async function runSetup() {
  printBanner();
  info("Configuración guiada para Clientes MCP (Claude Desktop, Cursor, Antigravity, Cline, Windsurf)\n");

  const snippet = JSON.stringify(getMcpConfigJson(), null, 2);
  log("\x1b[1mSnippet de configuración MCP para copiar y pegar:\x1b[0m");
  log(`\x1b[33m${snippet}\x1b[0m\n`);

  const apps = getAppPaths();
  let configuredCount = 0;

  // Claude Desktop
  const claudeDir = dirname(apps.claudeConfig);
  if (existsSync(claudeDir)) {
    try {
      let config = {};
      if (existsSync(apps.claudeConfig)) {
        config = JSON.parse(readFileSync(apps.claudeConfig, "utf-8"));
      }
      config.mcpServers = config.mcpServers || {};
      config.mcpServers["kirei-adobe"] = getMcpConfigJson().mcpServers["kirei-adobe"];
      writeFileSync(apps.claudeConfig, JSON.stringify(config, null, 2), "utf-8");
      success(`Configurado automáticamente en Claude Desktop: ${apps.claudeConfig}`);
      configuredCount++;
    } catch (e) {
      warn(`No se pudo escribir en Claude Desktop config: ${e.message}`);
    }
  }

  // Cursor in cwd
  const cursorDir = join(process.cwd(), ".cursor");
  try {
    if (!existsSync(cursorDir)) mkdirSync(cursorDir, { recursive: true });
    let config = {};
    if (existsSync(apps.cursorConfig)) {
      config = JSON.parse(readFileSync(apps.cursorConfig, "utf-8"));
    }
    config.mcpServers = config.mcpServers || {};
    config.mcpServers["kirei-adobe"] = getMcpConfigJson().mcpServers["kirei-adobe"];
    writeFileSync(apps.cursorConfig, JSON.stringify(config, null, 2), "utf-8");
    success(`Configurado en workspace de Cursor: ${apps.cursorConfig}`);
    configuredCount++;
  } catch {}

  info(`\n${configuredCount > 0 ? "Archivos de configuración actualizados." : "Copia el snippet superior en tu cliente MCP favorito."}\n`);
}

async function runInstallPlugins() {
  printBanner();
  info("Instalando extensiones y scripts en directorios de Adobe Creative Cloud...\n");

  const apps = getAppPaths();

  // 1. CEP Extension for Premiere
  const cepDest = join(apps.cepExtensionDir, "kirei-premiere-cep");
  const cepSrc = join(ROOT_DIR, "apps", "premiere-cep");
  if (existsSync(cepSrc)) {
    try {
      if (!existsSync(apps.cepExtensionDir)) mkdirSync(apps.cepExtensionDir, { recursive: true });
      cpSync(cepSrc, cepDest, { recursive: true });
      success(`Extensión Premiere CEP instalada en: ${cepDest}`);
    } catch (e) {
      warn(`No se pudo copiar extensión CEP: ${e.message}`);
    }
  }

  // 2. CSXS PlayerDebugMode
  if (platform() === "win32") {
    try {
      execSync('reg add "HKCU\\Software\\Adobe\\CSXS.10" /v PlayerDebugMode /t REG_SZ /d 1 /f', { stdio: "ignore" });
      execSync('reg add "HKCU\\Software\\Adobe\\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f', { stdio: "ignore" });
      execSync('reg add "HKCU\\Software\\Adobe\\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f', { stdio: "ignore" });
      success("Habilitado PlayerDebugMode (CSXS 10, 11, 12) en el Registro de Windows.");
    } catch (e) {
      warn(`No se pudo establecer PlayerDebugMode: ${e.message}`);
    }
  } else if (platform() === "darwin") {
    try {
      execSync("defaults write com.adobe.CSXS.10 PlayerDebugMode 1", { stdio: "ignore" });
      execSync("defaults write com.adobe.CSXS.11 PlayerDebugMode 1", { stdio: "ignore" });
      execSync("defaults write com.adobe.CSXS.12 PlayerDebugMode 1", { stdio: "ignore" });
      success("Habilitado PlayerDebugMode (CSXS 10, 11, 12) en macOS defaults.");
    } catch (e) {
      warn(`No se pudo establecer PlayerDebugMode: ${e.message}`);
    }
  }

  // 3. After Effects ScriptUI panel
  const aeScriptSrc = join(ROOT_DIR, "apps", "aftereffects-panel", "src", "AfterEffectsBridge.jsx");
  if (existsSync(aeScriptSrc)) {
    for (const aePath of apps.afterEffects) {
      const scriptUiDir = join(aePath, "Support Files", "Scripts", "ScriptUI Panels");
      const altScriptUiDir = join(aePath, "Scripts", "ScriptUI Panels");
      const targetDir = existsSync(scriptUiDir) ? scriptUiDir : existsSync(altScriptUiDir) ? altScriptUiDir : null;
      if (targetDir) {
        try {
          copyFileSync(aeScriptSrc, join(targetDir, "AfterEffectsBridge.jsx"));
          success(`ScriptUI de After Effects copiado en: ${join(targetDir, "AfterEffectsBridge.jsx")}`);
        } catch {}
      }
    }
  }

  // 4. Illustrator Script
  const aiScriptSrc = join(ROOT_DIR, "packages", "bridge-illustrator", "src", "jsx", "illustrator-bridge-1.0.0.jsx");
  if (existsSync(aiScriptSrc)) {
    for (const aiPath of apps.illustrator) {
      const scriptDir = join(aiPath, "Presets.localized", "es_ES", "Scripts");
      const altScriptDir = join(aiPath, "Presets", "en_US", "Scripts");
      const targetDir = existsSync(scriptDir) ? scriptDir : existsSync(altScriptDir) ? altScriptDir : null;
      if (targetDir) {
        try {
          copyFileSync(aiScriptSrc, join(targetDir, "illustrator-bridge-1.0.0.jsx"));
          success(`Script JSX de Illustrator copiado en: ${join(targetDir, "illustrator-bridge-1.0.0.jsx")}`);
        } catch {}
      }
    }
  }

  log("\n\x1b[32mInstalación de plugins completada.\x1b[0m\n");
}

function printHelp() {
  printBanner();
  log(`Uso:
  npx kirei-adobe-mcp [comando]

Comandos disponibles:
  stdio (por defecto)   Inicia el servidor MCP por STDIO (con auto-spawn del daemon si es necesario).
  doctor                Verifica el estado del sistema, aplicaciones Adobe y puertos.
  setup                 Genera e inyecta la configuración MCP en Claude Desktop, Cursor, etc.
  install-plugins       Instala extensiones CEP/JSX y configura PlayerDebugMode.
  help, --help, -h      Muestra esta ayuda.
`);
}

async function main() {
  switch (command) {
    case "doctor":
      await runDoctor();
      break;
    case "setup":
      await runSetup();
      break;
    case "install-plugins":
      await runInstallPlugins();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "stdio":
    case "start":
    default:
      await startGateway();
      break;
  }
}

main().catch((err) => {
  error(`Error fatal: ${err.message}`);
  process.exit(1);
});
