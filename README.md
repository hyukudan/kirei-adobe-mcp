# 🌸 kirei-adobe-mcp

[![TypeScript Strict](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Turborepo](https://img.shields.io/badge/Turborepo-Monorepo-EF4444?logo=turborepo&logoColor=white)](https://turbo.build/repo)
[![MCP 1.0 / 2026](https://img.shields.io/badge/MCP-1.0%20%2F%202026-5A67D8)](docs/mcp-protocol-2026.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-F4C430)](LICENSE)
[![Risk model: R0–R4](https://img.shields.io/badge/Risk%20model-R0%E2%80%93R4-7C3AED)](docs/architecture-and-security.md#risk-model-r0r4)

The definitive, unified, strictly-typed Model Context Protocol (MCP) server for **Adobe Photoshop, Premiere Pro, After Effects, and Illustrator**.

Designed for enterprise AI assistants (**Claude Desktop, Cursor, Antigravity, Cline, Windsurf**), `kirei-adobe-mcp` replaces brittle scripts with 62 deterministic tools, strict Zod contracts, cryptographic risk classification (R0–R4), Content-Addressed Storage (CAS), and visual verification.

---

### 📖 Application Guides & Documentation

| 🎨 [Photoshop Guide](docs/photoshop.md) | 🎬 [Premiere Pro Guide](docs/premiere.md) | ⚡ [After Effects Guide](docs/after-effects.md) | 📐 [Illustrator Guide](docs/illustrator.md) |
|:---:|:---:|:---:|:---:|
| Smart Selection & Layer Styles | Timeline DOM, MOGRT & Lumetri | Shape Animators & Headless Render | Pathfinders & Image Trace |

| 🌐 [MCP Protocol 2026](docs/mcp-protocol-2026.md) | 🛡️ [Architecture & Security](docs/architecture-and-security.md) | 🗺️ [Master Blueprint](ULTIMATE_ADOBE_MCP_BLUEPRINT.md) | 📜 [Technical Specs](SPECS.md) |
|:---:|:---:|:---:|:---:|
| Prompts, Resources & Streaming | R0–R4, HMAC & SQLite WAL | Strategic Roadmap & Gap Audit | Normative Specifications |

---

## ⚡ Quickstart in 60 Seconds (Zero-Config)

You do not need to clone the repository or manually build the project. You can run `kirei-adobe-mcp` directly with `npx`:

### 1. Add to Your Favorite MCP Client

#### 🤖 Claude Desktop
Add this entry to your configuration file (`%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "kirei-adobe": {
      "command": "npx",
      "args": ["-y", "kirei-adobe-mcp"]
    }
  }
}
```

#### 💻 Cursor
Create or edit `.cursor/mcp.json` in your workspace or global Cursor settings:

```json
{
  "mcpServers": {
    "kirei-adobe": {
      "command": "npx",
      "args": ["-y", "kirei-adobe-mcp"]
    }
  }
}
```

#### 🚀 Antigravity / Gemini CLI
Add to `~/.gemini/antigravity-cli/mcp.json`:

```json
{
  "mcpServers": {
    "kirei-adobe": {
      "command": "npx",
      "args": ["-y", "kirei-adobe-mcp"]
    }
  }
}
```

#### 🌊 Windsurf / Cascade
Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "kirei-adobe": {
      "command": "npx",
      "args": ["-y", "kirei-adobe-mcp"]
    }
  }
}
```

#### 🛠️ Cline / Roo Code (VS Code Extension)
Add to your Cline MCP settings:

```json
{
  "mcpServers": {
    "kirei-adobe": {
      "command": "npx",
      "args": ["-y", "kirei-adobe-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

---

## 🧙‍♂️ 1-Click Installation & Diagnostic CLI Wizard

`kirei-adobe-mcp` includes interactive built-in tools for seamless configuration:

```powershell
# 1. Full diagnostic of system environment and detected Adobe CC applications
npx kirei-adobe-mcp doctor

# 2. Automatically configure detected MCP clients (Claude Desktop, Cursor, etc.)
npx kirei-adobe-mcp setup

# 3. Automatically copy extension panels/scripts to official Adobe folders
npx kirei-adobe-mcp install-plugins
```

### Automated 1-Click Launchers

- **Windows (Double-click or PowerShell):**
  ```powershell
  .\install.bat
  # or
  powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1
  ```
- **macOS / Linux (Terminal):**
  ```bash
  bash install.sh
  # or
  bash scripts/setup-macos.sh
  ```

---

## 🏗️ System Architecture

```mermaid
flowchart TD
  Client["MCP Client<br/>Claude · Cursor · Antigravity · Cline · Windsurf"] -->|"STDIO Gateway (JSON-RPC)"| Gateway["Gateway Server (MCP 2026)"]
  Gateway -.->|"Auto-bootstrap if inactive"| Daemon
  Gateway -->|"HMAC-SHA256 Loopback RPC"| Daemon["Loopback Bridge Daemon<br/>127.0.0.1:49152"]
  
  Daemon <--> PS["Photoshop<br/>(UXP Modal Panel)"]
  Daemon <--> PR["Premiere Pro<br/>(UXP / CEP Timeline Bridge)"]
  Daemon <--> AE["After Effects<br/>(ScriptUI / aerender CLI)"]
  Daemon <--> AI["Illustrator<br/>(JSX Engine / Pathfinder)"]
  
  Daemon --> CAS[("Artifact Store (CAS)<br/>artifact://sha256-...")]
  Daemon --> Sagas["Workflow Saga Engine<br/>Compensation & Rollback"]
```

---

## 🎯 The Front-Door Pattern (>80% Token Savings)

Instead of overloading the AI context window by publishing 62 individual tools simultaneously, `kirei-adobe-mcp` implements progressive discovery:

1. `adobe.tools.discover`: Query the internal operation registry by application, category, or risk.
2. `adobe.tools.describe`: Retrieve the exact JSON/Zod schemas only for required operations.
3. `adobe.operations.plan`: Compile and validate an immutable plan with risk estimation and `planHash`.
4. `adobe.operations.execute`: Execute approved operations idempotently with verifiable receipts.

---

## 🎨 Application Coverage

| Application | Core Surface | Advanced Workflows |
|---|---|---|
| **Photoshop** | Layers, selections, masks, adjustments, Smart Objects, cropping | *Select Subject*, *Color Range*, *Layer Styles*, luminosity masks, artifact layer export, Firefly *Generative Fill* (R3). |
| **Premiere Pro** | Timeline insert/cut/trim/slip, tracks, clips, captions | MOGRT template parameter binding with manifests, declarative Lumetri Color grading, proxy management, auto-ducking, and 9:16 auto-reframe. |
| **After Effects** | Compositions, layers, typed keyframes, effect presets | Shape operators (*Trim Paths*, *Repeater*, *Wiggle*), text animators with range selectors, expression controls, and headless `aerender`. |
| **Illustrator** | Paths, vector art, typography, multi-artboard export | Vectorization via *Image Trace*, global swatches & palette management, variable OpenType typography, and boolean *Pathfinder* operations. |

---

## 🛡️ Security & Risk Model (R0–R4)

| Risk Tier | Classification | Approval Requirements | Examples |
|:---:|---|---|---|
| **R0** | Read & Inspection | Automatic / unrestricted | Inspecting layer trees, reading timeline DOM, capturing previews. |
| **R1** | Non-Destructive Mutation | Local validation | Adding empty layers, creating masks, applying keyframes. |
| **R2** | Moderate Mutation | Plan Hash + Snapshot | Modifying existing cuts, reordering layers, applying styles. |
| **R3** | Major / Generative Mutation | Explicit Cryptographic Approval | Firefly Generative Fill, deep timeline restructuring, render queue. |
| **R4** | Destructive / Irreversible | Critical Token Approval | Overwriting source assets, mass asset deletion. |

---

## 🔧 Troubleshooting & FAQ

### ❓ MCP client reports `BRIDGE_UNAVAILABLE: panel disconnected`
* **Resolution:** Open the corresponding Adobe application (Photoshop, Premiere, etc.) and ensure the extension panel or script is loaded and showing green status (**Connected**).

### ❓ Extension signature error in Premiere CEP (`PlayerDebugMode`)
* **Resolution:** Run `npx kirei-adobe-mcp install-plugins` (or `install.bat`) to automatically configure CSXS debug mode in the Windows Registry or macOS defaults.

### ❓ Conflict on port `49152`
* **Resolution:** If another service occupies port 49152, set the environment variable in your MCP client configuration:
  ```json
  "env": {
    "ADOBE_MCP_DAEMON_PORT": "50000"
  }
  ```

---

## 🛠️ Local Development & Contributing

To contribute to the monorepo:

```powershell
git clone https://github.com/hyukudan/kirei-adobe-mcp.git
cd kirei-adobe-mcp
corepack enable
pnpm install
pnpm build
pnpm turbo run test typecheck
```

---

## 🤝 Multi-Model Collaborative Engineering

This project was architected and built through advanced collaborative engineering, leveraging deep reasoning and multimodal capabilities from **Google DeepMind**, **Anthropic**, and **OpenAI**, alongside official **Adobe Creative Cloud** and **Model Context Protocol** specifications.

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.
