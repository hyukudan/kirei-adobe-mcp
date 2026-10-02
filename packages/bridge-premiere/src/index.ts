import { createHash, randomBytes } from "node:crypto";
import {
  ArtifactRef,
  MutationOptions,
  OperationReceipt,
  PremiereEffectCommand,
  PremiereMarkerCommand,
  PremiereProjectCommand,
  PremiereSequenceCommand,
  PremiereTimelineCommand,
  Snapshot,
  TargetRef,
  PreviewCaptureData,
  PremiereEditPlan,
  PremiereEditPlanResult,
  z,
} from "@adobe-mcp/schemas";
import type { Job } from "@adobe-mcp/schemas";
import type {
  AdobeBridge,
  BridgeDescriptor,
  BridgeState,
  ExportRequest,
  InspectRequest,
  InspectResult,
  MutationRequest,
  PreviewCaptureRequest,
  VisualVerifyRequest,
  VisualVerifyResult,
} from "@adobe-mcp/bridge-core";
import { BaseMockBridge, compareBase64Images, createMockDescriptor, decodeImageDimensions } from "@adobe-mcp/bridge-core";
import { inputHash } from "@adobe-mcp/bridge-core";
import { expandEditPlan } from "./edit-plan.js";
export { addCaptionTrack, addSequenceMarker, applyTimelineOperation, applyTransition, buildAutoDuckingKeyframes, calculateAutoReframeKeyframes, createEditPlan, detectSilenceRanges, executeEditPlan, expandEditPlan, moveClip, rippleDelete, setAudioKeyframes, splitClip, trimClip } from "./edit-plan.js";
export type { AudioAnalysisSample, EditPlanExecutionResult, PremiereEditPlanTransport, TimeRange, TimelineClip, TimelineState } from "./edit-plan.js";

export type PremiereRpcMethod =
  | "bridge.inspect" | "bridge.mutate" | "bridge.export" | "bridge.preview.capture" | "bridge.snapshot" | "bridge.restoreSnapshot" | "bridge.verify" | "bridge.cancel"
  | "premiere.inspect" | "premiere.project.edit" | "premiere.sequences.edit" | "premiere.timeline.edit"
  | "premiere.effects.edit" | "premiere.markers.edit" | "premiere.editPlan.execute" | "premiere.export";

const allowedMethods = new Set<PremiereRpcMethod>([
  "bridge.inspect", "bridge.mutate", "bridge.export", "bridge.preview.capture", "bridge.snapshot", "bridge.restoreSnapshot", "bridge.verify", "bridge.cancel",
  "premiere.inspect", "premiere.project.edit", "premiere.sequences.edit", "premiere.timeline.edit",
  "premiere.effects.edit", "premiere.markers.edit", "premiere.editPlan.execute", "premiere.export",
]);

const InspectPayload = z.object({ target: TargetRef, fields: z.array(z.string().min(1).max(128)).max(64).optional(), depth: z.number().int().min(0).max(4).optional(), cursor: z.string().max(2048).optional() }).strict();
const MutationPayload = z.object({ target: TargetRef, commands: z.array(z.record(z.string(), z.unknown())).min(1).max(500), options: MutationOptions }).strict();
const SnapshotPayload = z.object({ target: TargetRef }).strict();
const PreviewPayload = z.object({ target: TargetRef, format: z.enum(["png", "jpeg"]), maxDimension: z.number().int().min(64).max(4096), time: z.object({ ticks: z.string().regex(/^-?\d+$/), timebase: z.string().regex(/^[1-9]\d*$/) }).strict().optional() }).strict();
const VerifyPayload = z.object({ target: TargetRef, expectedRevision: z.string().min(1).max(128).optional() }).strict();
const CancelPayload = z.object({ jobId: z.string().min(1).max(256) }).strict();
const ExportPayload = z.object({
  target: TargetRef, sequenceId: z.string().min(1).max(256), engine: z.enum(["premiere", "media-encoder"]),
  range: z.enum(["entire", "in-out", "work-area"]), presetId: z.string().min(1).max(256),
  destination: z.object({ grantId: z.string().min(1).max(256), access: z.enum(["write", "read-write"]), suggestedName: z.string().max(255).optional() }).strict(),
  overwrite: z.boolean().default(false), mutation: MutationOptions,
}).strict();

