import { randomUUID } from "node:crypto";
import { computeAuthProof, createNonce, ProtocolVersion } from "@adobe-mcp/protocol";
import { compareBase64Images, inputHash } from "@adobe-mcp/bridge-core";
import type { AdobeBridge, BridgeDescriptor, BridgeState, ExportRequest, InspectRequest, MutationRequest, InspectResult, PreviewCaptureRequest, VisualVerifyRequest, VisualVerifyResult } from "@adobe-mcp/bridge-core";
import { PreviewCaptureData } from "@adobe-mcp/schemas";
import type { ArtifactRef, Job, OperationReceipt, Snapshot, TargetRef } from "@adobe-mcp/schemas";
import { BaseMockBridge, createMockDescriptor } from "@adobe-mcp/bridge-core";
import { IllustratorArtboardExport, AfterEffectsPresetApply, PremiereEditPlan, PhotoshopLayerExportResult, PhotoshopLayerExportSpec } from "@adobe-mcp/schemas";
import type { PhotoshopComFallback } from "./com.js";
import { createWindowsPhotoshopCom } from "./com.js";
import { buildBatchPlay, exportLayers as buildLayerExport, type BatchPlayCommand, type LayerExportInput, type LayerExportManifest } from "./batchplay.js";

export type SocketMessage = string | { data?: string | ArrayBuffer };
export interface PhotoshopSocket {
  send(data: string): void;
  close(): void;
  addEventListener?(event: "open" | "message" | "close" | "error", listener: (value: unknown) => void): void;
  on?(event: "open" | "message" | "close" | "error", listener: (value: unknown) => void): void;
}
export interface PhotoshopTransport { connect(endpoint: string): Promise<PhotoshopSocket>; }

class NativeWebSocketTransport implements PhotoshopTransport {
  async connect(endpoint: string): Promise<PhotoshopSocket> {
    const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => PhotoshopSocket }).WebSocket;
    if (!ctor) throw new Error("BRIDGE_UNAVAILABLE: no WebSocket implementation is available");
    return new ctor(endpoint);
  }
}

interface PendingCall { resolve: (value: unknown) => void; reject: (error: Error) => void; }
interface Challenge { serverNonce: string; sessionId: string; expiresAt: string; }

export interface PhotoshopBridgeOptions {
  endpoint?: string;
  token?: string;
  instanceId?: string;
  appVersion?: string;
  transport?: PhotoshopTransport;
  com?: PhotoshopComFallback;
  resolveGrant?: (grantId: string) => Promise<string>;
  artifactStore?: ArtifactStoreLike;
}
export interface ArtifactStoreLike { put(bytes: Uint8Array, options?: { mediaType?: string; provenance?: Record<string, unknown> }): Promise<{ sha256: string; uri: string; mediaType?: string; sizeBytes: number }>; }

function bind(socket: PhotoshopSocket, event: "open" | "message" | "close" | "error", handler: (value: unknown) => void): void {
  if (socket.addEventListener) socket.addEventListener(event, handler);
  else if (socket.on) socket.on(event, handler);
  else throw new Error("BRIDGE_UNAVAILABLE: unsupported WebSocket implementation");
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "data" in value) {
    const data = (value as { data?: unknown }).data;
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  }
  return String(value);
}

function targetKey(target: TargetRef): string {
  return `${target.app}:${target.instanceId ?? "active"}:${target.documentId ?? target.projectId ?? target.entityId ?? "root"}`;
}

function errorFromRpc(value: unknown): Error {
  const message = value && typeof value === "object" && "message" in value ? String((value as { message: unknown }).message) : "Bridge RPC failed";
  return new Error(message);
}

/** Production Photoshop bridge. The UXP panel is the primary transport; COM is an explicit fallback. */
export class PhotoshopBridge implements AdobeBridge {
  readonly descriptor: BridgeDescriptor;
  private readonly endpoint: string;
  private readonly token: string | undefined;
  private readonly transport: PhotoshopTransport;
  private readonly com: PhotoshopComFallback | undefined;
  private readonly resolveGrant: ((grantId: string) => Promise<string>) | undefined;
  private readonly artifactStore: ArtifactStoreLike | undefined;
  private socket: PhotoshopSocket | undefined;
  private state: BridgeState = "disconnected";
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastSeen = 0;
  private readonly pending = new Map<string, PendingCall>();
  private readonly revisions = new Map<string, string>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly receipts = new Map<string, OperationReceipt>();
  private readonly receiptHashes = new Map<string, string>();
  private connectPromise: Promise<void> | undefined;

