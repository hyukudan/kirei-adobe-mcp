import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { AfterEffectsPresetApply, AfterEffectsPresetApplyResult, IllustratorArtboardExport, IllustratorArtboardExportResult, PhotoshopLayerExportResult, PhotoshopLayerExportSpec, PremiereEditPlan, PremiereEditPlanResult, type AppId, type ArtifactRef, type Job, type MutationOptions, type OperationReceipt, type PreviewCaptureData, type Snapshot, type TargetRef } from "@adobe-mcp/schemas";
import { createNonce } from "@adobe-mcp/protocol";

export type BridgeState = "discovered" | "connecting" | "ready" | "busy" | "degraded" | "disconnected" | "expired";
export interface BridgeDescriptor { app: AppId; transport: "uxp" | "cep" | "jsx" | "com" | "aerender"; appVersion: string; instanceId: string; sessionId?: string; pid?: number; capabilities: readonly string[]; limits: { maxInFlightReads: number; maxInFlightWrites: number; maxFrameBytes: number }; }
export interface InspectRequest { target: TargetRef; fields?: readonly string[]; depth?: number; cursor?: string; }
export interface InspectResult { target: TargetRef; revision: string; data: Record<string, unknown>; }
export interface MutationRequest { target: TargetRef; commands: readonly Record<string, unknown>[]; options: MutationOptions; }
export interface ExportRequest { target: TargetRef; destination: { grantId: string; access: "write" | "read-write"; suggestedName?: string }; options: Record<string, unknown>; mutation: MutationOptions; }
export interface PreviewCaptureRequest { target: TargetRef; format: "png" | "jpeg"; maxDimension: number; time?: { ticks: string; timebase: string }; }
export interface VisualVerifyRequest { target: TargetRef; baselineImageBase64: string; tolerance: number; time?: { ticks: string; timebase: string }; }
export interface VisualVerifyResult { match: boolean; diffScore: number; currentImageBase64?: string; details: Record<string, unknown>; }
export interface AdobeBridge { readonly descriptor: BridgeDescriptor; connect(): Promise<void>; health(): Promise<BridgeState>; inspect(request: InspectRequest): Promise<InspectResult>; capturePreview(request: PreviewCaptureRequest): Promise<PreviewCaptureData>; verifyVisual(request: VisualVerifyRequest): Promise<VisualVerifyResult>; mutate(request: MutationRequest): Promise<OperationReceipt>; export(request: ExportRequest): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }>; exportLayers(input: PhotoshopLayerExportSpec): Promise<PhotoshopLayerExportResult>; exportArtboards(input: import("@adobe-mcp/schemas").IllustratorArtboardExport): Promise<IllustratorArtboardExportResult>; applyPreset(input: import("@adobe-mcp/schemas").AfterEffectsPresetApply): Promise<AfterEffectsPresetApplyResult>; executeEditPlan(input: import("@adobe-mcp/schemas").PremiereEditPlan): Promise<PremiereEditPlanResult>; snapshot(target: TargetRef): Promise<Snapshot>; restoreSnapshot(target: TargetRef, snapshotId: string): Promise<void>; readSnapshot?(target: TargetRef, snapshotId: string): Promise<Uint8Array>; verify(target: TargetRef, expectedRevision?: string): Promise<{ ok: boolean; revision: string; details?: Record<string, unknown> }>; cancel(jobId: string): Promise<Job>; close(): Promise<void>; }

type DecodedPixels = { format: "png" | "jpeg"; width: number; height: number; pixels?: Uint8Array };

function invalidImage(reason: string, currentImageBase64: string): VisualVerifyResult {
  return { match: false, diffScore: 1, currentImageBase64, details: { reason } };
}

