# After Effects

Control compositions through an allowlisted ExtendScript bridge and move long renders into a constrained local `aerender` worker.

[Back to README](../README.md) · [Architecture & security](architecture-and-security.md) · [MCP protocol](mcp-protocol-2026.md)

## Capability status

| Area | Status | Notes |
|---|---|---|
| Project, composition, layer, property inspection | Available in the JSX bridge | Bounded traversal and opaque IDs |
| Layer creation, property writes, keyframes | Available | One undo group per mutation batch |
| Declarative effect/animation presets | Available catalog | Eight versioned preset resources |
| Shape modifiers and advanced text animators | Roadmap | Typed match-name builders required |
| Render Queue and `aerender` worker | Available components | Final chunk assembly still needs production hardening |
| UXP 27 adapter | Roadmap/capability-gated | ExtendScript remains the compatibility path |

## Install the ScriptUI panel

Build the repository, then copy `apps/aftereffects-panel/src/AfterEffectsBridge.jsx` into the After Effects **ScriptUI Panels** directory.

Windows:

```text
C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\ScriptUI Panels\
```

macOS:

```text
/Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/
```

Restart After Effects and open **Window → AfterEffectsBridge**. The host must permit scripts to access the network where required by its preferences.

The bridge exposes `AfterEffectsBridgePanel.connect({ port, token, appVersion, instanceId })` for a loopback TCP connection, plus `poll()` for newline-delimited JSON. A host-provided WebSocket implementation can use `connectWebSocket`. The endpoint must remain local; never expose this transport on a LAN interface.

The installed JSX is a versioned handler library, not an evaluator. Requests select an allowlisted method and provide JSON data. The bridge never interpolates request text into JSX.

## Composition and property model

Inspection returns projects, comps, the render queue, and optionally bounded property trees. Public IDs derive from persistent host IDs where After Effects exposes them; native one-based layer indexes are never public identity.

Mutation batches support:

- creation of solid, text, shape, null, camera, and light layers;
- typed property writes through a bounded property path;
- merge or replace-range keyframes with linear, Bézier, or hold interpolation;
- reversible layer deletion inside an undo group.

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "tools/call",
  "params": {
    "name": "adobe.aftereffects.layers.edit",
    "arguments": {
      "target": {
        "app": "after-effects",
        "projectId": "project-a1",
        "entityId": "comp-42"
      },
      "commands": [
        {
          "op": "create-layer",
          "tempId": "title",
          "kind": "text",
          "name": "Launch title",
          "options": {}
        }
      ],
      "options": {
        "operationId": "c87534b5-ddd8-4b18-80ec-8c30df381a5c",
        "expectedRevision": "ae-1780012345000",
        "dryRun": true,
        "atomic": true,
        "conflictPolicy": "fail",
        "verification": "state"
      }
    }
  }
}
```

## Shape layers

The target shape API operates on match-name property paths, not localized UI labels. The first advanced modifiers are:

| Modifier | Canonical intent | Representative controls |
|---|---|---|
| Trim Paths | reveal or erase a contour | start, end, offset, trim mode |
| Repeater | duplicate and transform vector groups | copies, offset, position, scale, rotation, opacity |
| Pucker & Bloat | contract or inflate a contour | signed amount |

The planned `aftereffects.shape.operator.add` contract identifies the layer, an exact group path, the operator enum, and typed properties. The adapter resolves that enum to a certified Adobe match name and calls `addProperty`. Unsupported property groups fail before mutation. Merge Paths, Offset Paths, Twist, and Wiggle Transform follow the same pattern.

Shape-operator commands are **roadmap** in the public catalog. Until builders and golden comps exist, use the baseline property operations only for paths that have been inspected and capability-checked.

## Advanced text animators

Text animation is modeled as one animator plus an explicit selector:

- **Range selector:** start, end, offset, and basis (`characters`, `words`, or `lines`).
- **Wiggly selector:** min/max amount and frequency.
- **Expression selector:** bounded expression data after security analysis.
- **Per-character 3D:** opt-in on the text layer, with rotation/orientation/position properties scoped to the animator.

Advanced easing should map to selector ease-high/ease-low and amount properties through match names. Expressions are property data, not privileged bridge code, but they still require size limits, denial-of-service checks, and an R2/R3 policy decision.

These typed text operations are **roadmap**. The current bridge can set known property paths and keyframes, but it does not yet publish a text-animator builder.

## Effect presets and animation recipes

The gateway currently publishes eight presets as MCP resources under `adobe://aftereffects/presets/<id>`:

