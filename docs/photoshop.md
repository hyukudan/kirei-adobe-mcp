# Photoshop

Automate Photoshop through a typed UXP bridge without exposing raw `batchPlay` or arbitrary scripts to the MCP client.

[Back to README](../README.md) · [Architecture & security](architecture-and-security.md) · [MCP protocol](mcp-protocol-2026.md)

## Capability status

| Area | Status | Public path |
|---|---|---|
| Document and layer inspection | Available | `adobe.photoshop.inspect`, `adobe.photoshop.document` |
| Layer create/set/transform/delete and text | Available | `adobe.photoshop.layers.edit`, `adobe.photoshop.layers.content` |
| Masks, adjustment layers, Smart Objects | Builder available; host capability required | typed builders in `@adobe-mcp/bridge-photoshop` |
| Neural and Camera Raw filters | Capability-gated, R3 | `adobe.photoshop.filters.apply` |
| Layer and document export | Available contract; host output must be verified | `adobe.photoshop.exportLayers`, `adobe.photoshop.export` |
| Select Subject, Color Range, layer styles, channels | Roadmap | operation registry v2 |

“Available” means code is reachable in the repository. It does not imply certification against every Photoshop release. A client should read `adobe.system.status` and `adobe.system.capabilities` before planning a mutation.

## Install the UXP panel

1. Build the monorepo with `pnpm build` and start the daemon with `node apps/daemon/dist/index.js`.
2. Open **Adobe UXP Developer Tool**.
3. Select **Add Plugin** and choose `apps/photoshop-uxp/manifest.json`.
4. Select the Photoshop instance, click **Load**, and keep the panel open.
5. Ask the MCP client to call `adobe.system.status`. The Photoshop bridge should be `ready` and advertise at least `state.read@1`.

The manifest permits WebSocket traffic only to `ws://127.0.0.1:*`. Authentication material is never placed in the URL. The panel answers the daemon challenge with HMAC-SHA-256 and announces its host version, instance ID, capabilities, and frame limits.

If the bridge is missing, check that the daemon is on the configured `ADOBE_MCP_DAEMON_PORT` (49152 by default), the panel and gateway use the same local token, and Photoshop is a supported target in UXP Developer Tool.

## Inspect before editing

Inspection returns opaque document and layer IDs plus a revision. Reuse those IDs; do not identify layers by localized name or index. Pass the revision back as `expectedRevision` so a user edit made between planning and execution becomes `CONFLICT` instead of being overwritten.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "adobe.photoshop.inspect",
    "arguments": {
      "target": { "app": "photoshop" },
      "depth": 2,
      "page": { "limit": 100 }
    }
  }
}
```

The result is an MCP text block containing the validated JSON envelope. Preview calls may additionally return an MCP image block.

## Tool families

### Inspection

`adobe.photoshop.inspect` and `adobe.photoshop.document` expose document dimensions, resolution, color mode, bit depth, active layer IDs, a bounded layer tree, and pagination state. The intended v2 registry extends this with selection state, channels, histograms, artboards, Smart Object metadata, and stable resource URIs such as `adobe://photoshop/active-doc/layers`.

### Selection with AI

The registry design treats intelligent selection as typed operations rather than user-supplied descriptors:

- `photoshop.selection.selectSubject`: replace/add/subtract/intersect modes, optional hair refinement, and an explicit cloud-processing flag.
- `photoshop.selection.colorRange`: Lab target color, fuzziness from 0–200, and localized-cluster control.
- `photoshop.selection.object`: bounded region and rectangle/lasso/automatic modes.

These operations are **roadmap** until their descriptor builders and host fixtures are merged. When available, they must run in a modal scope, probe host support, and return `UNSUPPORTED_CAPABILITY` rather than silently switching algorithms.

### Layer styles

The planned `photoshop.layerStyle.patch` operation supports typed patches for drop shadow, stroke, bevel, and inner/outer glow. Style patches are R2 because they alter existing content. A patch must preserve unmentioned style fields, generate a preflight diff, and remain reversible through Photoshop history or a tested snapshot.

### Adjustment layers

The bridge already includes builders for Curves, Levels, Hue/Saturation, Color Balance, and Brightness/Contrast. They validate the adjustment kind and parameter object before producing an internal descriptor. Adjustment layers remain non-destructive to pixels, but they are still document mutations and require revision checks.

```ts
import {
  createCurvesAdjustment,
  createHueSaturationAdjustment,
  buildBatchPlay
} from "@adobe-mcp/bridge-photoshop";

const commands = buildBatchPlay([
  createCurvesAdjustment({ presetKind: "custom", points: [[0, 0], [128, 142], [255, 255]] }),
  createHueSaturationAdjustment({ saturation: -8, lightness: 2 })
]);
```

