# Premiere Pro

Edit projects and timelines through a UXP-first bridge, with CEP as an explicit compatibility fallback.

[Back to README](../README.md) · [Architecture & security](architecture-and-security.md) · [MCP protocol](mcp-protocol-2026.md)

## Capability status

| Area | Status | Notes |
|---|---|---|
| Project, sequence, timeline, effects, markers | Public contracts available | Real behavior depends on the connected UXP runtime adapter |
| Split, move, trim, ripple delete | Typed commands available | Capability probe and host verification required |
| Transitions, audio keyframes, captions | Typed commands available | Version-dependent |
| `EditPlan` compilation | Available in `@adobe-mcp/bridge-premiere` | Public R3 approval contract requires repair before production use |
| MOGRT parameter manifests | Roadmap | Insert/inspect first; parameter and media binding after fingerprinting |
| Lumetri recipes | Roadmap | Must map by versioned parameter manifest, never localized labels |

The current UXP panel delegates some mutations to optional runtime hooks. A schema or test double is not proof that a particular Premiere build supports the operation. Unsupported host paths must return `UNSUPPORTED_CAPABILITY`.

## Connect the panel

### UXP — primary path

1. Build the repository and start the daemon.
2. Open Adobe UXP Developer Tool.
3. Add `apps/premiere-uxp/manifest.json`.
4. Select the Premiere Pro instance and load the plugin.
5. Confirm `adobe.system.status` reports a ready `premiere-pro` bridge.

The panel only accepts `ws:`/`wss:` endpoints whose hostname is `127.0.0.1`, `::1`, or `localhost`. It performs the same challenge-HMAC handshake as the other bridges. The UXP transport is always attempted before CEP.

### CEP — compatibility fallback

`apps/premiere-cep` exists for host versions or commands that are not available through UXP. Package/install it according to the local CEP extension policy, open **Window → Extensions → adobe-mcp Premiere Bridge**, and configure the same loopback endpoint and token.

CEP does not accept free-form ExtendScript. The bridge serializes a handler name from a fixed allowlist plus JSON data. It may fall back from UXP only for transport-level failures such as `BRIDGE_UNAVAILABLE`, `APP_NOT_RUNNING`, or `TIMEOUT`; a validation or host error is returned directly.

## Timeline DOM

All time-sensitive baseline commands use either rational ticks/timebase or bounded seconds as defined by the operation schema. Read the sequence first and preserve returned clip and track IDs.