function decodeBase64(value: string): Buffer {
  if (!value || typeof value !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error("invalid Base64");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const bytes = Buffer.from(padded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== normalized.replace(/=+$/, "")) throw new Error("invalid Base64");
  return bytes;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(bytes: Buffer): DecodedPixels {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error("invalid PNG magic bytes");
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0, seenIend = false;
  const idat: Buffer[] = [];
  let paletteValue: Buffer | undefined;
  let alphaTable: Buffer | undefined;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); offset += 4;
    if (offset + 4 + length + 4 > bytes.length) throw new Error("truncated PNG chunk");
    const type = bytes.toString("ascii", offset, offset + 4); offset += 4;
    const data = bytes.subarray(offset, offset + length); offset += length; offset += 4; // CRC is structurally consumed.
    if (type === "IHDR") {
      if (length !== 13 || width !== 0) throw new Error("invalid PNG IHDR");
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]!; colorType = data[9]!; interlace = data[12]!;
    } else if (type === "PLTE") paletteValue = Buffer.from(data);
    else if (type === "tRNS") alphaTable = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") { seenIend = true; break; }
  }
  if (!seenIend || width < 1 || height < 1 || !idat.length) throw new Error("invalid PNG structure");
  if (width > 16_384 || height > 16_384 || width * height > 64 * 1024 * 1024) throw new Error("PNG dimensions exceed safety limits");
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(colorType)) throw new Error("unsupported PNG pixel format");
  if (colorType === 3 && (!paletteValue || paletteValue.length % 3 !== 0)) throw new Error("invalid PNG palette");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("invalid PNG scanline data");
  const scanlines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!, rowOffset = y * stride, rawOffset = y * (stride + 1) + 1, previous = y ? scanlines.subarray(rowOffset - stride, rowOffset) : undefined;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? scanlines[rowOffset + x - channels]! : 0, up = previous?.[x] ?? 0, upLeft = x >= channels ? (previous?.[x - channels] ?? 0) : 0, value = raw[rawOffset + x]!;
      if (filter === 0) scanlines[rowOffset + x] = value;
      else if (filter === 1) scanlines[rowOffset + x] = (value + left) & 255;
      else if (filter === 2) scanlines[rowOffset + x] = (value + up) & 255;
      else if (filter === 3) scanlines[rowOffset + x] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) scanlines[rowOffset + x] = (value + paeth(left, up, upLeft)) & 255;
      else throw new Error("invalid PNG filter");
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const source = (y * stride) + x * channels, destination = (y * width + x) * 4, sample = scanlines[source]!;
    if (colorType === 6) pixels.set(scanlines.subarray(source, source + 4), destination);
    else if (colorType === 2) { pixels[destination] = sample; pixels[destination + 1] = scanlines[source + 1]!; pixels[destination + 2] = scanlines[source + 2]!; pixels[destination + 3] = 255; }
    else if (colorType === 4) { pixels[destination] = sample; pixels[destination + 1] = sample; pixels[destination + 2] = sample; pixels[destination + 3] = scanlines[source + 1]!; }
    else if (colorType === 0) { pixels[destination] = sample; pixels[destination + 1] = sample; pixels[destination + 2] = sample; pixels[destination + 3] = alphaTable?.[1] !== undefined && sample === alphaTable.readUInt16BE(0) ? 0 : 255; }
    else { const paletteOffset = sample * 3; if (!paletteValue || paletteOffset + 2 >= paletteValue.length) throw new Error("invalid PNG palette index"); pixels[destination] = paletteValue[paletteOffset]!; pixels[destination + 1] = paletteValue[paletteOffset + 1]!; pixels[destination + 2] = paletteValue[paletteOffset + 2]!; pixels[destination + 3] = alphaTable?.[sample] ?? 255; }
  }
  return { format: "png", width, height, pixels };
}

function decodeJpegHeader(bytes: Buffer): DecodedPixels {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("invalid JPEG magic bytes");
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]; if (marker === undefined) break;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) throw new Error("truncated JPEG segment");
    const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) throw new Error("invalid JPEG segment");
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) throw new Error("invalid JPEG frame header");
      return { format: "jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new Error("JPEG dimensions not found");
}

function decodeImage(value: string): { bytes: Buffer; image: DecodedPixels } {
  const bytes = decodeBase64(value);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { bytes, image: decodePng(bytes) };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, image: decodeJpegHeader(bytes) };
  throw new Error("unsupported image magic bytes");
}

/** Validates an encoded PNG/JPEG and returns the dimensions encoded in its header. */
export function decodeImageDimensions(value: string): { format: "png" | "jpeg"; width: number; height: number } {
  const image = decodeImage(value).image;
  return { format: image.format, width: image.width, height: image.height };
}

