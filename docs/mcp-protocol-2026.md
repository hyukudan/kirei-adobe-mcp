# MCP protocol: 2024 compatibility and 2026 native design

`kirei-adobe-mcp` keeps existing STDIO clients working while moving toward the smaller, structured, task-aware MCP 2026 surface.

[Back to README](../README.md) · [Architecture & security](architecture-and-security.md)

## Status at a glance

| Capability | `0.1.0` | Target |
|---|---|---|
| Transport | JSON-RPC 2.0 over STDIO | STDIO compatibility adapter plus native MCP 2026 endpoint |
| Protocol revision | `2024-11-05` | Dual 2024/2026 behavior, never mixed within a request |
| Tools | Full domain catalog from `tools/list` | Stable front door plus paginated operation registry |
| Tool results | JSON serialized in text; image block where applicable | validated `structuredContent`, compatibility text, and output schemas |
| Resources | Eight After Effects preset URIs | dynamic, revisioned project resources and templates |
| Prompts | Not implemented | four initial guided creative workflows |
| Long-running work | internal jobs | negotiated tasks; jobs fallback; protocol-appropriate progress |

> [!NOTE]
> “MCP 1.0 / 2026” is the project migration label. The implemented gateway currently negotiates revision `2024-11-05`; the audited target revision is `2026-07-28`. Documentation separates current behavior from target behavior deliberately.

## Dual-protocol boundary

### STDIO 2024 compatibility

Existing clients start `apps/gateway/dist/index.js` and exchange one JSON-RPC message per line. They use the classic lifecycle:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"example","version":"1"}}}
```

The gateway answers with `2024-11-05`, then accepts `notifications/initialized`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`. The adapter preserves text content for client compatibility and may add an image block for preview/verification results.

### MCP 2026 native endpoint

The target endpoint follows 2026 request semantics: request-scoped metadata/capabilities, structured output, cursor/TTL-aware discovery, input-required results, and negotiated task behavior. It does not emulate the legacy initialize session internally. A compatibility adapter translates legacy requests into the canonical operation service; the service itself remains protocol-neutral.

The two endpoints share schemas, policy, operation registry, receipts, jobs, and artifacts. They do not share lifecycle assumptions or pretend that legacy progress notifications and task subscriptions are the same mechanism.

## The progressive front door

The target `tools/list` is stable for a given server profile and publishes no more than 13–14 front-door tools. Application operations live in a signed internal registry.

### `adobe.tools.discover`

Search by text, app, group, maximum risk, required capability state, and connected host. Results are summaries with an operation name, version, risk, state, requirements, schema URIs, and estimated context cost. The list is deterministic, paginated, and carries `ttlMs` plus `cacheScope`.

```json
{
  "query": "remove silence and duck music",
  "apps": ["premiere"],
  "maxRisk": "R3",
  "requireStates": ["host_verified"],
  "limit": 10
}
```

### `adobe.tools.describe`

Fetch complete JSON Schema 2020-12 documents, examples, limitations, risk, and host requirements for only the chosen operations. A request can describe up to 20 operations so clients can assemble workflows without loading the entire creative suite.

### `adobe.operations.plan`

Resolve an operation against a revision-bound target, validate its specific schema, calculate scope and cost, select a snapshot strategy, and produce:

- an immutable plan handle and SHA-256 `planHash`;
- normalized diff and preview artifacts;
- risk and required approvals;
- expected revisions, estimated duration/bytes/credits, and expiry.

### `adobe.operations.execute`

Execute the stored plan only if the handle, expected hash, target revision, idempotency key, and approval proof still match. It returns a completed receipt, an accepted job/task, or an input-required envelope. Arbitrary `operationName + args` is never dispatched without registry lookup and schema revalidation.

The gateway implements the handle-based contract with immutable `PlanHandle` records containing command digests, snapshot references, previews, expected revisions, expiry and approval-bound hashes. `adobe.tools.discover` and `adobe.tools.describe` expose the internal registry without expanding the public tool list.

## Prompts

Prompts are user-selected recipes. They guide discovery, planning, preview, and approval; they do not bypass policy or execute hidden mutations.

### `reframe-tiktok`

Arguments: sequence reference, output duration, caption style, and optional subject constraints.

Flow: read timeline → analyze subject trajectory → plan 9:16 crop → generate captions → preview safe areas → approve → execute/export.

### `podcast-cleanup`

Arguments: sequence, language, silence thresholds, target loudness, and caption style.

Flow: transcript/audio analysis → review silence intervals → plan ripple cuts → auto-duck music → verify LUFS/true peak → approve export.

### `motion-graphic-bumper`

Arguments: composition, brand-kit artifact, copy, duration, and delivery format.

Flow: create shape/text rig → add text animators and controls → preview → human design checkpoint → render or publish a MOGRT.

### `brand-vectorize`

Arguments: raster artifact, trace preset, color-space/palette policy, and output formats.