This TypeScript API is internal bridge code. MCP callers use public tools and never submit the generated descriptors.

### Smart Objects

Typed builders cover creating a placed layer, replacing a linked Smart Object from an authorized artifact, and opening an embedded object for host-side editing. External media must arrive through a file grant or `ArtifactRef`; a raw filesystem path is not accepted at the MCP boundary.

### Camera Raw

`applyCameraRaw(parameters)` creates an allowlisted `cameraRawFilter` descriptor after schema validation. The safe contract is intentionally narrower than raw Action Manager JSON:

- only registered parameter keys are accepted for a certified host version;
- the active target and expected revision are fixed during planning;
- mutation occurs inside `executeAsModal`;
- unsupported parameters fail closed;
- the receipt records host and adapter evidence.

The current builder accepts a bounded parameter record, so deployments should keep the operation capability-gated until the version-specific key allowlist and real-host fixtures are present.

## Typed `batchPlay` and modal execution

Photoshop operations use the DOM where it is sufficient. Action Manager is reserved for missing DOM capabilities. The trust boundary is:

```text
MCP args → strict operation schema → typed builder → fixed descriptor
         → executeAsModal → batchPlay → independent state verification
```

Builders fix dialog and execution behavior and constrain actions to `create`, `apply`, `set`, or `delete`. The UXP panel owns `executeAsModal`; callers cannot choose an arbitrary `_obj`, target another document after planning, or request free-form code execution.

## Export layers to immutable artifacts

`adobe.photoshop.exportLayers` selects layers or groups, requests real encoded bytes from the host, writes every output to `ArtifactStore`, and returns a manifest with SHA-256 provenance. The canonical URI is:

```text
artifact://sha256-<64 lowercase hexadecimal characters>
```

The pipeline is designed as:

1. Resolve the document and revision.
2. Isolate each selected layer/group without damaging the source.
3. Export PNG or PSD bytes at the requested scale.
4. Validate that each output is decodable and matches expected dimensions.
5. Store bytes immutably; identical bytes deduplicate naturally.
6. Emit a manifest containing layer ID, safe filename, bounds, byte length, digest, and provenance.
7. Restore temporary visibility/selection state and verify the source revision.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "adobe.photoshop.exportLayers",
    "arguments": {
      "target": { "app": "photoshop", "documentId": "doc-42" },
      "layerIds": ["layer-7", "layer-9"],
      "format": "png",
      "destination": {
        "grantId": "grant-output",
        "access": "write",
        "suggestedName": "campaign-layers"
      },
      "scale": 1,
      "includeHidden": false,
      "mutation": {
        "operationId": "54c9e940-7ca3-4dc5-9796-9cb3926dbed0",
        "expectedRevision": "rev-18",
        "dryRun": false,
        "atomic": true,
        "conflictPolicy": "fail",
        "verification": "render-proof"
      }
    }
  }
}
```

The repository has the artifact-backed result path, but production certification still requires verifying the real UXP export bytes and cleanup behavior for every supported Photoshop version.

## Example: safe layer update

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "adobe.photoshop.layers.edit",
    "arguments": {
      "target": { "app": "photoshop", "documentId": "doc-42" },
      "commands": [
        {
          "op": "set",
          "layerId": "layer-7",
          "patch": { "opacity": 0.85, "visible": true }
        }
      ],
      "options": {
        "operationId": "3a176c54-bb21-457d-b503-d93763caad38",
        "expectedRevision": "rev-18",
        "dryRun": true,
        "atomic": true,
        "conflictPolicy": "fail",
        "verification": "state"
      }
    }
  }
}
```

Use dry-run or `adobe.operations.plan` first, inspect the diff, then execute with the same immutable scope. A changed revision requires a new plan.

## Operational checklist

- Keep document, layer, channel, and selection identifiers opaque and revision-bound.
- Never expose raw `batchPlay`, JSX, `eval`, or plugin-local filesystem paths.
- Use DOM APIs first; keep versioned descriptor fixtures for Action Manager operations.
- Treat cloud/generative features as R3 with explicit egress, account, credit, and region disclosure.
- Verify exported bytes, not merely the existence of a temporary file.
- Do not describe metadata-only JSON as a restorable snapshot.

See [Architecture & security](architecture-and-security.md) for approvals and receipts, and [the master blueprint](../ULTIMATE_ADOBE_MCP_BLUEPRINT.md) for the certification backlog.
