import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { BridgeLifecycleManager, CapabilityRegistry, compareBase64Images, inputHash, LockManager, MutationOrchestrator, UnavailableBridge } from "@adobe-mcp/bridge-core";
import type { AdobeBridge, BridgeDescriptor, BridgeState, InspectResult, MutationRequest, ExportRequest, VisualVerifyRequest, VisualVerifyResult } from "@adobe-mcp/bridge-core";
import { computeAuthProof, createLocalToken, createNonce, Frame, isLoopbackHost, loadOrCreateLocalToken, ProtocolVersion, verifyAuthProof, BridgeHello } from "@adobe-mcp/protocol";
import { getTool, riskForInput, validateToolInput, validateToolOutput, TOOL_NAMES } from "@adobe-mcp/tool-catalog";
import { assertRiskAllowed, hashPlan, hashScope, verifyApproval, consumeApprovalNonce } from "@adobe-mcp/policy";
import { DurableJobStore, OperationStore } from "@adobe-mcp/jobs";
import { AfterEffectsExpressionControl, AfterEffectsPresetApply, AfterEffectsPresetApplyResult, AfterEffectsRenderAdvanced, AfterEffectsShapeCreate, AfterEffectsTextAnimate, IllustratorArtboardExport, IllustratorArtboardExportResult, IllustratorImageTrace, IllustratorSwatchesCreate, IllustratorVariableTypography, OperationsExecuteInput, PhotoshopChannelMask, PhotoshopLayerExportAdvanced, PhotoshopLayerExportResult, PhotoshopLayerExportSpec, PhotoshopLayerStyle, PhotoshopSmartSelection, PlanHandle, PremiereEditPlan, PremiereEditPlanResult, PremiereLumetriGrade, PremiereMogrtParametrize, PremiereProjectOrganize, PremiereEditPlan as LegacyPremiereEditPlan, type ArtifactRef, type Job, type MutationOptions, type OperationReceipt, type Plan, type Snapshot, type TargetRef } from "@adobe-mcp/schemas";

interface DaemonStoredArtifact { readonly sha256: string; readonly uri: string; readonly sizeBytes: number; readonly mediaType?: string; readonly createdAt: string; readonly immutable: true; readonly provenance: Record<string, unknown>; }

/** Fallback store for raw UXP export payloads arriving directly at the daemon. */
class DaemonArtifactStore {
  constructor(private readonly root = process.env.ADOBE_MCP_ARTIFACT_ROOT ?? join(tmpdir(), "adobe-mcp", "artifacts")) {}
  private dataPath(sha256: string): string { return join(this.root, "sha256", sha256.slice(0, 2), sha256); }
  private metadataPath(sha256: string): string { return `${this.dataPath(sha256)}.json`; }
  async put(bytes: Uint8Array, mediaType: string | undefined, provenance: Record<string, unknown>): Promise<DaemonStoredArtifact> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uri = `artifact://sha256-${sha256}`;
    const metadata: DaemonStoredArtifact = { sha256, uri, sizeBytes: bytes.byteLength, ...(mediaType ? { mediaType } : {}), createdAt: new Date().toISOString(), immutable: true, provenance };
    const dataPath = this.dataPath(sha256);
    await mkdir(dirname(dataPath), { recursive: true });
    try { await writeFile(dataPath, bytes, { flag: "wx" }); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(dataPath); if (createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("INTERNAL: content-addressed collision detected");
    }
    try { await writeFile(this.metadataPath(sha256), JSON.stringify(metadata), { flag: "wx" }); return metadata; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stored = JSON.parse(await readFile(this.metadataPath(sha256), "utf8")) as DaemonStoredArtifact;
      if (stored.sha256 !== sha256 || stored.uri !== uri || stored.sizeBytes !== bytes.byteLength) throw new Error("VERIFICATION_FAILED: canonical artifact metadata does not match stored bytes");
      return stored;
    }
  }
}

