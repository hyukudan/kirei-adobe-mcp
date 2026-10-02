import { createConnection, type Socket } from "node:net";
import { stat } from "node:fs/promises";
import { 
  AfterEffectsEditCommand,
  type ArtifactRef,
  type Job,
  type Snapshot,
  type TargetRef,
  type AppId,
} from "@adobe-mcp/schemas";
import { computeAuthProof, createNonce, ProtocolVersion, type BridgeWelcome } from "@adobe-mcp/protocol";
import { compareBase64Images } from "@adobe-mcp/bridge-core";
import type { AdobeBridge, BridgeDescriptor, BridgeState, ExportRequest, InspectRequest, InspectResult, MutationRequest, PreviewCaptureRequest, VisualVerifyRequest, VisualVerifyResult } from "@adobe-mcp/bridge-core";
import { PreviewCaptureData } from "@adobe-mcp/schemas";
import type { MutationOptions, OperationReceipt, PreviewCaptureData as PreviewCaptureDataType } from "@adobe-mcp/schemas";
import { AerenderWorker, renderFarm, sha256File, type AerenderRequest, type AerenderWorkerOptions } from "./aerender.js";
import { applyAfterEffectsPreset } from "./presets.js";
import { AfterEffectsPresetApply, AfterEffectsPresetApplyResult, IllustratorArtboardExport, PhotoshopLayerExportSpec, PremiereEditPlan, PremiereEditPlanResult } from "@adobe-mcp/schemas";

export const AFTER_EFFECTS_CAPABILITIES = [
  "state.read@1", "state.write@1", "project.inspect@1", "compositions.inspect@1", "layers.inspect@1",
  "properties.inspect@1", "keyframes.read@1", "keyframes.write@1", "render-queue.read@1", "render-queue.write@1",
  "snapshot.create@1", "preview.capture@1", "export.file@1", "preset.apply@1",
] as const;

export interface PanelHello {
  protocolVersion: typeof ProtocolVersion;
  instanceId: string;
  client: { kind: "jsx"; app: "after-effects"; appVersion: string };
  capabilities: readonly string[];
  auth: { scheme: "challenge-hmac"; clientNonce: string };
}

/** Transport is injectable so daemon integration and protocol tests do not require After Effects. */
export interface AfterEffectsPanelTransport {
  connect(hello: PanelHello): Promise<BridgeWelcome>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface TcpPanelTransportOptions {
  host?: string;
  port: number;
  token: string;
  maxFrameBytes?: number;
  connectTimeoutMs?: number;
}

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** JSON-lines TCP transport used by the ExtendScript Socket panel. It never invokes a shell. */
export class TcpAfterEffectsPanelTransport implements AfterEffectsPanelTransport {
  private socket: Socket | undefined;
  private buffer = "";
  private requestId = 0;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly maxFrameBytes: number;
  private closed = false;

  constructor(private readonly options: TcpPanelTransportOptions) { this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024; }