export interface PremiereTransport {
  readonly kind: "uxp" | "cep";
  readonly isAvailable?: () => boolean | Promise<boolean>;
  request(method: PremiereRpcMethod, payload: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void>;
}

export interface PremiereDispatcher {
  dispatch(method: PremiereRpcMethod, payload: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function errorCode(error: unknown): string { return error instanceof Error ? error.message.split(":", 1)[0] ?? "" : ""; }
function isFallbackError(error: unknown): boolean { return ["BRIDGE_UNAVAILABLE", "APP_NOT_RUNNING", "TIMEOUT", "NETWORK_ERROR"].includes(errorCode(error)); }

function validateCommandForMethod(method: PremiereRpcMethod, command: Record<string, unknown>): Record<string, unknown> {
  if (method === "premiere.timeline.edit") return PremiereTimelineCommand.parse(command) as Record<string, unknown>;
  if (method === "premiere.project.edit") return PremiereProjectCommand.parse(command) as Record<string, unknown>;
  if (method === "premiere.sequences.edit") return PremiereSequenceCommand.parse(command) as Record<string, unknown>;
  if (method === "premiere.markers.edit") return PremiereMarkerCommand.parse(command) as Record<string, unknown>;
  if (method === "premiere.effects.edit") return PremiereEffectCommand.parse(command) as Record<string, unknown>;
  return command;
}

function validatePayload(method: PremiereRpcMethod, payload: Record<string, unknown>): Record<string, unknown> {
  if (!allowedMethods.has(method)) throw new Error("PERMISSION_DENIED: method is not allowlisted");
  if (method === "bridge.inspect" || method === "premiere.inspect") return InspectPayload.parse(payload) as Record<string, unknown>;
  if (method === "bridge.snapshot") return SnapshotPayload.parse(payload) as Record<string, unknown>;
  if (method === "bridge.preview.capture") return PreviewPayload.parse(payload) as Record<string, unknown>;
  if (method === "bridge.restoreSnapshot") return z.object({ target: TargetRef, snapshotId: z.string().min(1).max(256) }).strict().parse(payload) as Record<string, unknown>;
  if (method === "bridge.verify") return VerifyPayload.parse(payload) as Record<string, unknown>;
  if (method === "bridge.cancel") return CancelPayload.parse(payload) as Record<string, unknown>;
  if (method === "bridge.export" || method === "premiere.export") return ExportPayload.parse(payload) as Record<string, unknown>;
  if (method === "bridge.mutate") return MutationPayload.parse(payload) as unknown as Record<string, unknown>;
  if (method === "premiere.editPlan.execute") return PremiereEditPlan.parse(payload) as unknown as Record<string, unknown>;
  if (method.endsWith(".edit")) {
    const parsed = MutationPayload.parse(payload);
    return { ...parsed, commands: parsed.commands.map((command) => validateCommandForMethod(method, command)) };
  }
  return payload;
}

/** Validated UXP-first dispatcher. CEP is only used when UXP is unavailable. */
export class SafePremiereDispatcher implements PremiereDispatcher {
  constructor(private readonly primary: PremiereTransport, private readonly fallback?: PremiereTransport) {}
  async dispatch(method: PremiereRpcMethod, payload: Record<string, unknown>): Promise<unknown> {
    const safePayload = validatePayload(method, payload);
    const transports = [this.primary, this.fallback].filter((transport): transport is PremiereTransport => Boolean(transport));
    let lastError: unknown;
    for (const transport of transports) {
      try {
        if (transport.isAvailable && !(await transport.isAvailable())) continue;
        return await transport.request(method, safePayload);
      } catch (error) {
        lastError = error;
        if (transport === this.primary && isFallbackError(error)) continue;
        throw error;
      }
    }
    throw (lastError instanceof Error ? lastError : new Error("BRIDGE_UNAVAILABLE: no Premiere transport available"));
  }
  async close(): Promise<void> { await Promise.all([this.primary.close?.(), this.fallback?.close?.()]); }
}

function descriptor(transport: BridgeDescriptor["transport"] = "uxp"): BridgeDescriptor {
  return {
    app: "premiere-pro", transport, appVersion: "unknown", instanceId: `premiere-pro-${randomBytes(12).toString("base64url")}`,
    capabilities: [
      "state.read@1", "state.write@1", "project.read@1", "project.write@1", "sequence.read@1", "sequence.write@1",
      "timeline.read@1", "timeline.write@1", "timeline.razor@1", "timeline.slip@1", "timeline.ripple-delete@1",
      "timeline.speed@1", "timeline.mute@1", "markers.read@1", "markers.write@1", "effects.read@1", "effects.write@1",
      "effects.keyframes@1", "export.file@1", "export.premiere@1", "export.media-encoder@1", "snapshot.create@1",
      "verification.timeline@1", "preview.capture@1", "fallback.cep@1", "batch.atomic@1",
      "timeline.transitions@1", "timeline.audio-keyframes@1", "timeline.captions@1", "edit-plan.execute@1", "editPlan.execute@1",
    ],
    limits: { maxInFlightReads: 8, maxInFlightWrites: 1, maxFrameBytes: 8 * 1024 * 1024 },
  };
}

function parseReceipt(value: unknown): OperationReceipt {
  const candidate = value && typeof value === "object" && "receipt" in value ? (value as { receipt: unknown }).receipt : value;
  return z.object({
    status: z.enum(["planned", "applied", "partial", "rolled-back", "queued"]), previousRevision: z.string().min(1).max(128).optional(), revision: z.string().min(1).max(128).optional(),
    appliedIndexes: z.array(z.number().int().nonnegative()).max(500), failedIndexes: z.array(z.number().int().nonnegative()).max(500), tempIdMap: z.record(z.string(), z.string()).default({}), snapshot: Snapshot.optional(),
    verification: z.enum(["skipped", "passed", "failed"]).optional(), compensations: z.array(z.unknown()).max(500).default([]), job: z.unknown().optional(),
  }).strict().parse(candidate) as OperationReceipt;
}

function parseInspect(value: unknown): InspectResult {
  return z.object({ target: TargetRef, revision: z.string().min(1).max(128), data: z.record(z.string(), z.unknown()) }).strict().parse(value) as InspectResult;
}

export function calculatePreviewDimensions(frameSize: { width: number; height: number }, maxDimension: number): { width: number; height: number; scale: number } {
  if (!Number.isFinite(frameSize.width) || !Number.isFinite(frameSize.height) || frameSize.width < 1 || frameSize.height < 1) throw new Error("INVALID_ARGUMENT: invalid Premiere frame dimensions");
  if (!Number.isFinite(maxDimension) || maxDimension < 1) throw new Error("INVALID_ARGUMENT: invalid maxDimension");
  const scale = Math.min(1, maxDimension / Math.max(frameSize.width, frameSize.height));
  return { width: Math.max(1, Math.round(frameSize.width * scale)), height: Math.max(1, Math.round(frameSize.height * scale)), scale };
}

export class PremiereBridge implements AdobeBridge {
  readonly descriptor: BridgeDescriptor;
  private state: BridgeState = "disconnected";
  private revision = "rev-0";
  private readonly receipts = new Map<string, OperationReceipt>();
  private readonly receiptHashes = new Map<string, string>();
  private readonly editPlanResults = new Map<string, import("@adobe-mcp/schemas").PremiereEditPlanResult>();
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly dispatcher: PremiereDispatcher = new SafePremiereDispatcher({ kind: "uxp", request: async () => { throw new Error("BRIDGE_UNAVAILABLE: UXP panel is not connected"); } }), configuredDescriptor?: Partial<BridgeDescriptor>) {
    const base = descriptor(configuredDescriptor?.transport ?? "uxp");
    this.descriptor = { ...base, ...configuredDescriptor, app: "premiere-pro", capabilities: configuredDescriptor?.capabilities ?? base.capabilities, limits: configuredDescriptor?.limits ?? base.limits };
  }

  async connect(): Promise<void> { const health = await this.health(); if (health === "disconnected") { this.state = "degraded"; throw new Error("BRIDGE_UNAVAILABLE: Premiere panel is not connected"); } this.state = "ready"; }
  async health(): Promise<BridgeState> {
    if (this.state === "disconnected") { try { await this.dispatcher.dispatch("bridge.inspect", { target: { app: "premiere-pro", instanceId: this.descriptor.instanceId } }); this.state = "ready"; } catch { return "disconnected"; } }
    return this.state;
  }
  async inspect(request: InspectRequest): Promise<InspectResult> { const result = parseInspect(await this.dispatcher.dispatch("premiere.inspect", request as unknown as Record<string, unknown>)); this.revision = result.revision; return result; }
  async capturePreview(request: PreviewCaptureRequest): Promise<PreviewCaptureData> {
    const parsed = z.object({ imageBase64: z.string().min(1), mimeType: z.enum(["image/png", "image/jpeg"]), width: z.number().int().positive(), height: z.number().int().positive(), revision: z.string().min(1), capturedAt: z.string().datetime() }).strict().parse(await this.dispatcher.dispatch("bridge.preview.capture", request as unknown as Record<string, unknown>)) as PreviewCaptureData;
    const actual = decodeImageDimensions(parsed.imageBase64);
    if (actual.format !== (parsed.mimeType === "image/png" ? "png" : "jpeg") || actual.width !== parsed.width || actual.height !== parsed.height) throw new Error("HOST_ERROR: Premiere preview metadata does not match encoded image dimensions");
    if (Math.max(actual.width, actual.height) > request.maxDimension) throw new Error("HOST_ERROR: Premiere preview exceeds maxDimension");
    return parsed;
  }
  async verifyVisual(request: VisualVerifyRequest): Promise<VisualVerifyResult> { const current = await this.capturePreview({ target: request.target, format: "png", maxDimension: 4096, ...(request.time ? { time: request.time } : {}) }); return compareBase64Images(request.baselineImageBase64, current.imageBase64, request.tolerance); }
  async mutate(request: MutationRequest): Promise<OperationReceipt> {
    const digest = inputHash(request); const cached = this.receipts.get(request.options.operationId); if (cached) { if (this.receiptHashes.get(request.options.operationId) !== digest) throw new Error("CONFLICT: operationId was already used with a different input"); return cached; }
    if (request.options.expectedRevision && request.options.expectedRevision !== this.revision) throw new Error("CONFLICT: expected revision is stale");
    const mutation = MutationPayload.parse(request); const method = methodForCommands(mutation.commands); const snapshot = request.options.dryRun ? undefined : await this.snapshot(request.target);
    const receipt = parseReceipt(await this.dispatcher.dispatch(method, mutation as unknown as Record<string, unknown>)); const result = snapshot && !receipt.snapshot ? { ...receipt, snapshot } as OperationReceipt : receipt;
    if (result.revision) this.revision = result.revision; this.receiptHashes.set(request.options.operationId, digest); this.receipts.set(request.options.operationId, result);
    if (!request.options.dryRun && request.options.verification !== "none") { const verified = await this.verify(request.target, result.revision); if (!verified.ok) throw new Error("VERIFICATION_FAILED: Premiere timeline did not match post-mutation revision"); return { ...result, verification: "passed" }; }
    return result;
  }
  async executeEditPlan(plan: ReturnType<typeof PremiereEditPlan.parse>): Promise<import("@adobe-mcp/schemas").PremiereEditPlanResult> {
    const parsed = PremiereEditPlan.parse(plan);
    const operationId = parsed.options.operationId;
    const digest = inputHash(parsed);
    const cached = this.editPlanResults.get(operationId);
    if (cached) { if (this.receiptHashes.get(operationId) !== digest) throw new Error("CONFLICT: operationId was already used with a different EditPlan"); return cached; }
    if (parsed.options.expectedRevision && parsed.options.expectedRevision !== this.revision) throw new Error("CONFLICT: EditPlan expected revision is stale");
    if (!parsed.options.dryRun) await this.snapshot(parsed.target);
    const value = await this.dispatcher.dispatch("premiere.editPlan.execute", parsed as unknown as Record<string, unknown>);
    const candidate = value && typeof value === "object" && "result" in value ? (value as { result: unknown }).result : value;
    const parsedResult = "appliedOperations" in ((candidate ?? {}) as object)
      ? PremiereEditPlanResult.parse(candidate)
      : (() => { const receipt = parseReceipt(candidate); return PremiereEditPlanResult.parse({ appliedOperations: receipt.appliedIndexes.length, timelineRevision: receipt.revision ?? this.revision, summary: { status: receipt.status, operationCount: expandEditPlan(parsed).length } }); })();
    this.revision = parsedResult.timelineRevision;
    this.receiptHashes.set(operationId, digest); this.editPlanResults.set(operationId, parsedResult);
    if (!parsed.options.dryRun && parsed.options.verification !== "none") { const verified = await this.verify(parsed.target, parsedResult.timelineRevision); if (!verified.ok) throw new Error("VERIFICATION_FAILED: Premiere EditPlan verification failed"); }
    return parsedResult;
  }
  async exportLayers(input: import("@adobe-mcp/schemas").PhotoshopLayerExportSpec): Promise<import("@adobe-mcp/schemas").PhotoshopLayerExportResult> { void input; throw new Error("UNSUPPORTED_CAPABILITY: Premiere bridge cannot export Photoshop layers"); }
  async exportArtboards(input: import("@adobe-mcp/schemas").IllustratorArtboardExport): Promise<import("@adobe-mcp/schemas").IllustratorArtboardExportResult> { void input; throw new Error("UNSUPPORTED_CAPABILITY: Premiere bridge cannot export Illustrator artboards"); }
  async applyPreset(input: import("@adobe-mcp/schemas").AfterEffectsPresetApply): Promise<import("@adobe-mcp/schemas").AfterEffectsPresetApplyResult> { void input; throw new Error("UNSUPPORTED_CAPABILITY: Premiere bridge cannot apply After Effects presets"); }
  async export(request: ExportRequest): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> {
    const payload = ExportPayload.parse(request as unknown as Record<string, unknown>); const value = await this.dispatcher.dispatch("premiere.export", payload as unknown as Record<string, unknown>); const parsed = z.object({ artifact: ArtifactRef, receipt: z.unknown() }).strict().parse(value); return { artifact: parsed.artifact, receipt: parseReceipt(parsed.receipt) };
  }
  async snapshot(target: TargetRef): Promise<Snapshot> { const snapshot = Snapshot.parse(await this.dispatcher.dispatch("bridge.snapshot", { target })); if (!snapshot.verified || snapshot.artifact.sha256 !== snapshot.sha256) throw new Error("SNAPSHOT_FAILED: Premiere snapshot is not content-addressed"); this.snapshots.set(snapshot.id, snapshot); return snapshot; }
  async restoreSnapshot(target: TargetRef, snapshotId: string): Promise<void> { await this.dispatcher.dispatch("bridge.restoreSnapshot", { target, snapshotId }); }
  async verify(target: TargetRef, expectedRevision?: string): Promise<{ ok: boolean; revision: string; details?: Record<string, unknown> }> { const value = z.object({ ok: z.boolean(), revision: z.string().min(1).max(128), details: z.record(z.string(), z.unknown()).optional() }).strict().parse(await this.dispatcher.dispatch("bridge.verify", { target, expectedRevision })); this.revision = value.revision; if (value.details === undefined) return { ok: value.ok, revision: value.revision }; return { ok: value.ok, revision: value.revision, details: value.details }; }
  async cancel(jobId: string): Promise<Job> { return z.object({ id: z.string(), kind: z.string(), status: z.enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]), progress: z.number(), createdAt: z.string(), updatedAt: z.string(), operationId: z.string().uuid().optional(), artifacts: z.array(z.unknown()), error: z.unknown().optional() }).strict().parse(await this.dispatcher.dispatch("bridge.cancel", { jobId })) as Job; }
  async close(): Promise<void> { this.state = "disconnected"; await this.dispatcher.close(); }
}

