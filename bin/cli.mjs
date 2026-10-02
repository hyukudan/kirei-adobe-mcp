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
  info("Running system diagnostics (kirei doctor)...\n");

  // 1. Node.js version
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1).split(".")[0], 10);
  if (major >= 20) {
    success(`Node.js runtime: ${nodeVer} (Compatible)`);
  } else {
    warn(`Node.js runtime: ${nodeVer} (Node 20+ recommended)`);
  }

  // 2. Token & Security
  try {
    const token = loadOrCreateLocalToken();
    const tokenFile = localTokenPath();
    success(`Auth Token (HMAC-SHA256): ${tokenFile} (Active, ${token.length} chars)`);
  } catch (err) {
    error(`Error loading Auth Token: ${err.message}`);
  }

  // 3. Port check
  const port = process.env.ADOBE_MCP_DAEMON_PORT || "49152";
  info(`Daemon Loopback Port: 127.0.0.1:${port}`);

  // 4. Adobe CC Applications
  const apps = getAppPaths();
  log("\n\x1b[1mDetected Adobe CC Applications:\x1b[0m");
  if (apps.photoshop.length > 0) success(`Photoshop: ${apps.photoshop.join(", ")}`);
  else warn("Photoshop: Not detected in standard directories");

  if (apps.premiere.length > 0) success(`Premiere Pro: ${apps.premiere.join(", ")}`);
  else warn("Premiere Pro: Not detected in standard directories");

  if (apps.afterEffects.length > 0) success(`After Effects: ${apps.afterEffects.join(", ")}`);
  else warn("After Effects: Not detected in standard directories");

  if (apps.illustrator.length > 0) success(`Illustrator: ${apps.illustrator.join(", ")}`);
  else warn("Illustrator: Not detected in standard directories");

  // 5. CEP Extension Folder & Debug Mode
  log("\n\x1b[1mExtension Environment (CEP & UXP):\x1b[0m");
  if (existsSync(apps.cepExtensionDir)) {
    success(`CEP Directory: ${apps.cepExtensionDir}`);
  } else {
    info(`CEP Directory does not exist yet (will be created on plugin install): ${apps.cepExtensionDir}`);
  }

  if (platform() === "win32") {
    try {
      const regOut = execSync('reg query "HKCU\\Software\\Adobe\\CSXS.11" /v PlayerDebugMode', { stdio: ["pipe", "pipe", "ignore"] }).toString();
      if (regOut.includes("0x1") || regOut.includes("1")) {
        success("CSXS PlayerDebugMode: Enabled (1)");
      } else {
        warn("CSXS PlayerDebugMode: Disabled. Run `kirei-adobe-mcp install-plugins` to enable it.");
      }
    } catch {
      warn("CSXS PlayerDebugMode: Not configured. Run `kirei-adobe-mcp install-plugins` to configure it automatically.");
    }
  }

  log("\n\x1b[32mDiagnostics completed successfully.\x1b[0m\n");
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
  info("Guided Setup for MCP Clients (Claude Desktop, Cursor, Antigravity, Cline, Windsurf)\n");

  const snippet = JSON.stringify(getMcpConfigJson(), null, 2);
  log("\x1b[1mMCP Configuration Snippet:\x1b[0m");
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
      success(`Automatically configured Claude Desktop: ${apps.claudeConfig}`);
      configuredCount++;
    } catch (e) {
      warn(`Could not write to Claude Desktop config: ${e.message}`);
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
    success(`Configured Cursor workspace: ${apps.cursorConfig}`);
    configuredCount++;
  } catch {}

  info(`\n${configuredCount > 0 ? "Configuration files updated." : "Copy the snippet above into your preferred MCP client."}\n`);
}

async function runInstallPlugins() {
  printBanner();
  info("Installing extensions and scripts into Adobe Creative Cloud directories...\n");

  const apps = getAppPaths();

  // 1. CEP Extension for Premiere
  const cepDest = join(apps.cepExtensionDir, "kirei-premiere-cep");
  const cepSrc = join(ROOT_DIR, "apps", "premiere-cep");
  if (existsSync(cepSrc)) {
    try {
      if (!existsSync(apps.cepExtensionDir)) mkdirSync(apps.cepExtensionDir, { recursive: true });
      cpSync(cepSrc, cepDest, { recursive: true });
      success(`Premiere CEP extension installed to: ${cepDest}`);
    } catch (e) {
      warn(`Could not copy CEP extension: ${e.message}`);
    }
  }

  // 2. CSXS PlayerDebugMode
  if (platform() === "win32") {
    try {
      execSync('reg add "HKCU\\Software\\Adobe\\CSXS.10" /v PlayerDebugMode /t REG_SZ /d 1 /f', { stdio: "ignore" });
      execSync('reg add "HKCU\\Software\\Adobe\\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f', { stdio: "ignore" });
      execSync('reg add "HKCU\\Software\\Adobe\\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f', { stdio: "ignore" });
      success("Enabled PlayerDebugMode (CSXS 10, 11, 12) in Windows Registry.");
    } catch (e) {
      warn(`Could not set PlayerDebugMode: ${e.message}`);
    }
  } else if (platform() === "darwin") {
    try {
      execSync("defaults write com.adobe.CSXS.10 PlayerDebugMode 1", { stdio: "ignore" });
      execSync("defaults write com.adobe.CSXS.11 PlayerDebugMode 1", { stdio: "ignore" });
      execSync("defaults write com.adobe.CSXS.12 PlayerDebugMode 1", { stdio: "ignore" });
      success("Enabled PlayerDebugMode (CSXS 10, 11, 12) in macOS defaults.");
    } catch (e) {
      warn(`Could not set PlayerDebugMode: ${e.message}`);
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
          success(`After Effects ScriptUI copied to: ${join(targetDir, "AfterEffectsBridge.jsx")}`);
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
          success(`Illustrator JSX script copied to: ${join(targetDir, "illustrator-bridge-1.0.0.jsx")}`);
        } catch {}
      }
    }
  }

  log("\n\x1b[32mPlugin installation completed.\x1b[0m\n");
}

function printHelp() {
  printBanner();
  log(`Usage:
  npx kirei-adobe-mcp [command]

Available Commands:
  stdio (default)       Start the MCP server over STDIO (auto-spawning daemon if needed).
  doctor                Check system status, installed Adobe applications, and ports.
  setup                 Generate and inject MCP configuration into Claude Desktop, Cursor, etc.
  install-plugins       Install CEP/JSX extensions and configure PlayerDebugMode.
  help, --help, -h      Show this help message.
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
      await startGateway();
      break;
    default:
      error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 2;
      break;
  }
}

main().catch((err) => {
  error(`Fatal error: ${err.message}`);
  process.exit(1);
});