  constructor(options: PhotoshopBridgeOptions = {}) {
    const fallback = options.com ?? (!options.endpoint && !options.token && process.platform === "win32" ? createWindowsPhotoshopCom() : undefined);
    this.com = fallback;
    this.endpoint = options.endpoint ?? process.env.ADOBE_MCP_DAEMON_ENDPOINT ?? "ws://127.0.0.1:4000";
    this.token = options.token ?? process.env.ADOBE_MCP_SESSION_TOKEN;
    this.transport = options.transport ?? new NativeWebSocketTransport();
    this.resolveGrant = options.resolveGrant;
    this.artifactStore = options.artifactStore;
    this.descriptor = {
      app: "photoshop",
      transport: fallback && !options.transport ? "com" : "uxp",
      appVersion: options.appVersion ?? "unknown",
      instanceId: options.instanceId ?? randomUUID(),
      capabilities: fallback && !options.transport ? ["state.read@1", "state.write@1", "export.file@1"] : ["state.read@1", "state.write@1", "layers.write@1", "filters.write@1", "text.write@1", "snapshot.create@1", "preview.capture@1", "export.file@1", "batch.atomic@1"],
      limits: { maxInFlightReads: 8, maxInFlightWrites: 1, maxFrameBytes: 8 * 1024 * 1024 },
    };
  }

  async connect(): Promise<void> {
    if (this.state === "ready") return;
    if (this.connectPromise) return this.connectPromise;
    if (this.com && !this.token && !this.socket) { this.state = "ready"; return; }
    if (!this.token) throw new Error("UNAUTHENTICATED: Photoshop session token is required");
    this.connectPromise = this.connectUxP().finally(() => { this.connectPromise = undefined; });
    return this.connectPromise;
  }