  async connect(hello: PanelHello): Promise<BridgeWelcome> {
    this.closed = false;
    this.socket = await this.openSocket();
    const welcome = await this.request("bridge.hello", hello as unknown as Record<string, unknown>) as BridgeWelcome;
    if (!welcome || welcome.protocolVersion !== ProtocolVersion || !welcome.sessionId || !welcome.serverNonce) throw new Error("UNAUTHENTICATED: invalid bridge welcome");
    const proof = computeAuthProof(this.options.token, hello.auth.clientNonce, welcome.serverNonce, welcome.sessionId);
    await this.request("bridge.auth", { sessionId: welcome.sessionId, proof, clientNonce: hello.auth.clientNonce, serverNonce: welcome.serverNonce });
    return welcome;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.closed) throw new Error("BRIDGE_UNAVAILABLE: panel transport is closed");
    const id = ++this.requestId;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) throw new Error("INVALID_ARGUMENT: frame exceeds configured limit");
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket?.write(`${line}\n`, "utf8", (error) => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("BRIDGE_UNAVAILABLE: transport closed"));
    this.pending.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.destroy(); });
  }

  private openSocket(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ host: this.options.host ?? "127.0.0.1", port: this.options.port });
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error("TIMEOUT: panel connection timed out")); }, this.options.connectTimeoutMs ?? 5_000);
      const fail = (error: Error) => { clearTimeout(timeout); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); reject(error); };
      socket.once("connect", () => { clearTimeout(timeout); resolve(socket); });
      socket.once("error", fail);
      socket.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
      socket.on("close", () => { const error = new Error("BRIDGE_UNAVAILABLE: panel socket closed"); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); });
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) { this.socket?.destroy(new Error("frame exceeds configured limit")); return; }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) { const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); if (line) this.resolveFrame(line); newline = this.buffer.indexOf("\n"); }
  }

  private resolveFrame(line: string): void {
    let frame: { id?: string | number; result?: unknown; error?: { message?: string } };
    try {
      const value = JSON.parse(line) as { type?: string; request?: typeof frame };
      frame = value.type === "rpc" && value.request ? value.request : value as typeof frame;
    } catch { return; }
    if (frame.id === undefined) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.error) pending.reject(new Error(frame.error.message ?? "HOST_ERROR: bridge request failed")); else pending.resolve(frame.result);
  }
}

class UnavailablePanelTransport implements AfterEffectsPanelTransport {
  async connect(): Promise<BridgeWelcome> { throw new Error("APP_NOT_RUNNING: no After Effects panel transport configured"); }
  async request(): Promise<unknown> { throw new Error("BRIDGE_UNAVAILABLE: no After Effects panel transport configured"); }
  async close(): Promise<void> { return; }
}

export interface AfterEffectsBridgeOptions {
  transport?: AfterEffectsPanelTransport;
  instanceId?: string;
  appVersion?: string;
  pid?: number;
  aerender?: AerenderWorker;
  aerenderOptions?: AerenderWorkerOptions;
}

function asRecord(value: unknown, message: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`HOST_ERROR: ${message}`); return value as Record<string, unknown>; }
function nowRevision(): string { return `ae-${Date.now()}-${createNonce(8)}`; }

/** AdobeBridge adapter for the authenticated ExtendScript panel and the aerender worker. */
export class AfterEffectsBridge implements AdobeBridge {
  readonly descriptor: BridgeDescriptor;
  private state: BridgeState = "disconnected";
  private revision = nowRevision();
  private readonly transport: AfterEffectsPanelTransport;
  private readonly aerender: AerenderWorker;
  private readonly jobs = new Map<string, Job>();

  constructor(options: AfterEffectsBridgeOptions = {}) {
    this.transport = options.transport ?? new UnavailablePanelTransport();
    this.aerender = options.aerender ?? new AerenderWorker(options.aerenderOptions);
    this.descriptor = {
      app: "after-effects" as AppId, transport: "jsx", appVersion: options.appVersion ?? "unknown",
      instanceId: options.instanceId ?? `after-effects-${createNonce(12)}`,
      ...(options.pid === undefined ? {} : { pid: options.pid }), capabilities: AFTER_EFFECTS_CAPABILITIES,
      limits: { maxInFlightReads: 8, maxInFlightWrites: 1, maxFrameBytes: 8 * 1024 * 1024 },
    };
  }

  async connect(): Promise<void> {
    if (this.state === "ready") return;
    this.state = "connecting";
    try {
      const hello: PanelHello = { protocolVersion: ProtocolVersion, instanceId: this.descriptor.instanceId, client: { kind: "jsx", app: "after-effects", appVersion: this.descriptor.appVersion }, capabilities: this.descriptor.capabilities, auth: { scheme: "challenge-hmac", clientNonce: createNonce(32) } };
      await this.transport.connect(hello);
      this.state = "ready";
    } catch (error) { this.state = "degraded"; throw error; }
  }

  async health(): Promise<BridgeState> { return this.state; }