export function compareBase64Images(baselineImageBase64: string, currentImageBase64: string, tolerance: number): VisualVerifyResult {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) return invalidImage("tolerance must be a finite number between 0 and 1", currentImageBase64);
  let baseline: { bytes: Buffer; image: DecodedPixels }, current: { bytes: Buffer; image: DecodedPixels };
  try { baseline = decodeImage(baselineImageBase64); } catch (error) { return invalidImage(`baseline: ${error instanceof Error ? error.message : "invalid image"}`, currentImageBase64); }
  try { current = decodeImage(currentImageBase64); } catch (error) { return invalidImage(`current: ${error instanceof Error ? error.message : "invalid image"}`, currentImageBase64); }
  if (baseline.image.format !== current.image.format) return invalidImage(`image formats differ (${baseline.image.format} vs ${current.image.format})`, currentImageBase64);
  if (baseline.image.width !== current.image.width || baseline.image.height !== current.image.height) return invalidImage(`image dimensions differ (${baseline.image.width}x${baseline.image.height} vs ${current.image.width}x${current.image.height})`, currentImageBase64);
  if (!baseline.image.pixels || !current.image.pixels) {
    const identical = baseline.bytes.equals(current.bytes);
    return { match: identical && 0 <= tolerance, diffScore: identical ? 0 : 1, currentImageBase64, details: { width: baseline.image.width, height: baseline.image.height, format: baseline.image.format, tolerance, reason: identical ? "JPEG byte-identical; native JPEG pixel decoder unavailable" : "JPEG pixel decoder unavailable" } };
  }
  let distance = 0;
  for (let index = 0; index < baseline.image.pixels.length; index += 1) distance += Math.abs(baseline.image.pixels[index]! - current.image.pixels[index]!);
  const pixelCount = baseline.image.width * baseline.image.height;
  const diffScore = distance / (4 * 255 * pixelCount);
  return { match: diffScore <= tolerance, diffScore, currentImageBase64, details: { width: baseline.image.width, height: baseline.image.height, format: baseline.image.format, pixels: pixelCount, tolerance } };
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, Set<string>>();
  register(instanceId: string, capabilities: readonly string[]): void { this.capabilities.set(instanceId, new Set(capabilities)); }
  unregister(instanceId: string): void { this.capabilities.delete(instanceId); }
  has(instanceId: string, capability: string): boolean { return this.capabilities.get(instanceId)?.has(capability) ?? false; }
  require(instanceId: string, required: readonly string[]): void { const missing = required.filter((capability) => !this.has(instanceId, capability)); if (missing.length) throw new Error(`UNSUPPORTED_CAPABILITY: ${missing.join(",")}`); }
  list(instanceId: string): string[] { return [...(this.capabilities.get(instanceId) ?? [])].sort(); }
}

export class BridgeLifecycleManager {
  private readonly states = new Map<string, BridgeState>();
  private readonly bridges = new Map<string, AdobeBridge>();
  register(bridge: AdobeBridge): void { this.bridges.set(bridge.descriptor.instanceId, bridge); this.states.set(bridge.descriptor.instanceId, "discovered"); }
  unregister(instanceId: string): void { this.bridges.delete(instanceId); this.states.delete(instanceId); }
  state(instanceId: string): BridgeState | undefined { return this.states.get(instanceId); }
  list(): readonly AdobeBridge[] { return [...this.bridges.values()]; }
  async connectedSessions(): Promise<readonly (BridgeDescriptor & { health: BridgeState })[]> {
    const sessions = await Promise.all([...this.bridges.values()].filter((bridge) => !bridge.descriptor.instanceId.endsWith("-unavailable")).map(async (bridge) => ({ ...bridge.descriptor, sessionId: bridge.descriptor.sessionId ?? bridge.descriptor.instanceId, health: await bridge.health() })));
    return sessions;
  }
  async connect(instanceId: string): Promise<void> { const bridge = this.get(instanceId); this.states.set(instanceId, "connecting"); try { await bridge.connect(); this.states.set(instanceId, "ready"); } catch (error) { this.states.set(instanceId, "degraded"); throw error; } }
  async closeAll(): Promise<void> { await Promise.all([...this.bridges].map(async ([id, bridge]) => { await bridge.close(); this.states.set(id, "disconnected"); })); }
  select(target: TargetRef): AdobeBridge { const candidates = [...this.bridges.values()].filter((bridge) => bridge.descriptor.app === target.app && (!target.instanceId || bridge.descriptor.instanceId === target.instanceId) && this.states.get(bridge.descriptor.instanceId) === "ready"); if (candidates.length !== 1) throw new Error(candidates.length === 0 ? "BRIDGE_UNAVAILABLE" : "AMBIGUOUS_TARGET"); return candidates[0]!; }
  private get(instanceId: string): AdobeBridge { const bridge = this.bridges.get(instanceId); if (!bridge) throw new Error("BRIDGE_UNAVAILABLE"); return bridge; }
}

