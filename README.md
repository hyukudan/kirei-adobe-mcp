# kirei-adobe-mcp — Unified Adobe MCP Suite

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20Strict-blue.svg)](https://www.typescriptlang.org/)
[![Turborepo](https://img.shields.io/badge/Turborepo-Monorepo-EF4444.svg)](https://turbo.build/)
[![MCP Specification](https://img.shields.io/badge/MCP-1.0.0-green.svg)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Security: R0--R4](https://img.shields.io/badge/Security-R0--R4%20Risk%20Model-purple.svg)](#security--risk-model)

An enterprise-grade, high-security **Model Context Protocol (MCP)** server monorepo providing unified, autonomous, and interactive AI agent control over the **Adobe Creative Cloud Suite** (**Photoshop**, **Illustrator**, **After Effects**, and **Premiere Pro**).

Designed from first principles to replace ad-hoc, brittle scripts with a strictly-typed, cryptographically-authenticated local bridge architecture.

---

## 📑 Table of Contents

- [Architectural Overview](#-architectural-overview)
- [Key Capabilities](#-key-capabilities)
- [Security & Risk Model (R0–R4)](#-security--risk-model-r0r4)
- [Repository Structure](#-repository-structure)
- [Tool Catalog (36+ MCP Tools)](#-tool-catalog-36-mcp-tools)
- [Installation & Quick Start](#-installation--quick-start)
- [Adobe Host Plugin Setup](#-adobe-host-plugin-setup)
- [Configuring MCP Clients](#-configuring-mcp-clients)
- [Cross-App Sagas & Workflows](#-cross-app-sagas--workflows)
- [Multi-Model Collaborative Engineering](#-multi-model-collaborative-engineering)
- [Testing & Quality Verification](#-testing--quality-verification)
- [Contributing & License](#-contributing--license)

---

## 🏗 Architectural Overview

```text
┌────────────────────────────────────────────────────────┐
│                   AI / MCP Client                      │
│       (Claude Desktop, Antigravity, Codex, etc.)       │
└──────────────────────────┬─────────────────────────────┘
                           │ STDIO (JSON-RPC 2.0 / MCP)
                           ▼
┌────────────────────────────────────────────────────────┐
│                   MCP Gateway Server                   │
│            (@adobe-mcp/gateway - Node.js)             │
│  - MCP protocol serialization (Image + Text blocks)    │
│  - Tool catalog dispatch, policy enforcement & audit   │
│  - Clean error isolation (zero stack traces to client) │
└──────────────────────────┬─────────────────────────────┘
                           │ Local IPC / Challenge-HMAC Authenticated
                           ▼
┌────────────────────────────────────────────────────────┐
│                  Local Bridge Daemon                   │
│             (@adobe-mcp/daemon - Node.js)              │
│  - Loopback-bound WebSocket (127.0.0.1 / ::1)          │
│  - Session lifecycle, instance registry & locks        │
│  - Operation idempotency store (UUID deduplication)    │
│  - Content-addressed artifact store (SHA-256)          │
└────┬─────────────────┬──────────────────┬────────────┬─┘
     │ UXP / WS        │ UXP / WS         │ TCP Line   │ UXP / CEP
     ▼                 ▼                  ▼            ▼
┌──────────┐     ┌─────────────┐    ┌───────────┐ ┌──────────────┐
│Photoshop │     │ Illustrator │    │AfterEffect│ │ Premiere Pro │
│   UXP    │     │     UXP     │    │ExtendScrpt│ │  UXP / CEP   │
└──────────┘     └─────────────┘    └───────────┘ └──────────────┘
```

### Core Architecture Principles:
1. **Single STDIO Gateway**: Only one clean MCP process communicates with the AI agent over stdio. Adobe native binaries or heavy SDKs are never loaded in the Gateway.
2. **Local Loopback Security**: The Bridge Daemon listens strictly on `127.0.0.1` and authenticates every connection via `HMAC-SHA-256(token, clientNonce || serverNonce || sessionId)`.
3. **Plan ➔ Snapshot ➔ Execute ➔ Verify**: Every destructive mutation is bounded by pre-execution snapshots and post-execution visual/structural validation with automated rollback capabilities.
4. **Content-Addressed Handoff**: Inter-application assets (renders, slices, project files) are stored and referenced using immutable SHA-256 URIs (`artifact://sha256-...`).

---

## ⚡ Key Capabilities

### 👁 Universal Vision & Visual Verification
- **`adobe.preview.capture`**: Instant frame/document captures across all 4 hosts with Base64 PNG encoding and real proportional downscaling (`maxDimension`).
- **`adobe.verify.visual`**: In-engine RGBA Manhattan distance pixel comparator (`node:zlib` IDAT scanline inflation) returning normalized difference scores ($[0.0, 1.0]$) and automated tolerance verification.

### 🎬 Premiere Pro: Timeline DOM & Declarative `EditPlan`
- **Native Timeline DOM**: Full programmatic control to split clips (`splitClip`), move/trim clips (`moveClip`, `trimClip`), perform ripple deletes (`rippleDelete`), add video/audio transitions, set audio gain keyframes, and inject caption subtitle tracks (`addCaptionTrack`).
- **Declarative `EditPlan` Engine (`adobe.premiere.editPlan.execute`)**:
  - `cutSilences`: Automated speech detection and batch ripple-delete of dead air.
  - `autoDucking`: Dynamic gain attenuation of background music tracks during dialogue intervals.
  - `autoReframe`: Smart 9:16 vertical re-framing trajectories for TikTok/Reels/Shorts.

### 🎨 Photoshop: Type-Safe `batchPlay` & Layer Pipeline
- **Type-Safe `batchPlay` Action Descriptors**: Declarative builder API for layer masks, non-destructive adjustment layers (Curves, Levels, Hue/Saturation, Exposure, Color Balance), Smart Object replacement, and Neural/Camera Raw filters.
- **Layer Asset Pipeline (`adobe.photoshop.exportLayers`)**: Structured export of layers and groups with SHA-256 provenance hashes and metadata manifests.

### ⚡ After Effects: Presets Catalog & Headless `aerender` Farm
- **Declarative Presets as MCP Resources**: Standard Adobe MatchNames exposed via `resources/list` and `resources/read` (Curves, Fast Blur, Color Balance, 3D Camera Orbital rigs, procedural wiggles, motion blur, and null tracking).
- **Headless `aerender` Engine (`adobe.aftereffects.render`)**: Safe project cloning, frame-range chunking for multi-process local render farming, progress trapping, and SHA-256 output verification.

### 📐 Illustrator: Vector Engine & Artboard Pipeline
- **Vector Primitives**: Compound paths, Pathfinder boolean operations (unite, intersect, exclude), typography controls (fonts, tracking, kerning, line height).
- **Multi-Artboard Export**: High-fidelity SVG/PNG export with true byte downscaling and SHA-256 provenance.

### 🔄 Cross-App Sagas & Artifact Store
- **Content-Addressed Storage (`@adobe-mcp/artifact-store`)**: Immutable storage with hash verification and URI resolution.
- **Cross-App Sagas (`@adobe-mcp/workflow-engine`)**: Multi-step workflows (e.g. *PS Layer Export ➔ AI Vector Composition ➔ AE Motion Graphics ➔ Premiere Timeline Assembly*) with reverse compensation on failure.

---

## 🛡 Security & Risk Model (R0–R4)

All tools in the catalog are classified by deterministic risk levels:

| Level | Risk Class | Behavior & Approval Policy | Example Tools |
|:---:|:---|:---|:---|
| **R0** | **Read-Only / Inspect** | Zero side effects. Automatically allowed. | `adobe.system.status`, `adobe.preview.capture`, `adobe.photoshop.document.read` |
| **R1** | **Non-Destructive Write** | Creates new layers, sets keyframes, adds markers. Safe execution. | `adobe.premiere.marker.add`, `adobe.aftereffects.preset.apply` |
| **R2** | **Destructive In-Document** | Modifies or deletes existing layers/clips. Generates pre-execution snapshot. | `adobe.premiere.timeline.split`, `adobe.photoshop.layer.delete` |
| **R3** | **Filesystem Export** | Writes files, exports slices or renders to disk. Confined to workspace paths. | `adobe.photoshop.exportLayers`, `adobe.illustrator.exportArtboards` |
| **R4** | **System Process / CLI** | Spawns background CLI workers (e.g. `aerender`). Strict argument sanitation. | `adobe.aftereffects.render` |

---

## 📂 Repository Structure

```text
adobe-mcp/
├── apps/
│   ├── gateway/              # MCP STDIO Server (entry point for AI agents)
│   ├── daemon/               # Local Bridge Daemon (session management & auth)
│   ├── photoshop-uxp/        # Photoshop UXP panel plugin
│   ├── illustrator-uxp/      # Illustrator UXP panel plugin
│   ├── premiere-uxp/         # Premiere Pro UXP panel plugin
│   ├── premiere-cep/         # Premiere Pro CEP fallback extension
│   └── aftereffects-panel/   # After Effects ExtendScript / ScriptUI bridge
├── packages/
│   ├── artifact-store/       # Immutable content-addressed SHA-256 storage
│   ├── presets/              # Shared LUTs, animation recipes & typography templates
│   ├── bridge-core/          # Common transport, auth proof & pixel comparator
│   ├── bridge-photoshop/     # Photoshop domain bridge & batchPlay builders
│   ├── bridge-illustrator/   # Illustrator domain bridge & vector engine
│   ├── bridge-aftereffects/  # After Effects domain bridge & aerender worker
│   ├── bridge-premiere/      # Premiere Pro domain bridge & EditPlan engine
│   ├── protocol/             # JSON-RPC 2.0 frames & handshake schemas
│   ├── schemas/              # Zod schemas (Draft 2020-12 deterministic export)
│   ├── tool-catalog/         # 36+ MCP domain tools catalog with R0-R4 metadata
│   ├── workflow-engine/      # Cross-app DAG & Saga orchestration with compensation
│   ├── policy/               # Path sanitation & token authorization policy
│   ├── observability/        # Structured logging & audit trails
│   ├── config/               # Shared TypeScript and runtime configuration
│   └── testkit/              # Test suite mocks and synthetic PNG encoders
├── turbo.json                # Turborepo task pipeline
└── package.json              # Monorepo root workspace
```

---

## 🛠 Tool Catalog (36+ MCP Tools)

The catalog exposes granular and high-level tools categorized by domain:

### System & Lifecycle
- `adobe.system.status` (R0): Inspect daemon health, connected sessions, host versions, and capabilities.
- `adobe.preview.capture` (R0): Universal visual capture with downscaling.
- `adobe.verify.visual` (R0): In-memory RGBA Manhattan distance pixel diffing.
- `adobe.operations.undo` (R2): Compensate or rollback the last operation.

### Premiere Pro
- `adobe.premiere.timeline.inspect` (R0): Read full sequence tracks, clips, and markers.
- `adobe.premiere.timeline.split` (R2): Split clip at target timestamp.
- `adobe.premiere.timeline.trim` (R2): Adjust in/out points of a clip.
- `adobe.premiere.timeline.move` (R2): Move clip between tracks/times.
- `adobe.premiere.timeline.rippleDelete` (R2): Delete clip or interval and close gap.
- `adobe.premiere.transition.apply` (R2): Add cross dissolve or audio transitions.
- `adobe.premiere.audio.setKeyframes` (R1): Set volume and gain ramps.
- `adobe.premiere.caption.add` (R1): Add subtitle caption track with timestamps.
- `adobe.premiere.editPlan.execute` (R2): Execute batch silence cuts, ducking, or 9:16 auto-reframe.

### Photoshop
- `adobe.photoshop.document.read` (R0): Inspect layer tree, blend modes, bounds, and resolution.
- `adobe.photoshop.layer.create` (R1): Create new layer or group.
- `adobe.photoshop.layer.mask` (R2): Create, invert, or feather layer masks.
- `adobe.photoshop.layer.adjust` (R1): Add Curves, Levels, Hue/Saturation adjustment layers.
- `adobe.photoshop.smartObject.replace` (R2): Replace linked or embedded smart object source.
- `adobe.photoshop.exportLayers` (R3): Batch export layers/groups with SHA-256 hashes.

### After Effects
- `adobe.aftereffects.project.inspect` (R0): List comps, layers, effects, and frame rates.
- `adobe.aftereffects.preset.apply` (R1): Apply animation recipes or standard MatchName effects.
- `adobe.aftereffects.render` (R4): Execute local headless `aerender` batch with frame chunking.

### Illustrator
- `adobe.illustrator.document.inspect` (R0): Read vector hierarchy, paths, and artboards.
- `adobe.illustrator.path.create` (R1): Create shapes, bezier paths, and compound paths.
- `adobe.illustrator.pathfinder.apply` (R2): Perform boolean union, subtraction, or intersection.
- `adobe.illustrator.typography.create` (R1): Insert text frames with typography attributes.
- `adobe.illustrator.exportArtboards` (R3): Export artboards to SVG/PNG with downscaling.

---

## 🚀 Installation & Quick Start

### Prerequisites
- **Node.js**: `v20.x` or later
- **pnpm**: `v9.x` or later
- **Adobe Creative Cloud 2024–2026** (Photoshop, Illustrator, After Effects, Premiere Pro)

### 1. Build the Monorepo
```bash
git clone https://github.com/hyukudan/kirei-adobe-mcp.git
cd kirei-adobe-mcp

# Install dependencies
pnpm install

# Build all packages and apps
pnpm build

# Run complete test and typecheck suite
pnpm turbo run test typecheck --force
```

---

## 🔌 Adobe Host Plugin Setup

### Photoshop, Illustrator & Premiere Pro (UXP)
1. Open **Adobe UXP Developer Tool** (included in Creative Cloud).
2. Click **Add Plugin** and select the respective directory:
   - `apps/photoshop-uxp/manifest.json`
   - `apps/illustrator-uxp/manifest.json`
   - `apps/premiere-uxp/manifest.json`
3. Click **Load** to run the plugin in your active Adobe CC application.

### After Effects (ScriptUI / ExtendScript)
Copy [`apps/aftereffects-panel/src/AfterEffectsBridge.jsx`](apps/aftereffects-panel/src/AfterEffectsBridge.jsx) to your After Effects Scripts directory:
- **Windows**: `C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\Scripts\ScriptUI Panels\`
- **macOS**: `/Applications/Adobe After Effects 2026/Scripts/ScriptUI Panels/`
- Open After Effects and launch **AfterEffectsBridge.jsx** from the **Window** menu.

---

## ⚙️ Configuring MCP Clients

Add `adobe-mcp` to your MCP client configuration file:

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "adobe": {
      "command": "node",
      "args": ["<PATH_TO_REPO>/adobe-mcp/apps/gateway/dist/index.js"],
      "env": {}
    }
  }
}
```

### Antigravity / Gemini CLI (`mcp_config.json`)
```json
{
  "mcpServers": {
    "adobe": {
      "command": "node",
      "args": ["D:/mcp/adobe-mcp/apps/gateway/dist/index.js"],
      "env": {}
    }
  }
}
```

---

## 🔄 Cross-App Sagas & Workflows

Execute cross-application production workflows with deterministic compensation:

```typescript
import { executeSaga, createCreativeAssemblySaga } from "@adobe-mcp/workflow-engine";

const saga = createCreativeAssemblySaga({
  photoshop: { documentId: "doc-1", layers: ["Background", "Character"] },
  illustrator: { documentId: "ai-1", artboardIndex: 0 },
  afterEffects: { compName: "MainComp", preset: "orbital-camera-3d" },
  premiere: { sequenceId: "seq-1", editPlan: { autoDucking: true } }
});

const result = await executeSaga(saga, executor, "transaction-uuid-123");
if (result.status === "rolled-back") {
  console.error("Workflow failed, compensated steps:", result.compensations);
}
```

---

## 🧠 Multi-Model Collaborative Engineering

This repository was architected, implemented, mathematically verified, and audited through an advanced **multi-model agentic collaboration workflow**, leveraging the combined reasoning, architectural, and formal verification strengths of frontier AI models from **Google DeepMind**, **Anthropic**, and **OpenAI**, alongside human pair programming:

- **Google DeepMind**: Agentic workflow orchestration, project lifecycle management, and adaptive execution.
- **Anthropic**: Strategic systems architecture, creative domain design, and cross-application saga synthesis.
- **OpenAI**: Formal verification, strict TypeScript typing, deterministic schema validation, zero-tolerance security auditing, and forensic code certification.

This multi-model synergy ensures both cutting-edge creative feature depth and bulletproof, enterprise-grade safety contracts.

---

## 🧪 Testing & Quality Verification

The monorepo enforces 100% strict TypeScript types, schema determinism, unit tests, and contract suites:

```bash
# Run all unit tests across all packages
pnpm test

# Run contract tests for bridge interfaces
pnpm test:contract

# Validate JSON Schema Draft 2020-12 determinism
pnpm schemas:check

# Full CI matrix build & typecheck
pnpm turbo run test typecheck --force
```

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.
