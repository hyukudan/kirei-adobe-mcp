import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BaseMockBridge,
  compareBase64Images,
  createMockDescriptor,
  IdempotencyStore,
  inputHash,
  LockManager,
  type AdobeBridge,
  type BridgeDescriptor,
  type BridgeState,
  type ExportRequest,
  type InspectRequest,
  type InspectResult,
  type MutationRequest,
  type PreviewCaptureRequest,
  type VisualVerifyRequest,
  type VisualVerifyResult,
} from "@adobe-mcp/bridge-core";
import type { ArtifactRef, Job, OperationReceipt, PreviewCaptureData, Snapshot, TargetRef } from "@adobe-mcp/schemas";
import { AiDocumentState as AiDocumentStateSchema, IllustratorArtboardExport, IllustratorArtboardExportResult, IllustratorEditCommand, AfterEffectsPresetApply, PremiereEditPlan, OperationReceipt as OperationReceiptSchema, PreviewCaptureData as PreviewCaptureDataSchema, Snapshot as SnapshotSchema } from "@adobe-mcp/schemas";

export const ILLUSTRATOR_CAPABILITIES = [
  "state.read@1", "state.write@1", "artboards.read@1", "layers.read@1", "page-items.read@1",
  "geometry.read@1", "color-space.read@1", "objects.create@1", "objects.transform@1", "objects.delete@1",
  "vector.path@1", "vector.compound@1", "vector.pathfinder@1", "typography.write@1",
  "export.ai@1", "export.svg@1", "export.pdf@1", "export.png@1", "export.jpeg@1", "snapshot.create@1",
  "verify.state@1", "preview.capture@1", "jsx.fallback@1",
] as const;

export const JSX_HANDLER_ALLOWLIST = ["inspect", "create-layer", "create-item", "transform", "delete", "export", "snapshot", "verify"] as const;
export type JsxHandler = (typeof JSX_HANDLER_ALLOWLIST)[number];