function methodForCommands(commands: readonly Record<string, unknown>[]): PremiereRpcMethod {
  const op = commands[0]?.op;
  if (["insert", "overwrite", "move", "trim", "cut", "delete", "slip", "ripple-delete", "speed", "mute", "splitClip", "moveClip", "trimClip", "rippleDelete", "applyTransition", "setAudioKeyframes", "addSequenceMarker", "addCaptionTrack"].includes(String(op)) && !("projectItemIds" in (commands[0] ?? {}))) return "premiere.timeline.edit";
  if (["import", "create-bin", "rename", "save-copy"].includes(String(op)) || (op === "move" && "projectItemIds" in (commands[0] ?? {}))) return "premiere.project.edit";
  if ((op === "create" && "width" in (commands[0] ?? {}) && "height" in (commands[0] ?? {})) || (op === "delete" && "sequenceId" in (commands[0] ?? {})) || op === "set-sequence") return "premiere.sequences.edit";
  if (["set", "set-keyframes", "remove", "apply"].includes(String(op)) && ("effectId" in (commands[0] ?? {}) || op === "apply")) return "premiere.effects.edit";
  if (["create", "update", "delete", "add", "remove"].includes(String(op)) && ("markerId" in (commands[0] ?? {}) || "markerIds" in (commands[0] ?? {}) || "start" in (commands[0] ?? {}) || op === "add")) return "premiere.markers.edit";
  throw new Error("INVALID_ARGUMENT: unsupported Premiere command family");
}

/** Test-only adapter retained for the shared mock contract suite. */
export class PremiereMockBridge extends BaseMockBridge { readonly descriptor: BridgeDescriptor = createMockDescriptor("premiere-pro", "uxp"); }
export function createPremiereBridge(dispatcher?: PremiereDispatcher): PremiereBridge { return new PremiereBridge(dispatcher); }
export function hashHandlerManifest(handlers: readonly string[]): string { return createHash("sha256").update(JSON.stringify([...handlers].sort())).digest("hex"); }
export const PREMIERE_HANDLER_ALLOWLIST = [
  "bridge.inspect", "bridge.mutate", "bridge.export", "bridge.snapshot", "bridge.restoreSnapshot", "bridge.verify", "bridge.cancel", "premiere.inspect", "premiere.project.edit", "premiere.sequences.edit", "premiere.timeline.edit", "premiere.effects.edit", "premiere.markers.edit", "premiere.editPlan.execute", "premiere.export",
] as const;