export class IdempotencyStore<T> {
  private readonly values = new Map<string, { inputHash: string; value: T; expiresAt: number }>();
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) { if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("INVALID_ARGUMENT: ttlMs must be a positive safe integer"); }
  get(operationId: string, inputHash?: string): T | undefined { const entry = this.values.get(operationId); if (!entry) return undefined; if (entry.expiresAt < Date.now()) { this.values.delete(operationId); return undefined; } if (inputHash !== undefined && entry.inputHash !== inputHash) throw new Error("CONFLICT: operationId reused with different payload"); return entry.value; }
  set(operationId: string, value: T, inputHash = ""): void { const existing = this.values.get(operationId); if (existing && existing.inputHash !== inputHash) throw new Error("CONFLICT: operationId reused with different payload"); this.values.set(operationId, { inputHash, value, expiresAt: Date.now() + this.ttlMs }); }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
export function inputHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

export interface StoredSnapshot { readonly snapshot: Snapshot; readonly sha256: string; readonly bytes?: Uint8Array; }
/** Content-addressed snapshot metadata/artifact store used by mutation pipelines. */
export class SnapshotStore {
  private readonly records = new Map<string, StoredSnapshot>();
  put(snapshot: Snapshot, bytes?: Uint8Array): StoredSnapshot {
    if (!snapshot.verified || snapshot.artifact.sha256 !== snapshot.sha256) throw new Error("SNAPSHOT_FAILED: snapshot is not verified");
    if (bytes) {
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== snapshot.sha256) throw new Error("SNAPSHOT_FAILED: snapshot content hash mismatch");
    }
    const stored: StoredSnapshot = { snapshot, sha256: snapshot.sha256, ...(bytes ? { bytes: new Uint8Array(bytes) } : {}) };
    this.records.set(snapshot.id, stored);
    return stored;
  }
  get(snapshotId: string): StoredSnapshot | undefined { const stored = this.records.get(snapshotId); if (!stored?.bytes) return stored; const digest = createHash("sha256").update(stored.bytes).digest("hex"); if (digest !== stored.sha256) throw new Error("SNAPSHOT_FAILED: stored snapshot integrity check failed"); return stored; }
  require(snapshotId: string): StoredSnapshot { const stored = this.get(snapshotId); if (!stored) throw new Error("NOT_FOUND: snapshot"); return stored; }
}

export interface LockLease { key: string; token: string; expiresAt: number; }
export class LockManager {
  private readonly locks = new Map<string, LockLease>();
  acquire(keys: readonly string[], ttlMs = 30_000): LockLease[] { if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("INVALID_ARGUMENT: ttlMs must be a positive safe integer"); const ordered = [...new Set(keys)]; if (ordered.some((key) => !key)) throw new Error("INVALID_ARGUMENT: lock keys must be non-empty"); ordered.sort(); const now = Date.now(); for (const key of ordered) { const current = this.locks.get(key); if (current && current.expiresAt > now) throw new Error(`LOCKED: ${key}`); } const leases = ordered.map((key) => ({ key, token: createNonce(16), expiresAt: now + ttlMs })); leases.forEach((lease) => this.locks.set(lease.key, lease)); return leases; }
  release(leases: readonly LockLease[]): void { for (const lease of leases) if (this.locks.get(lease.key)?.token === lease.token) this.locks.delete(lease.key); }
  sweep(now = Date.now()): void { for (const [key, lease] of this.locks) if (lease.expiresAt <= now) this.locks.delete(key); }
}