  private async connectUxP(): Promise<void> {
    this.state = "connecting";
    const socket = await this.transport.connect(this.endpoint);
    this.socket = socket;
    this.lastSeen = Date.now();
    const welcome = new Promise<void>((resolve, reject) => {
      const helloId = randomUUID();
      const onMessage = async (raw: unknown) => {
        this.lastSeen = Date.now();
        let value: unknown;
        try { value = JSON.parse(messageText(raw)); } catch { reject(new Error("HOST_ERROR: invalid JSON from Photoshop daemon")); return; }
        if (value && typeof value === "object" && "method" in value && (value as { method?: unknown }).method === "auth.challenge") {
          try {
            const challenge = (value as unknown as { params: Challenge }).params;
            if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("UNAUTHENTICATED: expired daemon challenge");
            const clientNonce = createNonce();
            const proof = computeAuthProof(this.token!, clientNonce, challenge.serverNonce, challenge.sessionId, ProtocolVersion);
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: helloId, method: "bridge.hello", params: { protocolVersion: ProtocolVersion, instanceId: this.descriptor.instanceId, client: { kind: "uxp", app: "photoshop", appVersion: this.descriptor.appVersion }, capabilities: this.descriptor.capabilities, auth: { scheme: "challenge-hmac", clientNonce }, proof } }));
          } catch (error) { reject(error instanceof Error ? error : new Error("UNAUTHENTICATED: challenge failed")); }
          return;
        }
        if (value && typeof value === "object" && "id" in value && String((value as { id: unknown }).id) === helloId) {
          if ("error" in value) reject(errorFromRpc((value as { error: unknown }).error)); else { this.state = "ready"; resolve(); }
        }
        this.handleMessage(value);
      };
      bind(socket, "message", onMessage);
      bind(socket, "close", () => { this.state = "disconnected"; reject(new Error("BRIDGE_UNAVAILABLE: Photoshop panel disconnected")); });
      bind(socket, "error", (error) => reject(error instanceof Error ? error : new Error("BRIDGE_UNAVAILABLE: WebSocket error")));
    });
    bind(socket, "open", () => { this.lastSeen = Date.now(); });
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > 45_000) { socket.close(); this.state = "degraded"; return; }
      try { socket.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() })); } catch { this.state = "degraded"; }
    }, 10_000);
    await welcome;
  }

  async health(): Promise<BridgeState> { return this.state; }

  async capturePreview(request: PreviewCaptureRequest): Promise<import("@adobe-mcp/schemas").PreviewCaptureData> {
    if (this.com && !this.socket) throw new Error("UNSUPPORTED_CAPABILITY: Photoshop COM preview capture is unavailable");
    return PreviewCaptureData.parse(await this.call("bridge.preview.capture", request as unknown as Record<string, unknown>));
  }
  async verifyVisual(request: VisualVerifyRequest): Promise<VisualVerifyResult> { const current = await this.capturePreview({ target: request.target, format: "png", maxDimension: 4096, ...(request.time ? { time: request.time } : {}) }); return compareBase64Images(request.baselineImageBase64, current.imageBase64, request.tolerance); }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    const result = this.com && !this.socket ? { target: request.target, ...await this.com.inspect(request.target) } : await this.call("bridge.inspect", request) as InspectResult;
    this.revisions.set(targetKey(request.target), result.revision);
    return result;
  }

  async mutate(request: MutationRequest): Promise<OperationReceipt> {
    const digest = inputHash(request); const cached = this.receipts.get(request.options.operationId);
    if (cached) { if (this.receiptHashes.get(request.options.operationId) !== digest) throw new Error("CONFLICT: operationId was already used with a different input"); return cached; }
    const key = targetKey(request.target);
    const current = this.revisions.get(key);
    if (request.options.expectedRevision && current && request.options.expectedRevision !== current) throw new Error("CONFLICT: expectedRevision is stale");
    let receipt: OperationReceipt;
    if (this.com && !this.socket) {
      const result = await this.com.mutate(request.target, request.commands);
      receipt = { status: request.options.dryRun ? "planned" : "applied", previousRevision: current ?? request.options.expectedRevision, revision: result.revision, appliedIndexes: result.appliedIndexes, failedIndexes: result.failedIndexes, tempIdMap: result.tempIdMap, compensations: [], verification: request.options.verification === "none" ? "skipped" : "passed" };
    } else receipt = await this.call("bridge.mutate", request) as OperationReceipt;
    if (receipt.revision) this.revisions.set(key, receipt.revision);
    if (!request.options.dryRun && request.options.verification !== "none") {
      const verification = await this.verify(request.target, receipt.revision);
      if (!verification.ok) throw new Error("VERIFICATION_FAILED: Photoshop state changed after mutation");
      receipt = { ...receipt, verification: "passed" };
    }
    this.receiptHashes.set(request.options.operationId, digest); this.receipts.set(request.options.operationId, receipt);
    return receipt;
  }
  async executeBatchPlay(commands: readonly BatchPlayCommand[]): Promise<unknown> {
    if (this.com && !this.socket) throw new Error("UNSUPPORTED_CAPABILITY: Photoshop COM does not expose batchPlay");
    const parsed = buildBatchPlay(commands);
    return this.call("photoshop.action.batchPlay", { commands: parsed.map((entry) => entry.descriptor), options: { synchronousExecution: true, modalBehavior: "fail" } });
  }
  buildLayerExportManifest(sourceDocumentId: string, layers: readonly LayerExportInput[]): LayerExportManifest { return buildLayerExport(sourceDocumentId, layers); }

  async exportLayers(input: import("@adobe-mcp/schemas").PhotoshopLayerExportSpec): Promise<import("@adobe-mcp/schemas").PhotoshopLayerExportResult> {
    const parsed = PhotoshopLayerExportSpec.parse(input);
    const raw = await this.call("bridge.exportLayers", parsed as unknown as Record<string, unknown>);
    const candidate = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const encoded = Array.isArray(candidate.layerBytes) ? candidate.layerBytes : [];
    if (!encoded.length) return PhotoshopLayerExportResult.parse(candidate);
    const artifacts: ArtifactRef[] = [];
    const entries: Record<string, unknown>[] = [];
    if (!this.artifactStore) throw new Error("EXPORT_FAILED: ArtifactStore is required for Photoshop layer exports");
    for (const item of encoded) {
      if (!item || typeof item !== "object") throw new Error("EXPORT_FAILED: invalid Photoshop layer bytes");
      const value = item as { layerId?: unknown; name?: unknown; format?: unknown; bytesBase64?: unknown; mediaType?: unknown; bounds?: unknown };
      if (typeof value.layerId !== "string" || typeof value.bytesBase64 !== "string") throw new Error("EXPORT_FAILED: layer export is missing id or bytes");
      const bytes = Buffer.from(value.bytesBase64, "base64");
      const metadata = await this.artifactStore.put(bytes, { mediaType: typeof value.mediaType === "string" ? value.mediaType : `image/${String(value.format ?? parsed.format)}`, provenance: { app: "photoshop", sourceDocumentId: parsed.target.documentId ?? "active", layerId: value.layerId } });
      const artifact = { artifactId: `photoshop-layer-${metadata.sha256.slice(0, 16)}`, kind: "file" as const, displayName: `${String(value.name ?? value.layerId)}.${String(value.format ?? parsed.format)}`, mediaType: metadata.mediaType, sizeBytes: metadata.sizeBytes, sha256: metadata.sha256, provenance: { app: "photoshop" as const, sourceArtifactId: metadata.uri } };
      artifacts.push(artifact);
      entries.push({ layerId: value.layerId, name: value.name ?? value.layerId, fileName: artifact.displayName, uri: metadata.uri, sha256: metadata.sha256, sizeBytes: metadata.sizeBytes, ...(value.bounds === undefined ? {} : { bounds: value.bounds }) });
    }
    return PhotoshopLayerExportResult.parse({ manifest: { version: "1", sourceDocumentId: parsed.target.documentId ?? "active", entries }, artifacts });
  }

  async exportArtboards(input: import("@adobe-mcp/schemas").IllustratorArtboardExport): Promise<import("@adobe-mcp/schemas").IllustratorArtboardExportResult> { IllustratorArtboardExport.parse(input); throw new Error("UNSUPPORTED_CAPABILITY: Photoshop bridge cannot export Illustrator artboards"); }
  async applyPreset(input: import("@adobe-mcp/schemas").AfterEffectsPresetApply): Promise<import("@adobe-mcp/schemas").AfterEffectsPresetApplyResult> { AfterEffectsPresetApply.parse(input); throw new Error("UNSUPPORTED_CAPABILITY: Photoshop bridge cannot apply After Effects presets"); }
  async executeEditPlan(input: import("@adobe-mcp/schemas").PremiereEditPlan): Promise<import("@adobe-mcp/schemas").PremiereEditPlanResult> { PremiereEditPlan.parse(input); throw new Error("UNSUPPORTED_CAPABILITY: Photoshop bridge cannot execute Premiere EditPlans"); }

  async export(request: ExportRequest): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> {
    if (this.com && !this.socket) {
      if (!this.resolveGrant) throw new Error("PERMISSION_DENIED: COM export requires a FileGrant resolver");
      const path = await this.resolveGrant(request.destination.grantId);
      const format = String(request.options.format ?? request.destination.suggestedName?.split(".").pop() ?? "psd");
      const result = await this.com.export(request.target, path, format, request.options);
      const receipt = await this.mutate({ target: request.target, commands: [], options: request.mutation });
      return { artifact: { artifactId: randomUUID(), kind: "file", displayName: result.artifact?.displayName ?? request.destination.suggestedName ?? "export", mediaType: result.artifact?.mediaType, sizeBytes: result.artifact?.sizeBytes }, receipt };
    }
    const result = await this.call("bridge.export", request) as { artifact: ArtifactRef; receipt: OperationReceipt };
    if (request.mutation.verification !== "none") {
      const verification = await this.verify(request.target, result.receipt.revision);
      if (!verification.ok) throw new Error("VERIFICATION_FAILED: export changed Photoshop state unexpectedly");
    }
    return result;
  }

  async snapshot(target: TargetRef): Promise<Snapshot> {
    const snapshot = this.com && !this.socket ? await this.makeComSnapshot(target) : await this.call("bridge.snapshot", { target }) as Snapshot;
    if (!snapshot.verified || snapshot.artifact.sha256 !== snapshot.sha256) throw new Error("SNAPSHOT_FAILED: Photoshop snapshot is not content-addressed"); this.snapshots.set(targetKey(target), snapshot);
    this.revisions.set(targetKey(target), snapshot.revision);
    return snapshot;
  }

  async restoreSnapshot(target: TargetRef, snapshotId: string): Promise<void> {
    if (this.com && !this.socket) throw new Error("UNSUPPORTED_CAPABILITY: Photoshop COM restore requires a host checkpoint");
    await this.call("bridge.restoreSnapshot", { target, snapshotId });
  }

  private async makeComSnapshot(target: TargetRef): Promise<Snapshot> {
    const state = await this.com!.inspect(target);
    const digest = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(JSON.stringify(state.data)).digest("hex"));
    return { id: randomUUID(), target, revision: state.revision, createdAt: new Date().toISOString(), sha256: digest, artifact: { artifactId: randomUUID(), kind: "snapshot", displayName: "photoshop-com-snapshot", sha256: digest, provenance: { app: "photoshop" } }, verified: true };
  }

  async verify(target: TargetRef, expectedRevision?: string): Promise<{ ok: boolean; revision: string; details?: Record<string, unknown> }> {
    const result: { ok?: boolean; revision: string; details?: Record<string, unknown> } = this.com && !this.socket ? { revision: (await this.com.inspect(target)).revision } : await this.call("bridge.verify", { target, expectedRevision }) as { ok: boolean; revision: string; details?: Record<string, unknown> };
    const ok = result.ok !== undefined ? result.ok : !expectedRevision || result.revision === expectedRevision;
    this.revisions.set(targetKey(target), result.revision);
    return { ...result, ok: ok && (!expectedRevision || result.revision === expectedRevision) };
  }

  async cancel(jobId: string): Promise<Job> { return this.call("bridge.cancel", { jobId }) as Promise<Job>; }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("BRIDGE_UNAVAILABLE: Photoshop bridge closed"));
    this.pending.clear();
    if (this.socket) { this.socket.close(); this.socket = undefined; }
    await this.com?.close();
    this.state = "disconnected";
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if ("type" in value && (value as { type?: unknown }).type === "pong") { this.lastSeen = Date.now(); return; }
    if ("type" in value && (value as { type?: unknown }).type === "rpc") value = (value as unknown as { request: unknown }).request;
    const candidate = value as Record<string, unknown>;
    if ("id" in candidate && ("result" in candidate || "error" in candidate)) {
      const response = value as { id: unknown; result?: unknown; error?: unknown };
      const id = String(response.id); const pending = this.pending.get(id); if (!pending) return;
      this.pending.delete(id); if (response.error !== undefined) pending.reject(errorFromRpc(response.error)); else pending.resolve(response.result);
    }
  }

  private call(method: string, params: unknown): Promise<unknown> {
    if (!this.socket || this.state !== "ready") return Promise.reject(new Error("BRIDGE_UNAVAILABLE: Photoshop panel is not connected"));
    return new Promise((resolve, reject) => {
      const id = randomUUID(); this.pending.set(id, { resolve, reject });
      try { this.socket!.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id, method, params } })); }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error("BRIDGE_UNAVAILABLE: send failed")); }
    });
  }
}

/** Backwards-compatible test double; production code should use PhotoshopBridge with endpoint/token. */
export class PhotoshopMockBridge extends BaseMockBridge { readonly descriptor: BridgeDescriptor = createMockDescriptor("photoshop", "uxp"); }

export function createPhotoshopBridge(options: PhotoshopBridgeOptions = {}): PhotoshopBridge { return new PhotoshopBridge(options); }
export function createMockPhotoshopBridge(): PhotoshopMockBridge { return new PhotoshopMockBridge(); }
export function createRealPhotoshopBridge(options: PhotoshopBridgeOptions): PhotoshopBridge { return new PhotoshopBridge(options); }

export { createWindowsPhotoshopCom } from "./com.js";
export type { PhotoshopComFallback } from "./com.js";
export * from "./batchplay.js";