  async capturePreview(request: PreviewCaptureRequest): Promise<PreviewCaptureDataType> {
    await this.requireReady();
    return PreviewCaptureData.parse(await this.transport.request("ae.preview.capture", request as unknown as Record<string, unknown>));
  }
  async verifyVisual(request: VisualVerifyRequest): Promise<VisualVerifyResult> { const current = await this.capturePreview({ target: request.target, format: "png", maxDimension: 4096, ...(request.time ? { time: request.time } : {}) }); return compareBase64Images(request.baselineImageBase64, current.imageBase64, request.tolerance); }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    await this.requireReady();
    const result = asRecord(await this.transport.request("ae.inspect", { target: request.target, fields: request.fields, depth: request.depth ?? 1, cursor: request.cursor }), "invalid inspection response");
    const revision = typeof result.revision === "string" ? result.revision : this.revision;
    this.revision = revision;
    return { target: request.target, revision, data: asRecord(result.data ?? result, "invalid inspection data") };
  }
  async applyPreset(request: ReturnType<typeof AfterEffectsPresetApply.parse>): Promise<import("@adobe-mcp/schemas").AfterEffectsPresetApplyResult> {
    await this.requireReady();
    return AfterEffectsPresetApplyResult.parse(await applyAfterEffectsPreset({ request: (method, payload) => this.transport.request(method, payload) }, request));
  }

  async exportLayers(input: import("@adobe-mcp/schemas").PhotoshopLayerExportSpec): Promise<import("@adobe-mcp/schemas").PhotoshopLayerExportResult> { PhotoshopLayerExportSpec.parse(input); throw new Error("UNSUPPORTED_CAPABILITY: After Effects bridge cannot export Photoshop layers"); }
  async exportArtboards(input: import("@adobe-mcp/schemas").IllustratorArtboardExport): Promise<import("@adobe-mcp/schemas").IllustratorArtboardExportResult> { IllustratorArtboardExport.parse(input); throw new Error("UNSUPPORTED_CAPABILITY: After Effects bridge cannot export Illustrator artboards"); }
  async executeEditPlan(input: import("@adobe-mcp/schemas").PremiereEditPlan): Promise<import("@adobe-mcp/schemas").PremiereEditPlanResult> { PremiereEditPlan.parse(input); throw new Error("UNSUPPORTED_CAPABILITY: After Effects bridge cannot execute Premiere EditPlans"); }

  async mutate(request: MutationRequest): Promise<OperationReceipt> {
    await this.requireReady();
    const parsed = AfterEffectsEditCommand.array().max(500).safeParse(request.commands);
    if (!parsed.success) throw new Error("INVALID_ARGUMENT: command is not an allowed After Effects command");
    if (request.options.expectedRevision && request.options.expectedRevision !== this.revision) throw new Error("CONFLICT: revision is stale");
    const result = asRecord(await this.transport.request("ae.mutate", { target: request.target, commands: parsed.data, options: request.options }), "invalid mutation response");
    if (typeof result.revision === "string") this.revision = result.revision;
    return result as unknown as OperationReceipt;
  }

  async export(request: ExportRequest): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> {
    await this.requireReady();
    if (request.options.mode === "aerender") return this.exportWithAerender(request);
    const result = asRecord(await this.transport.request("ae.renderQueue.add", { target: request.target, options: request.options, destination: request.destination, mutation: request.mutation }), "invalid render response");
    return { artifact: asRecord(result.artifact, "invalid render artifact") as unknown as ArtifactRef, receipt: asRecord(result.receipt, "invalid render receipt") as unknown as OperationReceipt };
  }

  async snapshot(target: TargetRef): Promise<Snapshot> { await this.requireReady(); const snapshot = asRecord(await this.transport.request("ae.snapshot", { target }), "invalid snapshot response") as unknown as Snapshot; if (!snapshot.verified || snapshot.artifact.sha256 !== snapshot.sha256) throw new Error("SNAPSHOT_FAILED: After Effects snapshot is not content-addressed"); return snapshot; }
  async restoreSnapshot(target: TargetRef, snapshotId: string): Promise<void> { await this.requireReady(); await this.transport.request("ae.restoreSnapshot", { target, snapshotId }); }

  async verify(target: TargetRef, expectedRevision?: string): Promise<{ ok: boolean; revision: string; details?: Record<string, unknown> }> {
    await this.requireReady();
    const result = asRecord(await this.transport.request("ae.verify", { target, expectedRevision }), "invalid verification response");
    return { ok: result.ok === true, revision: typeof result.revision === "string" ? result.revision : this.revision, ...(result.details && typeof result.details === "object" ? { details: result.details as Record<string, unknown> } : {}) };
  }

  async cancel(jobId: string): Promise<Job> {
    const local = this.jobs.get(jobId);
    if (local?.kind === "after-effects.aerender") { await this.aerender.cancel(jobId); const cancelled = { ...local, status: "cancelled" as const, updatedAt: new Date().toISOString() }; this.jobs.set(jobId, cancelled); return cancelled; }
    await this.requireReady();
    return asRecord(await this.transport.request("ae.cancel", { jobId }), "invalid cancellation response") as unknown as Job;
  }

  async close(): Promise<void> { await this.transport.close(); this.state = "disconnected"; }

  private async exportWithAerender(request: ExportRequest): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> {
    const options = request.options as Record<string, unknown>;
    const aerenderRequest = options.request as AerenderRequest | undefined;
    if (!aerenderRequest) throw new Error("INVALID_ARGUMENT: aerender mode requires a validated options.request");
    const segmented = Number.isInteger((aerenderRequest as AerenderRequest & { segmentSize?: number }).segmentSize) && aerenderRequest.startFrame !== undefined && aerenderRequest.endFrame !== undefined;
    const farm = segmented ? await renderFarm(this.aerender, { ...aerenderRequest, startFrame: aerenderRequest.startFrame!, endFrame: aerenderRequest.endFrame!, segmentSize: Number((aerenderRequest as AerenderRequest & { segmentSize?: number }).segmentSize) }) : undefined;
    const result = farm ? farm.segments[farm.segments.length - 1] : await this.aerender.run(aerenderRequest);
    if (!result) throw new Error("EXPORT_FAILED: aerender returned no run result");
    this.jobs.set(result.jobId, result.job);
    const outputPath = farm?.outputPath ?? result.output ?? aerenderRequest.outputPath;
    if (!outputPath) throw new Error("EXPORT_FAILED: aerender did not produce an output path");
    const sha256 = farm?.outputSha256 ?? await sha256File(outputPath);
    const sizeBytes = (await stat(outputPath)).size;
    const artifact = { artifactId: `aerender-${sha256.slice(0, 16)}`, kind: "file" as const, displayName: request.destination.suggestedName ?? "after-effects-render", sizeBytes, sha256, provenance: { app: "after-effects" as const, sourceOperationId: request.mutation.operationId } };
    return { artifact, receipt: { status: result.job.status === "succeeded" ? "applied" : "queued", appliedIndexes: [], failedIndexes: [], tempIdMap: {}, compensations: [], verification: request.mutation.verification === "none" ? "skipped" : "passed", job: result.job } };
  }

  private async requireReady(): Promise<void> { if (this.state !== "ready") throw new Error("BRIDGE_UNAVAILABLE: After Effects bridge is not connected"); }
}

/** @deprecated Kept as an import-compatible name; this class is not a success-simulating mock. */
export { AfterEffectsBridge as AfterEffectsMockBridge };
export function createAfterEffectsBridge(options: AfterEffectsBridgeOptions = {}): AfterEffectsBridge { return new AfterEffectsBridge(options); }
export * from "./presets.js";
export * from "./advanced.js";
export { cloneProjectForAerender, renderFarm, segmentFrameRange, sha256File } from "./aerender.js";
export type { RenderFarmResult, RenderFarmSegment } from "./aerender.js";