class PanelBridge implements AdobeBridge {
  private static readonly sessionIds = new WeakMap<object, string>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly artifactStore = new DaemonArtifactStore();
  readonly descriptor: BridgeDescriptor;
  constructor(private readonly socket: WebSocket, descriptor: BridgeDescriptor) { this.descriptor = { ...descriptor, sessionId: descriptor.sessionId ?? PanelBridge.sessionIds.get(socket) ?? randomUUID() }; }
  static bindSession(socket: WebSocket, sessionId: string): string { PanelBridge.sessionIds.set(socket, sessionId); return sessionId; }
  async connect(): Promise<void> { return; }
  async health(): Promise<BridgeState> { return this.socket.readyState === WebSocket.OPEN ? "ready" : "disconnected"; }
  async inspect(request: { target: TargetRef; fields?: readonly string[]; depth?: number; cursor?: string }): Promise<InspectResult> { return this.call("bridge.inspect", request) as Promise<InspectResult>; }
  async capturePreview(request: { target: TargetRef; format: "png" | "jpeg"; maxDimension: number; time?: { ticks: string; timebase: string } }): Promise<import("@adobe-mcp/schemas").PreviewCaptureData> { return this.call("bridge.preview.capture", request) as Promise<import("@adobe-mcp/schemas").PreviewCaptureData>; }
  async verifyVisual(request: VisualVerifyRequest): Promise<VisualVerifyResult> { const current = await this.capturePreview({ target: request.target, format: "png", maxDimension: 4096, ...(request.time ? { time: request.time } : {}) }); return compareBase64Images(request.baselineImageBase64, current.imageBase64, request.tolerance); }
  async mutate(request: MutationRequest): Promise<OperationReceipt> { return this.call("bridge.mutate", request) as Promise<OperationReceipt>; }
  async export(request: ExportRequest): Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }> { return this.call("bridge.export", request) as Promise<{ artifact: ArtifactRef; receipt: OperationReceipt }>; }
  async exportLayers(input: import("@adobe-mcp/schemas").PhotoshopLayerExportSpec): Promise<import("@adobe-mcp/schemas").PhotoshopLayerExportResult> {
    const parsed = PhotoshopLayerExportSpec.parse(input); const raw = await this.call("bridge.exportLayers", parsed); try { return PhotoshopLayerExportResult.parse(raw); } catch (error) {
      const candidate = raw && typeof raw === "object" ? raw as { layerBytes?: unknown } : {}; if (!Array.isArray(candidate.layerBytes)) throw error;
      const entries: Record<string, unknown>[] = []; const artifacts: ArtifactRef[] = [];
      for (const item of candidate.layerBytes) {
        if (!item || typeof item !== "object") throw new Error("EXPORT_FAILED: invalid Photoshop layer bytes");
        const value = item as { layerId?: unknown; name?: unknown; format?: unknown; bytesBase64?: unknown; mediaType?: unknown };
        if (typeof value.layerId !== "string" || typeof value.bytesBase64 !== "string") throw new Error("EXPORT_FAILED: layer export is missing id or bytes");
        const bytes = Buffer.from(value.bytesBase64, "base64"); const format = String(value.format ?? parsed.format); const name = String(value.name ?? value.layerId); const stored = await this.artifactStore.put(bytes, typeof value.mediaType === "string" ? value.mediaType : `image/${format}`, { app: "photoshop", layerId: value.layerId, sourceDocumentId: parsed.target.documentId ?? "active" });
        const artifact = { artifactId: `photoshop-layer-${stored.sha256.slice(0, 16)}`, kind: "file" as const, displayName: `${name}.${format}`, mediaType: stored.mediaType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, provenance: { app: "photoshop" as const } }; artifacts.push(artifact); entries.push({ layerId: value.layerId, name, fileName: artifact.displayName, uri: stored.uri, sha256: stored.sha256, sizeBytes: stored.sizeBytes });
      }
      return PhotoshopLayerExportResult.parse({ manifest: { version: "1", sourceDocumentId: parsed.target.documentId ?? "active", entries }, artifacts });
    }
  }
  async exportArtboards(input: import("@adobe-mcp/schemas").IllustratorArtboardExport): Promise<import("@adobe-mcp/schemas").IllustratorArtboardExportResult> {
    const parsed = IllustratorArtboardExport.parse(input); const raw = await this.call("bridge.exportArtboards", parsed); try { return IllustratorArtboardExportResult.parse(raw); } catch (error) {
      const candidate = raw && typeof raw === "object" ? raw as { artboards?: unknown } : {}; if (!Array.isArray(candidate.artboards)) throw error;
      const entries: Record<string, unknown>[] = []; const artifacts: ArtifactRef[] = [];
      for (const item of candidate.artboards) {
        if (!item || typeof item !== "object") throw new Error("EXPORT_FAILED: invalid Illustrator artboard bytes");
        const value = item as { id?: unknown; name?: unknown; width?: unknown; height?: unknown; bytesBase64?: unknown; mediaType?: unknown };
        if (typeof value.id !== "string" || typeof value.bytesBase64 !== "string") throw new Error("EXPORT_FAILED: artboard export is missing id or bytes");
        const bytes = Buffer.from(value.bytesBase64, "base64"); const extension = parsed.format; const name = String(value.name ?? value.id); const stored = await this.artifactStore.put(bytes, typeof value.mediaType === "string" ? value.mediaType : extension === "svg" ? "image/svg+xml" : "image/png", { app: "illustrator", artboardId: value.id });
        const artifact = { artifactId: `illustrator-artboard-${stored.sha256.slice(0, 16)}`, kind: "file" as const, displayName: `${name}.${extension}`, mediaType: stored.mediaType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, provenance: { app: "illustrator" as const } }; artifacts.push(artifact); entries.push({ artboardId: value.id, name, width: value.width, height: value.height, fileName: artifact.displayName, uri: stored.uri, sha256: stored.sha256, sizeBytes: stored.sizeBytes });
      }
      return IllustratorArtboardExportResult.parse({ manifest: { version: "1", format: parsed.format, entries }, artifacts });
    }
  }
  async applyPreset(input: import("@adobe-mcp/schemas").AfterEffectsPresetApply): Promise<import("@adobe-mcp/schemas").AfterEffectsPresetApplyResult> { return AfterEffectsPresetApplyResult.parse(await this.call("bridge.preset.apply", AfterEffectsPresetApply.parse(input))) as import("@adobe-mcp/schemas").AfterEffectsPresetApplyResult; }
  async executeEditPlan(input: import("@adobe-mcp/schemas").PremiereEditPlan): Promise<import("@adobe-mcp/schemas").PremiereEditPlanResult> { return PremiereEditPlanResult.parse(await this.call("bridge.editPlan.execute", PremiereEditPlan.parse(input))) as import("@adobe-mcp/schemas").PremiereEditPlanResult; }
  async snapshot(target: TargetRef): Promise<Snapshot> { return this.call("bridge.snapshot", { target }) as Promise<Snapshot>; }
  async restoreSnapshot(target: TargetRef, snapshotId: string): Promise<void> { await this.call("bridge.restoreSnapshot", { target, snapshotId }); }
  async verify(target: TargetRef, expectedRevision?: string): Promise<{ ok: boolean; revision: string }> { return this.call("bridge.verify", { target, expectedRevision }) as Promise<{ ok: boolean; revision: string }>; }
  async cancel(jobId: string): Promise<Job> { return this.call("bridge.cancel", { jobId }) as Promise<Job>; }
  async close(): Promise<void> { for (const pending of this.pending.values()) pending.reject(new Error("BRIDGE_UNAVAILABLE: panel disconnected")); this.pending.clear(); }
  handleResponse(response: { id: string | number | null; result?: unknown; error?: { message: string } }): void { const pending = this.pending.get(String(response.id)); if (!pending) return; this.pending.delete(String(response.id)); if (response.error) pending.reject(new Error(response.error.message)); else pending.resolve(response.result); }
  private call(method: string, params: unknown): Promise<unknown> { return new Promise((resolve, reject) => { const id = randomUUID(); this.pending.set(id, { resolve, reject }); try { this.socket.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id, method, params } })); } catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error("BRIDGE_UNAVAILABLE")); } }); }
}

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;
const success = (data: unknown) => ({ ok: true as const, data });
function errorCode(error: unknown): string { const code = error instanceof Error ? (error.message.split(":", 1)[0] ?? "INTERNAL") : "INTERNAL"; return /^[A-Z_]+$/.test(code) ? code : "INTERNAL"; }

