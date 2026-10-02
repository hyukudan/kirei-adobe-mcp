# Illustrator

Build and export vector artwork through typed geometry operations, explicit color models, and host-verified adapters.

[Back to README](../README.md) · [Architecture & security](architecture-and-security.md) · [MCP protocol](mcp-protocol-2026.md)

## Capability status

| Area | Status | Notes |
|---|---|---|
| Document/artboard/item inspection | Available contract | Host certification still required |
| Primitive paths and typography | Available contract/builders | JSX compatibility adapter is the conservative path |
| Compound paths and Pathfinder booleans | Available contract; semantics need host proof | Never substitute grouping for boolean geometry |
| Multi-artboard SVG/PNG export | Available pipeline | Output bytes and dimensions must be verified |
| Image Trace, global swatches, Adobe Color | Roadmap | Cloud trace is opt-in only |
| Variable OpenType axes/features | Roadmap/capability-gated | Font and host support vary |

The included `apps/illustrator-uxp` panel declares Illustrator host `ILST`, but the project has not yet established an official, host-verified UXP support baseline. Treat that panel as experimental. The hardened, versioned JSX handler library is the compatibility route until capability evidence says otherwise.

## Connect Illustrator

### JSX compatibility adapter

Building `@adobe-mcp/bridge-illustrator` copies the versioned handlers and their manifest to `packages/bridge-illustrator/dist/jsx/`. Install or invoke the adapter through an approved local Illustrator scripting/CEP integration that:

- verifies the handler bundle hash;
- selects a handler from the allowlist;
- passes JSON data, never interpolated source code;
- preserves and restores the user's selection;
- returns structured errors and a new document revision.

### Experimental UXP panel

For a host build known to support the manifest:

1. Start the daemon.
2. Add `apps/illustrator-uxp/manifest.json` in Adobe UXP Developer Tool.
3. Load the plugin into Illustrator 28+.
4. Confirm `adobe.system.status` and required capabilities before any write.

Failure to load or `require("illustrator")` being unavailable means the UXP capability is unavailable; do not bypass that result with unverified APIs.

## Vector primitives

The vector layer accepts explicit points in document coordinates and a closed/open flag. Compound and boolean operations consume stable item IDs returned by inspection.

```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "method": "tools/call",
  "params": {
    "name": "adobe.illustrator.objects.edit",
    "arguments": {
      "target": { "app": "illustrator", "documentId": "document-8" },
      "commands": [
        {
          "op": "create-path",
          "tempId": "badge-outline",
          "layerId": "layer-brand",
          "closed": true,
          "points": [[0, 0], [240, 0], [240, 120], [0, 120]],
          "style": { "fill": "brand-blue", "stroke": "none" }
        }
      ],
      "options": {
        "operationId": "03ea8d7c-6f0a-479d-849d-817f8f9bd874",
        "expectedRevision": "ai-rev-12",
        "dryRun": true,
        "atomic": true,
        "conflictPolicy": "fail",
        "verification": "state"
      }
    }
  }
}
```

The internal TypeScript builders make the same intent concise:

```ts
import {
  createPath,
  createCompoundPath,
  booleanPath
} from "@adobe-mcp/bridge-illustrator";

const outline = createPath([[0, 0], [240, 0], [240, 120], [0, 120]], true);
const compound = createCompoundPath(["outer-path", "inner-path"]);
const mark = booleanPath("union", ["shape-a", "shape-b"]);
```

## Compound paths and Pathfinder

These operations have distinct semantics:

- **Compound path** combines subpaths under an even-odd/nonzero fill rule and preserves holes.
- **Union** creates the geometric union of selected closed paths.
- **Intersection** retains only overlapping geometry.
- **Exclude** removes overlap according to Pathfinder exclusion semantics.

The adapter must perform the native command, expand the result where the contract promises expanded geometry, and verify the output by path count, bounds, area/winding, and a raster preview. Grouping selected items is not a valid fallback. If the host cannot execute the requested boolean deterministically, return `UNSUPPORTED_CAPABILITY`.

## Image Trace / Live Trace