export abstract class BaseMockBridge implements AdobeBridge {
  protected state: BridgeState = "disconnected";
  protected revision = "rev-0";
  private readonly jobs = new Map<string, Job>();
  private readonly operationReceipts = new Map<string, OperationReceipt>();
  private readonly operationHashes = new Map<string, string>();
  private readonly snapshots = new Map<string, { bytes: Buffer; revision: string; sha256: string }>();
  abstract readonly descriptor: BridgeDescriptor;
  async connect(): Promise<void> { this.state = "ready"; }
  async health(): Promise<BridgeState> { return this.state; }
  async inspect(request: InspectRequest): Promise<InspectResult> { return { target: request.target, revision: this.revision, data: { app: this.descriptor.app, instanceId: this.descriptor.instanceId, fields: request.fields ?? ["id", "revision"] } }; }
  async capturePreview(request: PreviewCaptureRequest): Promise<PreviewCaptureData> {
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    // The in-memory bridge only embeds a PNG fixture; never mislabel those bytes as JPEG.
    return { imageBase64: pixel, mimeType: "image/png", width: 1, height: 1, revision: this.revision, capturedAt: new Date().toISOString() };
  }
  async verifyVisual(request: VisualVerifyRequest): Promise<VisualVerifyResult> { const current = await this.capturePreview({ target: request.target, format: "png", maxDimension: 4096, ...(request.time ? { time: request.time } : {}) }); return compareBase64Images(request.baselineImageBase64, current.imageBase64, request.tolerance); }
  async mutate(request: MutationRequest): Promise<OperationReceipt> { const hash = inputHash(request); const cached = this.operationReceipts.get(request.options.operationId); if (cached) { if (this.operationHashes.get(request.options.operationId) !== hash) throw new Error("CONFLICT: operationId reused with different payload"); return cached; } if (request.options.expectedRevision && request.options.expectedRevision !== this.revision) throw new Error("CONFLICT"); if (!request.options.dryRun) this.revision = `rev-${Date.now()}`; const receipt = { status: request.options.dryRun ? "planned" : "applied", previousRevision: request.options.expectedRevision ?? "rev-0", revision: this.revision, appliedIndexes: request.options.dryRun ? [] : request.commands.map((_, i) => i), failedIndexes: [], tempIdMap: {}, compensations: [], verification: request.options.verification === "none" ? "skipped" : "passed" } as OperationReceipt; this.operationHashes.set(request.options.operationId, hash); this.operationReceipts.set(request.options.operationId, receipt); return receipt; }
  async export(request: ExportRequest): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> { const receipt = await this.mutate({ target: request.target, commands: [], options: request.mutation }); return { artifact: { artifactId: `artifact-${Date.now()}`, kind: "file", displayName: request.destination.suggestedName ?? "export.bin" }, receipt }; }
  async exportLayers(input: PhotoshopLayerExportSpec): Promise<PhotoshopLayerExportResult> { PhotoshopLayerExportSpec.parse(input); return PhotoshopLayerExportResult.parse({ manifest: { version: "1", sourceDocumentId: input.target.documentId ?? "active", entries: [] }, artifacts: [] }); }
  async exportArtboards(input: import("@adobe-mcp/schemas").IllustratorArtboardExport): Promise<IllustratorArtboardExportResult> { IllustratorArtboardExport.parse(input); return IllustratorArtboardExportResult.parse({ manifest: { version: "1", entries: [] }, artifacts: [] }); }
  async applyPreset(input: import("@adobe-mcp/schemas").AfterEffectsPresetApply): Promise<AfterEffectsPresetApplyResult> { AfterEffectsPresetApply.parse(input); return AfterEffectsPresetApplyResult.parse({ applied: true, presetId: input.presetId, layerId: input.layerId, modifiedProperties: [] }); }
  async executeEditPlan(input: import("@adobe-mcp/schemas").PremiereEditPlan): Promise<PremiereEditPlanResult> { const plan = PremiereEditPlan.parse(input); return PremiereEditPlanResult.parse({ appliedOperations: plan.operations.length, timelineRevision: this.revision, summary: { status: "applied", operationCount: plan.operations.length } }); }
  async snapshot(target: TargetRef): Promise<Snapshot> { const bytes = Buffer.from(canonical({ app: this.descriptor.app, instanceId: this.descriptor.instanceId, target, revision: this.revision, state: "base-bridge" })); const sha256 = createHash("sha256").update(bytes).digest("hex"); const id = `snapshot-${Date.now()}-${createNonce(6)}`; this.snapshots.set(id, { bytes, revision: this.revision, sha256 }); const artifactId = `artifact-${id}`; return { id, target, revision: this.revision, createdAt: new Date().toISOString(), sha256, artifact: { artifactId, kind: "snapshot", displayName: "bridge-state-snapshot", sha256, provenance: { app: target.app } }, verified: this.snapshots.get(id)?.bytes.length === bytes.length && sha256 === createHash("sha256").update(bytes).digest("hex") }; }
  async verify(_target: TargetRef, expectedRevision?: string): Promise<{ ok: boolean; revision: string }> { return { ok: !expectedRevision || expectedRevision === this.revision, revision: this.revision }; }
  async restoreSnapshot(target: TargetRef, snapshotId: string): Promise<void> { const stored = this.snapshots.get(snapshotId); if (!stored || target.app !== this.descriptor.app || createHash("sha256").update(stored.bytes).digest("hex") !== stored.sha256) throw new Error("SNAPSHOT_FAILED: snapshot integrity check failed"); this.revision = stored.revision; }
  async readSnapshot(_target: TargetRef, snapshotId: string): Promise<Uint8Array> { const stored = this.snapshots.get(snapshotId); if (!stored) throw new Error("NOT_FOUND: snapshot"); return new Uint8Array(stored.bytes); }
  async cancel(jobId: string): Promise<Job> { const job = this.jobs.get(jobId); if (!job) throw new Error("NOT_FOUND"); const next = { ...job, status: "cancelled" as const, updatedAt: new Date().toISOString() }; this.jobs.set(jobId, next); return next; }
  async close(): Promise<void> { this.state = "disconnected"; }
}