export class LocalBridgeDaemon {
  readonly lifecycle = new BridgeLifecycleManager();
  readonly capabilities = new CapabilityRegistry();
  readonly locks = new LockManager();
  private readonly pipeline = new MutationOrchestrator(undefined, this.locks);
  private readonly operations: OperationStore<unknown>;
  private readonly operationStorePath: string;
  private readonly operationStoreReady: Promise<void>;
  private operationPersistence: Promise<void> = Promise.resolve();
  private readonly jobs: DurableJobStore;
  private readonly server = createServer();
  private readonly websocket: WebSocketServer;
  private readonly token: string;
  private readonly maxFrameBytes: number;
  private readonly configuredPort: number;
  private port = 0;
  private readonly usedClientNonces = new Set<string>();
  private readonly usedApprovalNonces = new Set<string>();
  private readonly approvalSecret: string;
  private readonly handlers: Readonly<Record<string, ToolHandler>>;
  constructor(token?: string, private readonly allowedOrigins: readonly string[] = ["null"], maxFrameBytes = 8 * 1024 * 1024, operationStorePath = process.env.ADOBE_MCP_OPERATION_STORE_PATH ?? join(tmpdir(), "adobe-mcp", "operations.json"), operationStore?: OperationStore<unknown>) {
    this.token = token ?? (process.env.ADOBE_MCP_DAEMON_TOKEN ?? (process.env.NODE_ENV === "test" ? createLocalToken() : loadOrCreateLocalToken())); this.approvalSecret = process.env.ADOBE_MCP_APPROVAL_SECRET ?? this.token; this.maxFrameBytes = maxFrameBytes; this.configuredPort = Number(process.env.ADOBE_MCP_DAEMON_PORT ?? (process.env.NODE_ENV === "test" ? 0 : 49152));
    this.operations = operationStore ?? new OperationStore<unknown>(); this.operationStorePath = operationStorePath; this.operationStoreReady = this.loadOperationStore(); this.jobs = new DurableJobStore(process.env.ADOBE_MCP_JOB_STORE_PATH ?? join(tmpdir(), "adobe-mcp", "jobs.json"));
    for (const bridge of [new UnavailableBridge("photoshop", "uxp"), new UnavailableBridge("illustrator", "uxp"), new UnavailableBridge("after-effects", "jsx"), new UnavailableBridge("premiere-pro", "uxp")]) this.lifecycle.register(bridge);
    this.handlers = this.createHandlers();
    this.websocket = new WebSocketServer({ server: this.server, maxPayload: maxFrameBytes });
    this.websocket.on("connection", (socket, request) => { const origin = request.headers.origin ?? "null"; if (!isLoopbackHost(request.socket.remoteAddress ?? "") || !this.allowedOrigins.includes(origin)) { socket.close(1008, "origin or address not allowed"); return; } this.attach(socket); });
  }
  get authToken(): string { return this.token; }
  async start(port = this.configuredPort): Promise<number> { await new Promise<void>((resolve, reject) => { const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); }; const onListening = () => { this.server.off("error", onError); resolve(); }; this.server.once("error", onError); this.server.once("listening", onListening); this.server.listen(port, "127.0.0.1"); }); const address = this.server.address(); this.port = typeof address === "object" && address ? address.port : 0; return this.port; }
  async stop(): Promise<void> { this.websocket.close(); await this.lifecycle.closeAll(); if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve())); }
  get endpoint(): string { return `ws://127.0.0.1:${this.port}`; }
  get operationStore(): OperationStore<unknown> { return this.operations; }

  private createHandlers(): Readonly<Record<string, ToolHandler>> {
    const publicInput = (input: Record<string, unknown>): Record<string, unknown> => { const { __tool: _internalTool, ...payload } = input; return payload; };
    const read = async (input: Record<string, unknown>) => success((await this.bridgeFor(input).inspect({ target: input.target as TargetRef, ...((input.options as Record<string, unknown> | undefined) ?? {}) })).data);
    const mutate = async (input: Record<string, unknown>) => { const tool = String(input.__tool); const bridge = this.bridgeFor(input); const options = (input.options ?? input.mutation) as MutationOptions; const request: MutationRequest = { target: input.target as TargetRef, commands: input.commands as readonly Record<string, unknown>[], options }; return success(await this.pipeline.execute(bridge, request, riskForInput(tool, input))); };
    const exportLayers = async (input: Record<string, unknown>) => { const bridge = this.bridgeFor(input); return success(await bridge.exportLayers(PhotoshopLayerExportSpec.parse(publicInput(input)))); };
    const exportArtboards = async (input: Record<string, unknown>) => { const bridge = this.bridgeFor(input); return success(await bridge.exportArtboards((await import("@adobe-mcp/schemas")).IllustratorArtboardExport.parse(publicInput(input)))); };
    const applyPreset = async (input: Record<string, unknown>) => { const bridge = this.bridgeFor(input); return success(await bridge.applyPreset(AfterEffectsPresetApply.parse(publicInput(input)))); };
    const executeEditPlan = async (input: Record<string, unknown>) => { const bridge = this.bridgeFor(input); return success(await bridge.executeEditPlan(PremiereEditPlan.parse(publicInput(input)))); };
    const advancedMutate = async (input: Record<string, unknown>) => { const bridge = this.bridgeFor(input); const options = (input.options ?? input.mutation) as MutationOptions; const tool = String(input.__tool); const result = await this.pipeline.execute(bridge, { target: input.target as TargetRef, commands: [{ op: "advanced", tool, payload: publicInput(input) }], options }, riskForInput(tool, input)); const revision = result.revision ?? "host-revision"; const operationId = options.operationId; const data: Record<string, unknown> = { applied: true, revision }; if (tool === "adobe.photoshop.selection.smart") data.selectionId = `selection-${operationId}`; else if (tool === "adobe.photoshop.layer.styles") { data.layerId = input.layerId; data.style = input.style; } else if (tool === "adobe.photoshop.channel.mask") data.channelId = input.channelId ?? `mask-${operationId}`; else if (tool === "adobe.premiere.mogrt.parametrize") data.updatedKeys = Array.isArray(input.parameters) ? input.parameters.map((parameter) => String((parameter as Record<string, unknown>).key)) : []; else if (tool === "adobe.premiere.lumetri.grade") { data.clips = Array.isArray(input.clipIds) ? input.clipIds.length : 0; data.manifestVersion = "lumetri-1"; } else if (tool === "adobe.premiere.project.organize") { data.bins = Array.isArray(input.createBins) ? input.createBins.length : 0; data.imports = Array.isArray(input.imports) ? input.imports.length : 0; } else if (tool === "adobe.aftereffects.shape.create") { data.groupId = String(input.groupName); data.modifiers = Object.keys((input.modifiers as Record<string, unknown> | undefined) ?? {}); } else if (tool === "adobe.aftereffects.text.animate") data.animatorId = `animator-${operationId}`; else if (tool === "adobe.aftereffects.expressionControl.add") data.effectId = `effect-${operationId}`; else if (tool === "adobe.illustrator.imageTrace") data.paths = 0; else if (tool === "adobe.illustrator.swatches.create") data.swatchIds = Array.isArray(input.colors) ? input.colors.map((_, index) => `swatch-${operationId}-${index}`) : []; else if (tool === "adobe.illustrator.typography.variable") data.textItemId = input.textItemId; return success(data); };
    const advancedExportLayers = async (input: Record<string, unknown>) => { if ("mutation" in input) return success(await this.bridgeFor(input).exportLayers(PhotoshopLayerExportSpec.parse(publicInput(input)))); const parsed = PhotoshopLayerExportAdvanced.parse(publicInput(input)); const bridge = this.bridgeFor(input); const legacy = PhotoshopLayerExportSpec.parse({ ...parsed, mutation: parsed.options }); const result = await bridge.exportLayers(legacy); const manifest = JSON.stringify(result.manifest); const digest = createHash("sha256").update(manifest).digest("hex"); const artifacts = result.artifacts.map((artifact) => { const uri = typeof artifact.sha256 === "string" ? `artifact://sha256-${artifact.sha256}` : `artifact://sha256-${createHash("sha256").update(artifact.artifactId).digest("hex")}`; return { layerId: artifact.artifactId, name: artifact.displayName, uri, sha256: artifact.sha256 ?? digest, mediaType: artifact.mediaType ?? "application/octet-stream" }; }); return success({ manifestUri: `artifact://sha256-${digest}`, artifacts }); };
    const advancedRender = async (input: Record<string, unknown>) => { const parsed = AfterEffectsRenderAdvanced.parse(publicInput(input)); const bridge = this.bridgeFor({ target: { app: "after-effects", entityId: parsed.comp ?? "active" } }); const legacy = { target: { app: "after-effects", entityId: parsed.comp ?? "active" }, destination: { grantId: "aerender-output", access: "write", suggestedName: parsed.outputPath }, options: { mode: "aerender", request: { projectPath: parsed.projectPath, outputPath: parsed.outputPath, ...(parsed.comp ? { comp: parsed.comp } : {}), ...(parsed.startFrame === undefined ? {} : { startFrame: parsed.startFrame }), ...(parsed.endFrame === undefined ? {} : { endFrame: parsed.endFrame }), ...(parsed.segmentSize === undefined ? {} : { segmentSize: parsed.segmentSize }), ...(parsed.renderSettingsTemplate === undefined ? {} : { settingsTemplate: parsed.renderSettingsTemplate }), ...(parsed.outputModuleTemplate === undefined ? {} : { outputModuleTemplate: parsed.outputModuleTemplate }) } }, mutation: parsed.options }; const result = await bridge.export(legacy as import("@adobe-mcp/bridge-core").ExportRequest); if (!result.artifact.sha256) throw new Error("VERIFICATION_FAILED: aerender output has no SHA-256"); return success({ artifactUri: `artifact://sha256-${result.artifact.sha256}`, sha256: result.artifact.sha256, segments: parsed.segmentSize && parsed.startFrame !== undefined && parsed.endFrame !== undefined ? Math.ceil((parsed.endFrame - parsed.startFrame + 1) / parsed.segmentSize) : 1 }); };
    const planExecute = async (input: Record<string, unknown>) => { const parsed = OperationsExecuteInput.parse(publicInput(input)); const plan = parsed.planHandle; const base = { planId: plan.planId, target: plan.target, toolName: plan.toolName, risk: plan.risk, scope: plan.scope, expectedRevisions: plan.expectedRevisions, expiresAt: plan.expiresAt, commandsDigest: plan.commandsDigest }; if (hashPlan(base) !== plan.planHash) throw new Error("PERMISSION_DENIED: plan hash mismatch"); if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error("CONFLICT: plan expired"); const bridge = this.bridgeFor({ target: plan.target }); const expected = plan.target.documentId ? plan.expectedRevisions[plan.target.documentId] : undefined; const verified = await bridge.verify(plan.target, expected === "unknown" ? undefined : expected); if (!verified.ok) throw new Error("CONFLICT: plan revision is stale"); if (parsed.options.dryRun) return success({ operationId: parsed.options.operationId, planHash: plan.planHash, status: "planned", receipt: { status: "planned" }, verification: { ok: true, revision: verified.revision } }); const receipt = await this.pipeline.execute(bridge, { target: plan.target, commands: plan.commands, options: parsed.options }, plan.risk); const after = await bridge.verify(plan.target); return success({ operationId: parsed.options.operationId, planHash: plan.planHash, status: "verified", receipt, verification: { ok: after.ok, revision: after.revision } }); };
    const exportTool = async (input: Record<string, unknown>) => { const tool = String(input.__tool); const bridge = this.bridgeFor(input); const mutation = (input.mutation ?? input.options) as MutationOptions; const result = await this.pipeline.executeExport(bridge, { target: input.target as TargetRef, destination: input.destination as ExportRequest["destination"], options: input, mutation }, riskForInput(tool, input)); if (result.receipt.job) await this.jobs.create(result.receipt.job); return success(result); };
    const handlers: Record<string, ToolHandler> = {
      "adobe.system.status": async (input) => { const target = input.target as TargetRef | undefined; const includeBridges = input.includeBridges !== false; const sessions = (await this.lifecycle.connectedSessions()).filter((session) => !target || (session.app === target.app && (!target.instanceId || session.instanceId === target.instanceId))); const bridges = includeBridges ? sessions.map((session) => ({ app: session.app, transport: session.transport, instanceId: session.instanceId, sessionId: session.sessionId, appVersion: session.appVersion, health: session.health, state: session.health, ...(session.pid === undefined ? {} : { pid: session.pid }), capabilities: [...session.capabilities] })) : []; return success({ status: sessions.some((bridge) => bridge.health === "ready" || bridge.health === "busy") ? "ready" : sessions.length ? "degraded" : "stopped", bridges }); },
      "adobe.preview.capture": async (input) => success(await this.bridgeFor(input).capturePreview(input as { target: TargetRef; format: "png" | "jpeg"; maxDimension: number; time?: { ticks: string; timebase: string } })),
      "adobe.verify.visual": async (input) => success(await this.bridgeFor(input).verifyVisual(input as unknown as VisualVerifyRequest)),
      "adobe.system.capabilities": async (input) => success(input.target ? { capabilities: this.capabilities.list(this.lifecycle.select(input.target as TargetRef).descriptor.instanceId) } : { capabilities: [] }),
      "adobe.system.activate": async (input) => { this.bridgeFor(input); return success({ activated: true, target: input.target }); },
      "adobe.state.inspect": read,
      "adobe.assets.grant": async (input) => success({ grantId: `grant-${randomUUID()}`, access: input.access, ...(input.suggestedName ? { suggestedName: input.suggestedName } : {}) }),
      "adobe.operations.plan": async (input) => success(this.makePlan(input)),
      "adobe.operations.execute": planExecute,
      "adobe.operations.undo": async () => { throw new Error("UNSUPPORTED_CAPABILITY: durable undo requires a host restore checkpoint"); },
      "adobe.jobs.get": async (input) => { await this.jobs.ready; const job = this.jobs.get(String(input.jobId)); if (!job) throw new Error("NOT_FOUND: job"); return success(job); },
      "adobe.jobs.cancel": async (input) => { await this.jobs.ready; const job = this.jobs.get(String(input.jobId)); if (!job) throw new Error("NOT_FOUND: job"); return success(await this.jobs.transition(job.id, "cancelled")); },
      "adobe.photoshop.inspect": read, "adobe.photoshop.document": read, "adobe.photoshop.layers.edit": mutate, "adobe.photoshop.layers.content": mutate, "adobe.photoshop.filters.apply": mutate, "adobe.photoshop.export": exportTool, "adobe.photoshop.exportLayers": advancedExportLayers, "adobe.photoshop.selection.smart": advancedMutate, "adobe.photoshop.layer.styles": advancedMutate, "adobe.photoshop.channel.mask": advancedMutate, "adobe.photoshop.transform.apply": advancedMutate, "adobe.photoshop.generative.fill": advancedMutate,
      "adobe.illustrator.inspect": read, "adobe.illustrator.document": read, "adobe.illustrator.objects.edit": mutate, "adobe.illustrator.text.edit": mutate, "adobe.illustrator.assets.place": mutate, "adobe.illustrator.export": exportTool, "adobe.illustrator.exportArtboards": exportArtboards, "adobe.illustrator.imageTrace": advancedMutate, "adobe.illustrator.swatches.create": advancedMutate, "adobe.illustrator.typography.variable": advancedMutate, "adobe.illustrator.symbols.manage": advancedMutate,
      "adobe.aftereffects.inspect": read, "adobe.aftereffects.project": mutate, "adobe.aftereffects.compositions.edit": mutate, "adobe.aftereffects.layers.edit": mutate, "adobe.aftereffects.keyframes.edit": mutate, "adobe.aftereffects.renderqueue.edit": mutate, "adobe.aftereffects.render": advancedRender, "adobe.aftereffects.preset.apply": applyPreset, "adobe.aftereffects.shape.create": advancedMutate, "adobe.aftereffects.text.animate": advancedMutate, "adobe.aftereffects.expressionControl.add": advancedMutate, "adobe.aftereffects.tracking.extract": advancedMutate,
      "adobe.premiere.inspect": read, "adobe.premiere.project.edit": mutate, "adobe.premiere.sequences.edit": mutate, "adobe.premiere.timeline.edit": mutate, "adobe.premiere.effects.edit": mutate, "adobe.premiere.markers.edit": mutate, "adobe.premiere.editPlan.execute": executeEditPlan, "adobe.premiere.export": exportTool, "adobe.premiere.mogrt.parametrize": advancedMutate, "adobe.premiere.lumetri.grade": advancedMutate, "adobe.premiere.project.organize": advancedMutate, "adobe.premiere.proxies.manage": advancedMutate, "adobe.premiere.transcript.sync": advancedMutate,
    };
    const daemonToolNames = TOOL_NAMES.filter((name) => name !== "adobe.tools.discover" && name !== "adobe.tools.describe");
    if (daemonToolNames.some((name) => !handlers[name])) throw new Error("INTERNAL: daemon tool dispatcher is incomplete");
    return handlers;
  }
  private lifecycleStates(app: TargetRef["app"]): BridgeState[] { return [...this.lifecycleInstances(app)].map((id) => this.lifecycle.state(id) ?? "disconnected"); }
  private lifecycleInstances(app: TargetRef["app"]): string[] { return ["photoshop", "illustrator", "after-effects", "premiere-pro"].filter((name) => name === app).map((name) => `${name}-unavailable`); }
  private bridgeFor(input: Record<string, unknown>): AdobeBridge { const target = input.target as TargetRef | undefined; if (!target) throw new Error("INVALID_ARGUMENT: target required for this tool"); return this.lifecycle.select(target); }
  private makePlan(input: Record<string, unknown>): PlanHandle { const commands = input.commands as readonly Record<string, unknown>[]; const target = input.target as TargetRef; const options = input.options as MutationOptions; const toolName = String(input.toolName); const commandsDigest = createHash("sha256").update(JSON.stringify(commands)).digest("hex"); const scope = { entities: commands.length, files: 0, bytes: 0, minutes: 1 }; const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString(); const expectedRevisions = target.documentId ? { [target.documentId]: options.expectedRevision ?? "unknown" } : {}; const withoutHash = { planId: `plan-${randomUUID()}`, target, toolName, risk: riskForInput(toolName, input), scope, expectedRevisions, expiresAt, commandsDigest }; const planHash = hashPlan(withoutHash); const snapshotHash = createHash("sha256").update(JSON.stringify({ target, expectedRevisions })).digest("hex"); const snapshot = { snapshotId: `snapshot-plan-${randomUUID()}`, revision: options.expectedRevision ?? "unknown", sha256: snapshotHash, artifactUri: `artifact://sha256-${snapshotHash}`, verified: false } as const; const preview = { summary: `${commands.length} command(s) prepared for ${toolName}`, diff: commands.map((command) => ({ op: command.op === "delete" ? "delete" : command.op === "export" ? "export" : command.op === "transform" ? "transform" : command.op === "set" ? "set" : command.op === "create" ? "create" : "invoke", ...(typeof command.entityId === "string" ? { entityId: command.entityId } : {}) })), estimated: scope, warnings: ["Host snapshot is verified at execute time."] }; return PlanHandle.parse({ ...withoutHash, planHash, commands, snapshot, preview, immutable: true }); }
  private async loadOperationStore(): Promise<void> { try { this.operations.list(); const serialized = await readFile(this.operationStorePath, "utf8"); const restored = OperationStore.fromJSON<unknown>(serialized); for (const record of restored.list()) { if (record.status === "completed" && record.result !== undefined) this.operations.complete(record.operationId, record.inputHash, record.result); else if (record.status === "failed") this.operations.fail(record.operationId, record.inputHash, record.error ?? { code: "INTERNAL", message: "operation failed" }, record.result); else this.operations.begin(record.operationId, record.inputHash); } } catch (error) { const code = error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : ""; if (code !== "ENOENT") throw error; } }
  private persistOperationStore(): Promise<void> { const write = this.operationPersistence.then(async () => { await mkdir(dirname(this.operationStorePath), { recursive: true }); const temporary = `${this.operationStorePath}.${randomUUID()}.tmp`; await writeFile(temporary, this.operations.serialize(), { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.operationStorePath); }); this.operationPersistence = write.catch(() => undefined); return write; }

  private attach(socket: WebSocket): void {
    const serverNonce = createNonce(); const sessionId = PanelBridge.bindSession(socket, randomUUID()); const expiresAt = Date.now() + 60_000; let authenticated = false; let lastSeen = Date.now(); let panel: PanelBridge | undefined; let gateway = false;
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "auth.challenge", params: { scheme: "challenge-hmac", serverNonce, sessionId, protocolVersion: ProtocolVersion, expiresAt: new Date(expiresAt).toISOString() } }));
    const heartbeat = setInterval(() => { if (Date.now() - lastSeen > 45_000) { socket.close(1001, "heartbeat timeout"); return; } if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 10_000);
    socket.on("close", () => { clearInterval(heartbeat); if (panel && this.lifecycle.list().some((bridge) => bridge === panel)) { this.lifecycle.unregister(panel.descriptor.instanceId); this.capabilities.unregister(panel.descriptor.instanceId); } }); socket.on("pong", () => { lastSeen = Date.now(); });
    socket.on("message", async (raw) => { try { const text = raw.toString(); if (Buffer.byteLength(text, "utf8") > this.maxFrameBytes) throw new Error("RATE_LIMITED: frame exceeds configured limit"); const value: unknown = JSON.parse(text); lastSeen = Date.now(); if (!authenticated) { const candidate = value as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }; if (candidate.jsonrpc !== "2.0" || candidate.method !== "bridge.hello" || typeof candidate.params !== "object" || candidate.params === null) throw new Error("UNAUTHENTICATED: bridge hello required"); const params = candidate.params as Record<string, unknown>; const hello = BridgeHello.parse(params); const proof = typeof params.proof === "string" ? params.proof : typeof (params.auth as Record<string, unknown> | undefined)?.proof === "string" ? String((params.auth as Record<string, unknown>).proof) : undefined; const clientNonce = hello.auth.clientNonce; if (this.usedClientNonces.has(clientNonce) || !proof || Date.now() > expiresAt || !verifyAuthProof(computeAuthProof(this.token, clientNonce, serverNonce, sessionId), proof)) throw new Error("UNAUTHENTICATED: invalid authentication proof"); this.usedClientNonces.add(clientNonce); authenticated = true; gateway = hello.client.kind === "gateway"; if (!gateway) { const transport = hello.client.kind === "com" ? "com" : hello.client.kind === "jsx" ? "jsx" : hello.client.kind === "aerender" ? "aerender" : hello.client.kind === "cep" ? "cep" : "uxp"; panel = new PanelBridge(socket, { app: hello.client.app, transport, appVersion: hello.client.appVersion, instanceId: hello.instanceId, capabilities: hello.capabilities, limits: { maxInFlightReads: 8, maxInFlightWrites: 1, maxFrameBytes: this.maxFrameBytes } }); this.lifecycle.register(panel); this.capabilities.register(hello.instanceId, hello.capabilities); await this.lifecycle.connect(hello.instanceId); } if (candidate.id !== undefined) socket.send(JSON.stringify({ jsonrpc: "2.0", id: candidate.id, result: { protocolVersion: ProtocolVersion, sessionId, expiresAt: new Date(Date.now() + 45_000).toISOString(), maxFrameBytes: this.maxFrameBytes } })); return; }
        const frame = Frame.parse(value); if (frame.type === "ping") { socket.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() })); return; } if (frame.type !== "rpc") return; if (panel && ("result" in frame.request || "error" in frame.request)) { panel.handleResponse(frame.request as { id: string | number | null; result?: unknown; error?: { message: string } }); return; } if (gateway && "method" in frame.request && "id" in frame.request) { const request = frame.request; try { const result = await this.routeRpc(request.method, request.params ?? {}); socket.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id: request.id, result } })); } catch (error) { socket.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message.slice(0, 2048) : "RPC failed" } } })); } }
      } catch (error) { socket.close(1008, error instanceof Error ? error.message.slice(0, 120) : "invalid frame"); } });
  }
  private async routeRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = getTool(method);
    let input: Record<string, unknown> | undefined;
    let operationId: string | undefined;
    let operationDigest: string | undefined;
    let operationStarted = false;
    try {
      input = validateToolInput(method, params) as Record<string, unknown>;
      const mutating = (tool as { mutating?: boolean }).mutating === true;
      const options = (input.options ?? input.mutation ?? {}) as { operationId?: string; approvalToken?: string; explicitConfirmation?: boolean };
      operationId = options.operationId;
      operationDigest = inputHash({ method, input });
      if (mutating && operationId) {
        await this.operationStoreReady;
        const existing = this.operations.getRecord(operationId, operationDigest);
        if (existing?.status === "completed" || existing?.status === "failed") {
          if (existing.result !== undefined) return existing.result;
          throw new Error(existing.error?.message ?? "CONFLICT: operation has no stored result");
        }
        if (existing?.status === "in_progress") throw new Error("CONFLICT: operation is already in progress");
        this.operations.begin(operationId, operationDigest);
        operationStarted = true;
        await this.persistOperationStore();
      }
      const risk = riskForInput(method, input);
      if (tool.requiredCapabilities.length > 0) this.capabilities.require(this.bridgeFor(input).descriptor.instanceId, tool.requiredCapabilities);
      const supplied = (input.approval ?? options.approvalToken) as unknown;
      if (risk === "R3" || risk === "R4") {
        if (!supplied || !input.plan || typeof input.plan !== "object") throw new Error("PERMISSION_DENIED: R3/R4 approval must be bound to a plan");
        const plan = input.plan as Plan;
        if (hashPlan({ planId: plan.planId, target: plan.target, toolName: plan.toolName, risk: plan.risk, scope: plan.scope, expectedRevisions: plan.expectedRevisions, expiresAt: plan.expiresAt, commandsDigest: plan.commandsDigest }) !== plan.planHash) throw new Error("PERMISSION_DENIED: plan hash mismatch");
        const approval = typeof supplied === "string" ? JSON.parse(supplied) : supplied;
        const verified = verifyApproval(approval, { planHash: plan.planHash, scopeHash: hashScope(plan.scope), risk }, this.approvalSecret);
        consumeApprovalNonce(verified, this.usedApprovalNonces);
      }
      assertRiskAllowed(risk, false, supplied !== undefined, options.explicitConfirmation === true);
      const handler = this.handlers[tool.name];
      if (!handler) throw new Error("INTERNAL: tool dispatcher is incomplete");
      const result = validateToolOutput(tool.name, await handler({ ...input, __tool: tool.name }));
      if (operationStarted && operationId && operationDigest) { this.operations.complete(operationId, operationDigest, result); await this.persistOperationStore(); }
      return result;
    } catch (error) {
      const normalized = { code: errorCode(error), message: error instanceof Error ? error.message.slice(0, 2048) : "Request failed", requestId: randomUUID(), retryable: ["TIMEOUT", "BRIDGE_UNAVAILABLE", "RATE_LIMITED"].includes(errorCode(error)), details: {}, appliedOperationIds: [] };
      const output = validateToolOutput(tool.name, { ok: false, error: normalized });
      if (operationStarted && operationId && operationDigest) { this.operations.fail(operationId, operationDigest, { code: normalized.code, message: normalized.message }, output); await this.persistOperationStore(); }
      return output;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) { const daemon = new LocalBridgeDaemon(process.env.ADOBE_MCP_DAEMON_TOKEN ?? loadOrCreateLocalToken()); await daemon.start(); process.stderr.write(`adobe-mcp daemon listening on ${daemon.endpoint}\n`); }