| Command | Intent | Important fields |
|---|---|---|
| `splitClip` | Razor one track at a time | `trackIndex`, `timeSeconds` |
| `moveClip` | Reposition a clip | `clipId`, `targetTrackIndex`, `targetTimeSeconds` |
| `trimClip` | Set both source boundaries | `clipId`, `inPoint`, `outPoint` |
| `rippleDelete` | Remove a range and close the gap | `trackIndex`, `startTime`, `endTime` |
| `applyTransition` | Add a typed video/audio transition | adjacent clip IDs, type, duration |
| `setAudioKeyframes` | Write a gain envelope | track/clip, base gain, bounded keyframes |
| `addCaptionTrack` | Add timestamped subtitles | ordered subtitle intervals |

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "adobe.premiere.timeline.edit",
    "arguments": {
      "target": { "app": "premiere-pro", "projectId": "project-1" },
      "commands": [
        { "op": "splitClip", "trackIndex": 0, "timeSeconds": 12.5 },
        {
          "op": "applyTransition",
          "trackIndex": 0,
          "clipIdA": "clip-a",
          "clipIdB": "clip-b",
          "transitionType": "cross-dissolve",
          "durationSeconds": 0.4
        }
      ],
      "options": {
        "operationId": "1aa05c62-1023-4afe-8f6f-7cf66b987754",
        "expectedRevision": "timeline-rev-27",
        "dryRun": true,
        "atomic": true,
        "conflictPolicy": "fail",
        "verification": "state"
      }
    }
  }
}
```

Commands in a batch must belong to a compatible handler family. Use dry-run or the planning front door first, especially for ripple operations. Locked tracks, stale revisions, missing clip IDs, or unavailable actions must fail without widening the target.

## MOGRTs and Essential Graphics

A MOGRT is not a bag of localized labels. The safe design inserts or inspects a template, then persists a `mogrtInstanceManifest` containing:

- a template fingerprint;
- component match names and stable parameter keys;
- value types, ranges, and keyframe support;
- replaceable media slots;
- the Premiere host and adapter version used to discover them.

The planned flow is:

1. `premiere.mogrt.inspect` fingerprints the template and returns a manifest.
2. `premiere.mogrt.insert` places the template through the sequence editor at a typed time and track.
3. `premiere.mogrt.parameters.set` accepts only manifest keys and matching scalar/color types.
4. Media replacements reference an `ArtifactRef`, never an arbitrary path.
5. The bridge re-reads parameters and captures a preview to detect overflow or unsupported controls.

Unknown controls are reported as `unsupported`; the adapter never writes “parameter 4” and hopes it is the correct field. Parameter injection remains **roadmap** in the public catalog.

## Lumetri color recipes

The planned `premiere.lumetri.applyRecipe` operation compiles a declarative color model against a version-specific `ComponentParam` manifest:

- Basic Correction: temperature, tint, exposure, contrast, whites, and blacks.
- RGB curves: RGB master and individual red, green, and blue points.
- Three-way wheels: shadow, midtone, and highlight angle/magnitude/luminance.
- LUT: artifact reference and bounded intensity.

Before commit, the planner normalizes values, reports fields that cannot be mapped safely, and produces a split-screen or difference preview. Localized display names and hard-coded component indexes are forbidden. If a host version cannot map a curve or wheel deterministically, planning fails with `UNSUPPORTED_CAPABILITY`.

Lumetri-specific typed operations are **roadmap**. The current catalog only offers the generic, allowlisted effects edit surface.

## The `EditPlan` engine

`EditPlan` compiles high-level editorial intent into ordered timeline commands. It does not run speech models or subject tracking implicitly; analysis outputs are explicit input data and can be reviewed before mutation.

### Cut silences

`cutSilences` accepts analyzed time ranges, selected track indexes, and a ripple flag. The compiler sorts and merges overlapping ranges, processes destructive cuts in a safe order, and keeps the plan bounded. The user sees the exact removed intervals before approval.

### Auto-ducking

`autoDucking` accepts voice/music tracks, optional clip IDs, voice intervals, attenuation, attack, release, and threshold. It generates gain keyframes around voice regions instead of destructively rewriting audio. Loudness verification should follow the mutation.

### Vertical auto-reframe

`autoReframe` targets exactly 9:16 in v1. It receives source dimensions and normalized horizontal subject positions over time, then creates position keyframes for the selected clips. A safe-area preview verifies that the subject remains inside the crop.

The domain payload looks like this:

```json
{
  "version": "1",
  "target": { "app": "premiere-pro", "projectId": "project-1" },
  "operations": [
    {
      "op": "cutSilences",
      "ranges": [
        { "startTime": 4.2, "endTime": 5.1 },
        { "startTime": 18.7, "endTime": 20.0 }
      ],
      "trackIndices": [0, 1],
      "ripple": true
    },
    {
      "op": "autoDucking",
      "voiceTrackIndices": [1],
      "musicTrackIndices": [2],
      "voiceRanges": [{ "startTime": 0.8, "endTime": 14.4 }],
      "musicClipIds": ["music-bed"],
      "attenuationDb": -12,
      "attackSeconds": 0.25,
      "releaseSeconds": 0.6,
      "threshold": -24
    },
    {
      "op": "autoReframe",
      "aspectRatio": "9:16",
      "sourceWidth": 3840,
      "sourceHeight": 2160,
      "trackIndex": 0,
      "clipIds": ["clip-a"],
      "horizontalKeyframes": [
        { "time": 0, "position": 0.45 },
        { "time": 10, "position": 0.62 }
      ]
    }
  ],
  "options": {
    "operationId": "d6900b08-508d-4205-8a33-dd014c0ca40a",
    "expectedRevision": "timeline-rev-27",
    "dryRun": true,
    "atomic": true,
    "conflictPolicy": "fail",
    "verification": "render-proof"
  }
}
```

> [!WARNING]
> In `0.1.0`, `adobe.premiere.editPlan.execute` is classified R3, while its input schema cannot carry the stored plan and approval proof required by the gateway for R3. Treat direct MCP execution as blocked until it is migrated to `adobe.operations.plan` → `adobe.operations.execute`. The bridge compiler and schema remain useful for dry-run development and host-adapter tests.

## MOGRT and timeline resource model

The MCP 2026 resource layer will expose the active timeline through `adobe://premiere/active-sequence/timeline`, with canonical templates for project/sequence IDs. Resources return revisions, paginated tracks, clips, transitions, effects, and related artifacts. Use the resource for context; use operations for mutations.

## Verification and failure behavior

- A stale timeline revision returns `CONFLICT`; it is never automatically rebased for destructive edits.
- The UXP adapter captures a snapshot before non-dry-run mutations where the capability exists.
- Postconditions are read independently and attached to the receipt.
- CEP is a declared fallback, not silent permission to use undocumented QE APIs.
- Audio mixer automation, multicamera creation, arbitrary MOGRT media controls, and transcript APIs remain version-gated until host fixtures prove them.
- Cancellation is cooperative; the receipt states if the host crossed a non-cancellable boundary.

See [Architecture & security](architecture-and-security.md) for R3 approvals and [MCP protocol 2026](mcp-protocol-2026.md) for long-running progress.