export function createMockDescriptor(app: AppId, transport: BridgeDescriptor["transport"]): BridgeDescriptor { return { app, transport, appVersion: "mock", instanceId: `${app}-mock`, capabilities: ["state.read@1", "state.write@1", "preview.capture@1", "batch.atomic@1", "snapshot.create@1", "export.file@1"], limits: { maxInFlightReads: 8, maxInFlightWrites: 1, maxFrameBytes: 8 * 1024 * 1024 } }; }

export class MutationOrchestrator {
  private readonly plans = new Map<string, { operationId: string; inputHash: string; target: TargetRef; risk: string; createdAt: string }>();
  private readonly exportReceipts = new Map<string, { inputHash: string; result: { artifact: ArtifactRef; receipt: OperationReceipt } }>();
  constructor(private readonly idempotency = new IdempotencyStore<OperationReceipt>(), private readonly locks = new LockManager(), private readonly snapshots = new SnapshotStore()) {}
  async execute(bridge: AdobeBridge, request: MutationRequest, risk: "R0" | "R1" | "R2" | "R3" | "R4"): Promise<OperationReceipt> {
    const requestDigest = inputHash(request); const cached = this.idempotency.get(request.options.operationId, requestDigest); if (cached) return cached;
    this.plans.set(request.options.operationId, { operationId: request.options.operationId, inputHash: requestDigest, target: request.target, risk, createdAt: new Date().toISOString() });
    if (request.options.atomic && !bridge.descriptor.capabilities.includes("state.write@1")) throw new Error("UNSUPPORTED_CAPABILITY: state.write@1");
    const snapshot = await bridge.snapshot(request.target); const bytes = bridge.readSnapshot ? await bridge.readSnapshot(request.target, snapshot.id) : undefined; this.snapshots.put(snapshot, bytes);
    const keys = [request.target.documentId, request.target.projectId, request.target.entityId].filter((key): key is string => Boolean(key)); let leases: LockLease[] = [];
    try {
      leases = this.locks.acquire(keys.length ? keys : [`${request.target.app}:${bridge.descriptor.instanceId}`]);
      const receipt = await bridge.mutate(request); const verification = request.options.verification === "none" ? { ok: true, revision: receipt.revision ?? "" } : await bridge.verify(request.target, receipt.revision); if (!verification.ok) throw new Error("VERIFICATION_FAILED: postcondition failed; snapshot compensation attempted");
      const result = { ...receipt, snapshot, verification: request.options.verification === "none" ? "skipped" : "passed" } as OperationReceipt; this.idempotency.set(request.options.operationId, result, requestDigest); return result;
    } catch (error) { try { await bridge.restoreSnapshot(request.target, snapshot.id); } catch (rollbackError) { throw new Error(`ROLLBACK_FAILED: ${error instanceof Error ? error.message : "mutation failed"}; ${rollbackError instanceof Error ? rollbackError.message : "snapshot restore failed"}`); } throw error; } finally { this.locks.release(leases); }
  }
  async executeExport(bridge: AdobeBridge, request: ExportRequest, risk: "R0" | "R1" | "R2" | "R3" | "R4"): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> {
    const digest = inputHash(request); const cached = this.exportReceipts.get(request.mutation.operationId); if (cached) { if (cached.inputHash !== digest) throw new Error("CONFLICT: operationId reused with different payload"); return cached.result; }
    this.plans.set(request.mutation.operationId, { operationId: request.mutation.operationId, inputHash: digest, target: request.target, risk, createdAt: new Date().toISOString() });
    const snapshot = await bridge.snapshot(request.target); const bytes = bridge.readSnapshot ? await bridge.readSnapshot(request.target, snapshot.id) : undefined; this.snapshots.put(snapshot, bytes);
    const keys = [request.target.documentId, request.target.projectId, request.target.entityId].filter((key): key is string => Boolean(key)); let leases: LockLease[] = [];
    try {
      leases = this.locks.acquire(keys.length ? keys : [`${request.target.app}:${bridge.descriptor.instanceId}`]);
      const result = await bridge.export(request); if (!result.artifact.sha256) throw new Error("VERIFICATION_FAILED: export artifact is not content-addressed");
      const verification = request.mutation.verification === "none" ? { ok: true, revision: result.receipt.revision ?? "" } : await bridge.verify(request.target, result.receipt.revision); if (!verification.ok) throw new Error("VERIFICATION_FAILED: export postcondition failed");
      const final = { ...result, receipt: { ...result.receipt, snapshot, verification: request.mutation.verification === "none" ? "skipped" as const : "passed" as const } };
      this.exportReceipts.set(request.mutation.operationId, { inputHash: digest, result: final });
      return final;
    } catch (error) { try { await bridge.restoreSnapshot(request.target, snapshot.id); } catch (rollbackError) { throw new Error(`ROLLBACK_FAILED: ${error instanceof Error ? error.message : "export failed"}; ${rollbackError instanceof Error ? rollbackError.message : "snapshot restore failed"}`); } throw error; } finally { this.locks.release(leases); }
  }
}