export interface IllustratorRpcTransport {
  connect(hello: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface JsxManifestEntry {
  readonly file: string;
  readonly sha256: string;
  readonly version: string;
  readonly handlers: readonly JsxHandler[];
}

export interface JsxManifest {
  readonly version: string;
  readonly handlers: readonly JsxHandler[];
  readonly files: readonly JsxManifestEntry[];
}

export interface IllustratorBridgeOptions {
  readonly transport?: IllustratorRpcTransport;
  readonly instanceId?: string;
  readonly appVersion?: string;
  readonly transportKind?: "uxp" | "jsx";
  readonly capabilities?: readonly string[];
  readonly artifactStore?: { put(bytes: Uint8Array, options?: { mediaType?: string; provenance?: Record<string, unknown> }): Promise<{ sha256: string; uri: string; mediaType?: string; sizeBytes: number }> };
}

export const DEFAULT_ILLUSTRATOR_DESCRIPTOR: BridgeDescriptor = {
  app: "illustrator", transport: "uxp", appVersion: "unknown", instanceId: "illustrator-unregistered",
  capabilities: ILLUSTRATOR_CAPABILITIES,
  limits: { maxInFlightReads: 8, maxInFlightWrites: 1, maxFrameBytes: 8 * 1024 * 1024 },
};

export function createIllustratorDescriptor(options: IllustratorBridgeOptions = {}): BridgeDescriptor {
  return {
    ...DEFAULT_ILLUSTRATOR_DESCRIPTOR,
    transport: options.transportKind ?? "uxp",
    appVersion: options.appVersion ?? DEFAULT_ILLUSTRATOR_DESCRIPTOR.appVersion,
    instanceId: options.instanceId ?? DEFAULT_ILLUSTRATOR_DESCRIPTOR.instanceId,
    capabilities: options.capabilities ?? ILLUSTRATOR_CAPABILITIES,
  };
}

export function sha256Hex(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function verifyJsxSource(source: string | Uint8Array, expectedSha256: string): boolean {
  return /^[a-f0-9]{64}$/.test(expectedSha256) && sha256Hex(source) === expectedSha256;
}

export async function loadJsxManifest(url = new URL("./jsx/manifest.json", import.meta.url)): Promise<JsxManifest> {
  const parsed: unknown = JSON.parse(await readFile(fileURLToPath(url), "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("INVALID_ARGUMENT: invalid JSX manifest");
  const value = parsed as Partial<JsxManifest>;
  if (typeof value.version !== "string" || !Array.isArray(value.handlers) || !Array.isArray(value.files)) throw new Error("INVALID_ARGUMENT: invalid JSX manifest");
  const handlers = value.handlers.filter((handler): handler is JsxHandler => typeof handler === "string" && (JSX_HANDLER_ALLOWLIST as readonly string[]).includes(handler));
  if (handlers.length !== value.handlers.length) throw new Error("PERMISSION_DENIED: JSX handler is not allowlisted");
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("INVALID_ARGUMENT: invalid JSX manifest entry");
    const item = entry as Partial<JsxManifestEntry>;
    if (typeof item.file !== "string" || typeof item.sha256 !== "string" || typeof item.version !== "string" || !Array.isArray(item.handlers)) throw new Error("INVALID_ARGUMENT: invalid JSX manifest entry");
    const entryHandlers = item.handlers.filter((handler): handler is JsxHandler => typeof handler === "string" && (JSX_HANDLER_ALLOWLIST as readonly string[]).includes(handler));
    if (entryHandlers.length !== item.handlers.length) throw new Error("PERMISSION_DENIED: JSX handler is not allowlisted");
    return { file: item.file, sha256: item.sha256, version: item.version, handlers: entryHandlers };
  });
  return { version: value.version, handlers, files };
}

export async function readVerifiedJsx(entry: JsxManifestEntry, baseUrl = new URL("./jsx/", import.meta.url)): Promise<string> {
  if (entry.file !== entry.file.split(/[\\/]/).pop() || entry.file.includes("..")) throw new Error("PERMISSION_DENIED: JSX manifest path traversal");
  const source = await readFile(fileURLToPath(new URL(entry.file, baseUrl)), "utf8");
  if (!verifyJsxSource(source, entry.sha256)) throw new Error(`INTERNAL: JSX hash mismatch for ${entry.file}`);
  return source;
}

export async function verifyJsxManifest(manifest?: JsxManifest): Promise<JsxManifest> {
  const verified = manifest ?? await loadJsxManifest();
  for (const entry of verified.files) await readVerifiedJsx(entry);
  return verified;
}

export async function invokeVerifiedJsx(
  transport: IllustratorRpcTransport,
  handler: JsxHandler,
  payload: Record<string, unknown>,
  manifest?: JsxManifest,
): Promise<unknown> {
  if (!(JSX_HANDLER_ALLOWLIST as readonly string[]).includes(handler)) throw new Error("PERMISSION_DENIED: JSX handler is not allowlisted");
  const verified = manifest ?? await loadJsxManifest();
  const entry = verified.files.find((candidate) => candidate.handlers.includes(handler));
  if (!entry) throw new Error(`UNSUPPORTED_CAPABILITY: JSX handler ${handler}`);
  await readVerifiedJsx(entry);
  return transport.call("jsx.invoke", { handler, payload, version: entry.version, sha256: entry.sha256 });
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function parseReceipt(value: unknown): OperationReceipt { return OperationReceiptSchema.parse(value); }
function parseSnapshot(value: unknown): Snapshot { return SnapshotSchema.parse(value); }

/** Illustrator adapter. A live UXP/JSX transport is injected by the daemon. */
export class IllustratorBridge implements AdobeBridge {
  readonly descriptor: BridgeDescriptor;
  private state: BridgeState = "disconnected";
  private revision = "ai-rev-0";
  private revisionCounter = 0;
  private readonly idempotency = new IdempotencyStore<OperationReceipt>();
  private readonly locks = new LockManager();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly artifactStore: IllustratorBridgeOptions["artifactStore"];

  constructor(private readonly options: IllustratorBridgeOptions = {}) { this.descriptor = createIllustratorDescriptor(options); this.artifactStore = options.artifactStore; }

  async connect(): Promise<void> {
    if (!this.options.transport) throw new Error("BRIDGE_UNAVAILABLE: Illustrator panel transport is not configured");
    await this.options.transport.connect({
      protocolVersion: "1.0", instanceId: this.descriptor.instanceId,
      client: { kind: this.descriptor.transport, app: "illustrator", appVersion: this.descriptor.appVersion },
      capabilities: [...this.descriptor.capabilities],
    });
    this.state = "ready";
  }
  async health(): Promise<BridgeState> { return this.options.transport ? this.state : "disconnected"; }

  async capturePreview(request: PreviewCaptureRequest): Promise<PreviewCaptureData> {
    this.requireReady();
    return PreviewCaptureDataSchema.parse(await this.call("bridge.preview.capture", request as unknown as Record<string, unknown>));
  }
  async verifyVisual(request: VisualVerifyRequest): Promise<VisualVerifyResult> { const current = await this.capturePreview({ target: request.target, format: "png", maxDimension: 4096, ...(request.time ? { time: request.time } : {}) }); return compareBase64Images(request.baselineImageBase64, current.imageBase64, request.tolerance); }

  async inspect(request: InspectRequest): Promise<InspectResult> {
    this.requireReady();
    const record = asRecord(await this.call("bridge.inspect", request as unknown as Record<string, unknown>), "HOST_ERROR: invalid Illustrator inspection");
    const data = AiDocumentStateSchema.parse(record.data ?? record);
    const revision = typeof record.revision === "string" ? record.revision : this.revision;
    this.revision = revision;
    return { target: request.target, revision, data: data as unknown as Record<string, unknown> };
  }

  async mutate(request: MutationRequest): Promise<OperationReceipt> {
    this.requireReady();
    if (request.commands.length === 0 || request.commands.length > 500) throw new Error("INVALID_ARGUMENT: commands must contain 1..500 entries");
    const digest = inputHash(request); const cached = this.idempotency.get(request.options.operationId, digest);
    if (cached) return cached;
    if (request.options.expectedRevision && request.options.expectedRevision !== this.revision) throw new Error("CONFLICT: stale Illustrator revision");
    for (const command of request.commands) IllustratorEditCommand.parse(command);
    if (request.options.atomic && !this.descriptor.capabilities.includes("state.write@1")) throw new Error("UNSUPPORTED_CAPABILITY: state.write@1");
    const leases = this.locks.acquire([request.target.documentId ?? `${request.target.app}:${this.descriptor.instanceId}`]);
    try {
      const receipt = parseReceipt(await this.call("bridge.mutate", { ...request, commands: request.commands }));
      if (receipt.revision) this.revision = receipt.revision;
      else if (!request.options.dryRun) this.revision = `ai-rev-${++this.revisionCounter}`;
      const normalized = receipt.revision ? receipt : { ...receipt, revision: this.revision };
      this.idempotency.set(request.options.operationId, normalized, digest);
      return normalized;
    } finally { this.locks.release(leases); }
  }

  async export(request: ExportRequest): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> {
    this.requireReady();
    const format = request.options.format;
    if (typeof format !== "string" || !["ai", "svg", "pdf", "png", "jpeg"].includes(format)) throw new Error("INVALID_ARGUMENT: Illustrator export format is not supported");
    const capability = `export.${format}@1`;
    if (!this.descriptor.capabilities.includes(capability)) throw new Error(`UNSUPPORTED_CAPABILITY: ${capability}`);
    const result = asRecord(await this.call("bridge.export", request as unknown as Record<string, unknown>), "EXPORT_FAILED: invalid export response");
    return { artifact: asRecord(result.artifact, "EXPORT_FAILED: export did not return an artifact") as ArtifactRef, receipt: parseReceipt(result.receipt) };
  }

  async exportArtboards(input: import("@adobe-mcp/schemas").IllustratorArtboardExport): Promise<import("@adobe-mcp/schemas").IllustratorArtboardExportResult> {
    const parsed = IllustratorArtboardExport.parse(input);
    const raw = await this.call("bridge.exportArtboards", parsed as unknown as Record<string, unknown>);
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (!Array.isArray(value.artboards)) return IllustratorArtboardExportResult.parse(value);
    if (!this.artifactStore) throw new Error("EXPORT_FAILED: ArtifactStore is required for Illustrator artboard exports");
    const entries: Record<string, unknown>[] = []; const artifacts: ArtifactRef[] = [];
    for (const item of value.artboards) {
      if (!item || typeof item !== "object") throw new Error("EXPORT_FAILED: invalid artboard bytes");
      const artboard = item as { id?: unknown; name?: unknown; width?: unknown; height?: unknown; bytesBase64?: unknown; mediaType?: unknown };
      if (typeof artboard.id !== "string" || typeof artboard.bytesBase64 !== "string") throw new Error("EXPORT_FAILED: artboard export is missing id or bytes");
      const bytes = Buffer.from(artboard.bytesBase64, "base64"); const metadata = await this.artifactStore.put(bytes, { mediaType: typeof artboard.mediaType === "string" ? artboard.mediaType : parsed.format === "svg" ? "image/svg+xml" : "image/png", provenance: { app: "illustrator", artboardId: artboard.id } });
      const displayName = `${String(artboard.name ?? artboard.id)}.${parsed.format}`;
      artifacts.push({ artifactId: `illustrator-artboard-${metadata.sha256.slice(0, 16)}`, kind: "file", displayName, mediaType: metadata.mediaType, sizeBytes: metadata.sizeBytes, sha256: metadata.sha256, provenance: { app: "illustrator", sourceArtifactId: metadata.uri } });
      entries.push({ artboardId: artboard.id, fileName: displayName, width: Number(artboard.width ?? 1), height: Number(artboard.height ?? 1), sha256: metadata.sha256, sizeBytes: metadata.sizeBytes, uri: metadata.uri });
    }
    const manifestHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    return IllustratorArtboardExportResult.parse({ manifest: { version: "1", entries, sha256: manifestHash }, artifacts });
  }

  async exportLayers(input: import("@adobe-mcp/schemas").PhotoshopLayerExportSpec): Promise<import("@adobe-mcp/schemas").PhotoshopLayerExportResult> { void input; throw new Error("UNSUPPORTED_CAPABILITY: Illustrator bridge cannot export Photoshop layers"); }
  async applyPreset(input: import("@adobe-mcp/schemas").AfterEffectsPresetApply): Promise<import("@adobe-mcp/schemas").AfterEffectsPresetApplyResult> { AfterEffectsPresetApply.parse(input); throw new Error("UNSUPPORTED_CAPABILITY: Illustrator bridge cannot apply After Effects presets"); }
  async executeEditPlan(input: import("@adobe-mcp/schemas").PremiereEditPlan): Promise<import("@adobe-mcp/schemas").PremiereEditPlanResult> { PremiereEditPlan.parse(input); throw new Error("UNSUPPORTED_CAPABILITY: Illustrator bridge cannot execute Premiere EditPlans"); }

  async snapshot(target: TargetRef): Promise<Snapshot> {
    this.requireReady();
    const snapshot = parseSnapshot(await this.call("bridge.snapshot", { target }));
    if (!snapshot.verified || snapshot.target.app !== "illustrator" || snapshot.artifact.sha256 !== snapshot.sha256) throw new Error("SNAPSHOT_FAILED: unverified Illustrator snapshot");
    this.snapshots.set(snapshot.id, snapshot); this.revision = snapshot.revision; return snapshot;
  }
  async restoreSnapshot(target: TargetRef, snapshotId: string): Promise<void> { this.requireReady(); await this.call("bridge.restoreSnapshot", { target, snapshotId }); }

  async verify(target: TargetRef, expectedRevision?: string): Promise<{ ok: boolean; revision: string; details?: Record<string, unknown> }> {
    this.requireReady();
    const result = asRecord(await this.call("bridge.verify", { target, expectedRevision }), "VERIFICATION_FAILED: invalid verification response");
    if (typeof result.ok !== "boolean" || typeof result.revision !== "string") throw new Error("VERIFICATION_FAILED: invalid verification response");
    this.revision = result.revision;
    const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : undefined;
    return details ? { ok: result.ok, revision: result.revision, details } : { ok: result.ok, revision: result.revision };
  }

  async cancel(jobId: string): Promise<Job> { this.requireReady(); return asRecord(await this.call("bridge.cancel", { jobId }), "NOT_FOUND: invalid Illustrator job") as Job; }
  async close(): Promise<void> { this.state = "disconnected"; await this.options.transport?.close(); }
  getSnapshot(id: string): Snapshot | undefined { return this.snapshots.get(id); }

  private requireReady(): void { if (this.state !== "ready") throw new Error("BRIDGE_UNAVAILABLE: Illustrator bridge is not connected"); }
  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.options.transport) throw new Error("BRIDGE_UNAVAILABLE: Illustrator panel transport is not configured");
    try { return await this.options.transport.call(method, params); } catch (error) { this.state = "degraded"; throw error; }
  }
}

export function createIllustratorBridge(options: IllustratorBridgeOptions = {}): IllustratorBridge { return new IllustratorBridge(options); }
/** Test-only deterministic adapter retained for the shared contract suite. */
export class IllustratorMockBridge extends BaseMockBridge { readonly descriptor: BridgeDescriptor = createMockDescriptor("illustrator", "uxp"); }
export function createIllustratorMockBridge(): IllustratorMockBridge { return new IllustratorMockBridge(); }
export { AiDocumentStateSchema, IllustratorEditCommand };
export * from "./vector.js";