Flow: trace preview → path cleanup → global swatches → symbols/styles → approve expansion → multi-artboard export.

Target prompt discovery:

```json
{"jsonrpc":"2.0","id":40,"method":"prompts/list","params":{"cursor":null}}
```

Target prompt retrieval:

```json
{
  "jsonrpc": "2.0",
  "id": 41,
  "method": "prompts/get",
  "params": {
    "name": "podcast-cleanup",
    "arguments": {
      "sequence": "adobe://premiere/active-sequence/timeline",
      "language": "en-US",
      "silencePolicy": "conservative",
      "loudnessTarget": "-16 LUFS"
    }
  }
}
```

Prompts are available through `prompts/list` and `prompts/get` for the four shipped recipes. They remain guidance-only: prompt expansion never bypasses discovery, plan compilation, approval or host capability checks.

## Dynamic MCP resources

Resources are read-only views of current creative state. Every dynamic response carries a revision, ETag, generation time, schema version, partial flag, and cursor when more data exists.

Initial convenience URIs:

| URI | Content |
|---|---|
| `adobe://photoshop/active-doc/layers` | active document metadata and paginated layer tree |
| `adobe://premiere/active-sequence/timeline` | tracks, clips, transitions, effects, and time range |
| `adobe://aftereffects/active-comp/layers` | comp metadata and lazy property tree |
| `adobe://illustrator/active-doc/artboards` | artboards, items, bounds, and color-space summary |

Canonical resource templates avoid relying on focus:

```text
adobe://photoshop/documents/{docId}/layers{?depth,cursor}
adobe://premiere/sequences/{sequenceId}/tracks{?range,detail,cursor}
adobe://aftereffects/projects/{projectId}/comps/{compId}/layers{?depth,cursor}
adobe://illustrator/documents/{docId}/artboards{?cursor}
adobe://artifacts/sha256/{digest}
adobe://jobs/{jobId}
adobe://operations/{receiptId}
```

“Active” URIs are ergonomic aliases resolved to a stable ID and revision in the response. Mutations always use explicit target refs from that response. Large binaries are returned as resource links or artifact references, not embedded in project JSON.

The only resources currently implemented are `adobe://aftereffects/presets/<presetId>`. Dynamic resources, templates, subscriptions, and active aliases are target functionality.

## Long-running work and progress

Rendering, transcription, bulk export, and cross-app workflows outlive a normal tool call. The durable state machine is:

```text
queued → planning → awaiting_input → running → verifying
                                      │            │
                                      ▼            ▼
                                 cancelling   compensating
                                      │            │
                                      └──────┬─────┘
                                             ▼
                      completed | failed | cancelled | partially_compensated
```

### Legacy progress

For compatible pre-2026 clients, a request carries `_meta.progressToken`. The server emits `notifications/progress` with monotonically increasing progress and bounded messages.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/progress",
  "params": {
    "progressToken": "render-7",
    "progress": 48,
    "total": 120,
    "message": "Rendering frames 481–490"
  }
}
```

### MCP 2026 tasks

When the client negotiates the task extension, execution returns a task handle and publishes task-native status/events. The server persists events before delivery so a client can resume after the last observed sequence. Legacy `notifications/progress` is not emitted inside a task subscription as if the two were equivalent.

### Jobs fallback

If tasks are unavailable, `adobe.jobs.get`/`adobe.jobs.cancel` and `adobe://jobs/{jobId}` provide polling and cooperative cancellation. The response suggests `nextPollAfterMs` to avoid busy loops.

Normalized progress events include job ID, event sequence, phase (`plan`, `snapshot`, `execute`, `render`, `verify`, `compensate`, `finalize`), current/total/unit, a safe message, optional ETA, timestamp, and optional artifact reference.

## Structured results and errors

The 2026 endpoint validates each result against the operation output schema and returns `structuredContent`. Compatibility text contains the same JSON for older clients. Binary previews use image blocks or resource links.

Stable domain errors include `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `BRIDGE_UNAVAILABLE`, `UNSUPPORTED_CAPABILITY`, `CONFLICT`, `LOCKED`, `TIMEOUT`, `PARTIAL_FAILURE`, `EXPORT_FAILED`, `VERIFICATION_FAILED`, and `SNAPSHOT_FAILED`. Internal stacks, tokens, local paths, and creative content are never returned.

## Conformance checklist

- Keep `stdout` reserved for protocol frames; send diagnostics to `stderr`.
- Publish deterministic list ordering, cursors, TTL, and cache scope.
- Validate both input and output and reject unknown keys.
- Keep the front-door list stable; operation discovery is data, not hidden tool-list mutation.
- Use input-required/MRTR only on the endpoint that supports it; use a cryptographic local proof in the legacy adapter.
- Persist progress before publication and make sequences resumable.
- Advertise an operation as `host_verified` only with versioned host evidence.

The complete target contracts are defined in the [master blueprint](../ULTIMATE_ADOBE_MCP_BLUEPRINT.md).