/** A production descriptor used before a real panel registers. It never simulates success. */
export class UnavailableBridge implements AdobeBridge {
  readonly descriptor: BridgeDescriptor;
  constructor(app: AppId, transport: BridgeDescriptor["transport"]) { this.descriptor = { app, transport, appVersion: "unavailable", instanceId: `${app}-unavailable`, capabilities: [], limits: { maxInFlightReads: 8, maxInFlightWrites: 1, maxFrameBytes: 8 * 1024 * 1024 } }; }
  async connect(): Promise<void> { throw new Error("APP_NOT_RUNNING: no Adobe panel registered"); }
  async health(): Promise<BridgeState> { return "disconnected"; }
  async inspect(): Promise<InspectResult> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async capturePreview(): Promise<PreviewCaptureData> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async verifyVisual(): Promise<VisualVerifyResult> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async mutate(): Promise<OperationReceipt> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async export(): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async exportLayers(input: PhotoshopLayerExportSpec): Promise<PhotoshopLayerExportResult> { PhotoshopLayerExportSpec.parse(input); throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async exportArtboards(input: import("@adobe-mcp/schemas").IllustratorArtboardExport): Promise<IllustratorArtboardExportResult> { IllustratorArtboardExport.parse(input); throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async applyPreset(input: import("@adobe-mcp/schemas").AfterEffectsPresetApply): Promise<AfterEffectsPresetApplyResult> { AfterEffectsPresetApply.parse(input); throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async executeEditPlan(input: import("@adobe-mcp/schemas").PremiereEditPlan): Promise<PremiereEditPlanResult> { PremiereEditPlan.parse(input); throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async snapshot(): Promise<Snapshot> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async restoreSnapshot(): Promise<void> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async verify(): Promise<{ ok: boolean; revision: string }> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async cancel(): Promise<Job> { throw new Error("BRIDGE_UNAVAILABLE: no Adobe panel registered"); }
  async close(): Promise<void> { return; }
}