| Preset ID | Match name / recipe | Category |
|---|---|---|
| `effect.fast-blur` | `ADBE Fast Blur` | effect |
| `effect.curves` | `ADBE CurvesCustom` | effect |
| `effect.color-balance` | `ADBE Color Balance` | effect |
| `animation.wiggle` | bounded position expression | animation |
| `animation.inertial-bounce` | inertial bounce recipe | animation |
| `camera.orbital-3d` | 3D orbital rig seed | camera |
| `motion.motion-blur` | layer motion blur | animation |
| `tracking.null-parent` | tracked null parent | tracking |

Read a preset before applying it:

```json
{"jsonrpc":"2.0","id":21,"method":"resources/read","params":{"uri":"adobe://aftereffects/presets/effect.fast-blur"}}
```

Apply it with typed overrides:

```json
{
  "jsonrpc": "2.0",
  "id": 22,
  "method": "tools/call",
  "params": {
    "name": "adobe.aftereffects.preset.apply",
    "arguments": {
      "target": { "app": "after-effects", "entityId": "comp-42" },
      "presetId": "effect.fast-blur",
      "layerId": "layer-7",
      "parameters": { "blur": 18 },
      "mutation": {
        "operationId": "2269046a-3dcb-432a-b2a7-f12fa19fa2db",
        "expectedRevision": "ae-1780012345000",
        "dryRun": false,
        "atomic": true,
        "conflictPolicy": "fail",
        "verification": "state"
      }
    }
  }
}
```

Presets are identified by `presetId@version`. Recipes and match names belong in one canonical registry; duplicating them in the gateway and bridge risks drift and is scheduled for consolidation.

## Headless rendering with `aerender`

`@adobe-mcp/bridge-aftereffects` discovers `aerender` only in official Adobe installation paths. It builds an argv array and spawns with `shell: false`; clients cannot supply an executable path or shell syntax.

Supported arguments include:

```text
-project <copy.aep>
-comp <composition>
-s <startFrame>
-e <endFrame>
-RStemplate <render settings template>
-OMtemplate <output module template>
-output <destination>
```

The worker can clone the project to a temporary directory, divide a frame range into inclusive chunks, parse frame/percentage progress, enforce optional runtime/resource limits, and cancel cooperatively with escalation. Each successful output is hashed with SHA-256 before it becomes an artifact.

### Safe local render-farm design

1. Save or clone the project and hash the input.
2. Compile non-overlapping frame chunks.
3. Render chunks into a frame sequence or independently valid intermediates.
4. Publish normalized progress for each chunk.
5. Verify every expected frame, byte size, and digest.
6. Assemble through a format-aware path, then verify and store the final output.
7. Remove the temporary clone after receipts and hashes are durable.

> [!WARNING]
> The current `renderFarm()` implementation concatenates chunk bytes. That is not valid assembly for most movie containers. Use frame-sequence outputs for development, or treat distributed movie rendering as unavailable until a format-aware assembler (for example an approved FFmpeg worker) and end-to-end media validation are implemented.

The public `adobe.aftereffects.render` tool uses grants rather than raw paths and is classified R3. Long renders should return a job handle and emit progress; see [MCP protocol 2026](mcp-protocol-2026.md#long-running-work-and-progress).

## Snapshot and rollback limits

The JSX bridge currently hashes an inspected metadata snapshot. That proves the inspection payload has integrity; it does **not** make the project restorable. Production R2+ claims require a tested undo token, incremental restore, save-copy, or full package. The receipt must state the actual restore guarantee.

## Production checklist

- Address properties through match names and inspected paths, never localized labels.
- Keep each mutation in a guaranteed `beginUndoGroup`/`endUndoGroup` pair.
- Reject arbitrary expressions or JSX; analyze bounded expression data separately.
- Clone source projects before headless rendering unless the user explicitly approves otherwise.
- Keep `-RStemplate` and `-OMtemplate` values bounded and host-validated.
- Hash and decode outputs before reporting success.
- Do not claim direct Mocha control until a stable, tested public adapter exists.

See [the master blueprint](../ULTIMATE_ADOBE_MCP_BLUEPRINT.md) for the UXP 27 migration and certification plan.