The planned `illustrator.trace.image` operation supports `photoHigh`, `photoLow`, `blackWhiteLogo`, `lineArt`, and `custom` presets. Custom controls include color count, threshold, path fidelity, corners, noise, ignore-white, and whether to expand the trace.

The local flow is:

1. Resolve one placed/raster item and capture its document revision.
2. Apply a named host preset or validated custom parameters.
3. Generate a preview before expansion.
4. Require an R3 approval before expanding or replacing source geometry.
5. Verify bounds, path count, palette, and source linkage.

Adobe's cloud Image Trace can be added as a separate adapter. It requires explicit network consent, OAuth scopes, data-residency disclosure, cost ceilings, and an asset-upload policy. It must never be a silent fallback from local tracing.

Image Trace is **roadmap** in the current public catalog.

## Color palettes and global swatches

Color values are always tagged with a color space. Planned swatch operations support RGB, CMYK, and Lab plus a `global` flag. Import/export accepts an artifact-backed palette and an explicit conflict policy: `rename`, `replace`, or `skip`.

```json
{
  "operation": "illustrator.swatch.upsert",
  "args": {
    "name": "Kirei Blue",
    "color": { "space": "cmyk", "c": 82, "m": 48, "y": 0, "k": 6 },
    "global": true
  }
}
```

An Adobe Color integration should import a versioned palette artifact rather than relying on a mutable remote URL. The receipt records the source fingerprint and document color space. Gamut conversion must be explicit and previewable.

These palette operations are **roadmap**; the example shows the target operation-registry shape rather than a current top-level MCP tool.

## Variable OpenType typography

The baseline text command supports content, family, size, kerning, tracking, and alignment. The planned variable-font layer adds four-character OpenType axis tags and a fixed feature allowlist such as `liga`, `dlig`, `smcp`, `onum`, `tnum`, `frac`, and `swsh`.

Before applying axes, the adapter reads the actual font instance, clamps values to the font's advertised range, and reports missing axes or features. A missing variable font is a capability error, not permission to substitute another font silently. Outlining text is R3 because it discards editability and requires a snapshot plus explicit approval.

## Multi-artboard export with real downscaling

`adobe.illustrator.exportArtboards` exports selected artboards to SVG or PNG and returns a per-artboard manifest. `calculateDownscaledDimensions()` preserves aspect ratio and constrains the largest side to `maxDimension`; the host exports at the resolved dimensions rather than only changing metadata.

```json
{
  "jsonrpc": "2.0",
  "id": 31,
  "method": "tools/call",
  "params": {
    "name": "adobe.illustrator.exportArtboards",
    "arguments": {
      "target": { "app": "illustrator", "documentId": "document-8" },
      "artboardIds": ["artboard-square", "artboard-story"],
      "format": "png",
      "destination": {
        "grantId": "grant-brand-output",
        "access": "write",
        "suggestedName": "social-kit"
      },
      "scale": 2,
      "maxDimension": 2160,
      "mutation": {
        "operationId": "58a46aac-c3d6-4b63-ab8c-b843d962be02",
        "expectedRevision": "ai-rev-12",
        "dryRun": false,
        "atomic": true,
        "conflictPolicy": "fail",
        "verification": "render-proof"
      }
    }
  }
}
```

For each output the pipeline records final width/height, byte length, media type, SHA-256, and an immutable artifact reference. SVG outputs are parsed and PNG dimensions decoded before success. Host selection and active artboard are restored after the batch.

## Production checklist

- Prefer stable UUIDs or non-invasive persistent markers; do not expose array indexes as identity.
- Restore selection, active artboard, and coordinate-system state after every operation.
- Verify boolean geometry; never represent a group as a compound/pathfinder result.
- Keep cloud trace opt-in and visible in the approval envelope.
- Treat font substitution and text outlining as explicit user decisions.
- Validate actual raster dimensions and vector syntax before storing export artifacts.
- Keep UXP labeled experimental until a reproducible host matrix proves it.

See [Architecture & security](architecture-and-security.md) for grants, artifacts, and approval binding.
