const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const PROTOCOL_VERSION = "1.0";
const ALLOWED_METHODS = new Set([
  "bridge.inspect", "bridge.mutate", "bridge.export", "bridge.exportLayers", "bridge.exportArtboards", "bridge.preset.apply", "bridge.editPlan.execute", "bridge.preview.capture", "bridge.snapshot", "bridge.verify", "bridge.cancel",
  "premiere.inspect", "premiere.project.edit", "premiere.sequences.edit", "premiere.timeline.edit", "premiere.effects.edit", "premiere.markers.edit", "premiere.export",
  "premiere.editPlan.execute",
]);

export const PREMIERE_UXP_CAPABILITIES = [
  "state.read@1", "state.write@1", "project.read@1", "project.write@1", "sequence.read@1", "sequence.write@1",
  "timeline.read@1", "timeline.write@1", "timeline.razor@1", "timeline.slip@1", "timeline.ripple-delete@1", "timeline.speed@1", "timeline.mute@1",
  "markers.read@1", "markers.write@1", "effects.read@1", "effects.write@1", "effects.keyframes@1", "export.file@1", "export.premiere@1", "export.media-encoder@1",
  "snapshot.create@1", "preview.capture@1", "verification.timeline@1", "batch.atomic@1", "editPlan.execute@1", "edit-plan.execute@1", "timeline.transitions@1", "timeline.audio-keyframes@1", "timeline.captions@1",
] as const;

export interface PanelWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type TokenProvider = () => Promise<string> | string;
export type TokenSource = TokenProvider | string;
export type HmacProvider = (token: string, message: string) => Promise<string>;
export type SocketFactory = (endpoint: string) => PanelWebSocket;

export function assertLoopbackEndpoint(endpoint: string): void {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error("INVALID_ARGUMENT: daemon endpoint is not a URL"); }
  if (!["ws:", "wss:"].includes(parsed.protocol) || !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) throw new Error("PERMISSION_DENIED: panel may only connect to loopback daemon");
}

export interface UxpPremiereHost {
  inspect(payload: Record<string, unknown>): Promise<unknown>;
  mutate(payload: Record<string, unknown>): Promise<unknown>;
  export(payload: Record<string, unknown>): Promise<unknown>;
  capturePreview?(payload: Record<string, unknown>): Promise<unknown>;
  snapshot(payload: Record<string, unknown>): Promise<unknown>;
  verify(payload: Record<string, unknown>): Promise<unknown>;
  cancel(payload: Record<string, unknown>): Promise<unknown>;
  projectEdit?(payload: Record<string, unknown>): Promise<unknown>;
  sequenceEdit?(payload: Record<string, unknown>): Promise<unknown>;
  timelineEdit?(payload: Record<string, unknown>): Promise<unknown>;
  effectsEdit?(payload: Record<string, unknown>): Promise<unknown>;
  markersEdit?(payload: Record<string, unknown>): Promise<unknown>;
  editPlanExecute?(payload: Record<string, unknown>): Promise<unknown>;
}

export interface PremiereFrameSequence { readonly frameSize: { width: number; height: number }; readonly revision: string; readonly sequenceId?: string; readonly name?: string; exportFramePNG(timeSeconds: number, file: unknown, dimensions?: { width: number; height: number }): Promise<void>; exportFrameJPEG?(timeSeconds: number, file: unknown, dimensions?: { width: number; height: number }): Promise<void>; }
export interface PremierePreviewFile { read(options: { format: "base64" }): Promise<string>; delete?(): Promise<void>; }
export type PremierePreviewFileFactory = (name: string) => Promise<{ file: PremierePreviewFile; nativeFile: unknown }>;

export interface PremiereUxpRuntime {
  readonly project?: { readonly activeSequence?: PremiereFrameSequence };
  readonly app?: { readonly project?: { readonly activeSequence?: PremiereFrameSequence } };
  readonly createPreviewFile?: PremierePreviewFileFactory;
  readonly invoke?: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly timeline?: { applyOperation?(payload: Record<string, unknown>): Promise<unknown>; executeEditPlan?(payload: Record<string, unknown>): Promise<unknown>; inspect?(payload: Record<string, unknown>): Promise<unknown>; };
  readonly exporter?: { exportSequenceFrame(sequence: unknown, timeSeconds: number, filename: string, filepath: unknown, width: number, height: number): Promise<void>; };
}

/** Concrete UXP host adapter. It bootstraps the currently active sequence from Premiere's runtime. */
export class DefaultUxpPremiereHost implements UxpPremiereHost {
  private readonly preview: PremiereTimelinePreviewHandler;
  constructor(private readonly runtime: PremiereUxpRuntime = globalThis as unknown as PremiereUxpRuntime) {
    this.preview = new PremiereTimelinePreviewHandler(() => this.activeSequence(), async (name) => {
      if (!this.runtime.createPreviewFile) throw new Error("UNSUPPORTED_CAPABILITY: Premiere temporary-file API is unavailable");
      return this.runtime.createPreviewFile(name);
    });
  }
  async inspect(payload: Record<string, unknown>): Promise<unknown> {
    const sequence = this.requireSequence();
    return { target: payload.target, revision: sequence.revision, data: { sequence: { id: sequence.sequenceId ?? "active-sequence", name: sequence.name ?? "Active Sequence", width: sequence.frameSize.width, height: sequence.frameSize.height } } };
  }
  async capturePreview(payload: Record<string, unknown>): Promise<unknown> { return this.preview.capture(payload); }
  async mutate(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("bridge.mutate", payload); }
  async export(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("premiere.export", payload); }
  async snapshot(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("bridge.snapshot", payload); }
  async verify(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("bridge.verify", payload); }
  async cancel(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("bridge.cancel", payload); }
  async projectEdit(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("premiere.project.edit", payload); }
  async sequenceEdit(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("premiere.sequences.edit", payload); }
  async timelineEdit(payload: Record<string, unknown>): Promise<unknown> { if (this.runtime.timeline?.applyOperation) return this.runtime.timeline.applyOperation(payload); const sequence = this.requireSequence() as PremiereFrameSequence & { applyOperation?: (value: Record<string, unknown>) => Promise<unknown> }; if (sequence.applyOperation) return sequence.applyOperation(payload); return this.invoke("premiere.timeline.edit", payload); }
  async effectsEdit(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("premiere.effects.edit", payload); }
  async markersEdit(payload: Record<string, unknown>): Promise<unknown> { return this.invoke("premiere.markers.edit", payload); }
  async editPlanExecute(payload: Record<string, unknown>): Promise<unknown> { const value = this.runtime.timeline?.executeEditPlan ? await this.runtime.timeline.executeEditPlan(payload) : await this.invoke("premiere.editPlan.execute", payload); if (value && typeof value === "object" && "appliedOperations" in value) return value; const receipt = value && typeof value === "object" && "receipt" in value ? (value as { receipt: Record<string, unknown> }).receipt : value as Record<string, unknown>; return { appliedOperations: Array.isArray(receipt?.appliedIndexes) ? receipt.appliedIndexes.length : Array.isArray(payload.operations) ? payload.operations.length : 0, timelineRevision: String(receipt?.revision ?? "premiere-rev-unknown"), summary: { status: String(receipt?.status ?? "applied"), operationCount: Array.isArray(payload.operations) ? payload.operations.length : 0 } }; }
  private activeSequence(): PremiereFrameSequence | undefined { return this.runtime.project?.activeSequence ?? this.runtime.app?.project?.activeSequence; }
  private requireSequence(): PremiereFrameSequence { const sequence = this.activeSequence(); if (!sequence) throw new Error("NOT_FOUND: no active Premiere sequence"); return sequence; }
  private async invoke(method: string, payload: Record<string, unknown>): Promise<unknown> { if (!this.runtime.invoke) throw new Error("UNSUPPORTED_CAPABILITY: Premiere host operation is unavailable"); return this.runtime.invoke(method, payload); }
}

/** Host-side timeline capture used by the UXP panel implementation. */
export class PremiereTimelinePreviewHandler {
  constructor(private readonly sequence: () => PremiereFrameSequence | undefined, private readonly createFile: PremierePreviewFileFactory) {}
  async capture(payload: Record<string, unknown>): Promise<unknown> {
    const sequence = this.sequence(); if (!sequence) throw new Error("NOT_FOUND: no active Premiere sequence");
    const time = payload.time && typeof payload.time === "object" ? Number((payload.time as { ticks: string }).ticks) / Number((payload.time as { timebase: string }).timebase) : 0;
    if (!Number.isFinite(time)) throw new Error("INVALID_ARGUMENT: invalid preview time");
    const max = Math.max(64, Math.min(4096, Number(payload.maxDimension ?? 1024))); const scale = Math.min(1, max / Math.max(sequence.frameSize.width, sequence.frameSize.height));
    const width = Math.max(1, Math.round(sequence.frameSize.width * scale)); const height = Math.max(1, Math.round(sequence.frameSize.height * scale));
    const format = payload.format === "jpeg" ? "jpeg" : "png";
    if (format === "jpeg" && !sequence.exportFrameJPEG) throw new Error("UNSUPPORTED_CAPABILITY: Premiere JPEG frame export is unavailable");
    const file = await this.createFile(`adobe-mcp-preview-${Date.now()}.${format === "jpeg" ? "jpg" : "png"}`);
    try { if (format === "jpeg") await sequence.exportFrameJPEG!(time, file.nativeFile, { width, height }); else await sequence.exportFramePNG(time, file.nativeFile, { width, height }); return { imageBase64: await file.file.read({ format: "base64" }), mimeType: format === "jpeg" ? "image/jpeg" : "image/png", width, height, revision: sequence.revision, capturedAt: new Date().toISOString() }; }
    finally { try { await file.file.delete?.(); } catch { /* preview cleanup is best effort */ } }
  }
}

function randomBase64Url(bytes = 32): string {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function browserHmacSha256(token: string, message: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("UNSUPPORTED_CAPABILITY: WebCrypto HMAC is unavailable");
  const decoded = decodeBase64Url(token); const keyData = new ArrayBuffer(decoded.byteLength); new Uint8Array(keyData).set(decoded);
  const key = await globalThis.crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class UxpPremiereHandlers {
  constructor(private readonly host: UxpPremiereHost) {}
  async dispatch(method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) throw new Error("PERMISSION_DENIED: Premiere handler is not allowlisted");
    const handler = method === "bridge.inspect" || method === "premiere.inspect" ? this.host.inspect
      : method === "bridge.mutate" ? this.host.mutate
      : method === "bridge.export" || method === "premiere.export" ? this.host.export
      : method === "bridge.preview.capture" ? this.host.capturePreview
      : method === "bridge.snapshot" ? this.host.snapshot
      : method === "bridge.verify" ? this.host.verify
      : method === "bridge.cancel" ? this.host.cancel
      : method === "premiere.project.edit" ? this.host.projectEdit
      : method === "premiere.sequences.edit" ? this.host.sequenceEdit
      : method === "premiere.timeline.edit" ? this.host.timelineEdit
      : method === "premiere.effects.edit" ? this.host.effectsEdit
      : method === "premiere.markers.edit" ? this.host.markersEdit
      : method === "premiere.editPlan.execute" || method === "bridge.editPlan.execute" ? this.host.editPlanExecute
      : undefined;
    if (!handler) throw new Error("UNSUPPORTED_CAPABILITY: Premiere UXP handler is unavailable");
    return handler.call(this.host, payload);
  }
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; }

export interface UxpPanelOptions {
  endpoint: string;
  instanceId: string;
  appVersion: string;
  token: TokenSource;
  host?: UxpPremiereHost;
  socketFactory?: SocketFactory;
  hmac?: HmacProvider;
}

export class UxpPremierePanel {
  private socket: PanelWebSocket | undefined;
  private connected = false;
  private helloRequestId: string | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly handlers: UxpPremiereHandlers;
  private readonly socketFactory: SocketFactory;
  private readonly hmac: HmacProvider;
  constructor(private readonly options: UxpPanelOptions) {
    this.handlers = new UxpPremiereHandlers(options.host ?? new DefaultUxpPremiereHost());
    this.socketFactory = options.socketFactory ?? ((endpoint) => new WebSocket(endpoint) as unknown as PanelWebSocket);
    this.hmac = options.hmac ?? browserHmacSha256;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    assertLoopbackEndpoint(this.options.endpoint);
    const socket = this.socketFactory(this.options.endpoint); this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error("BRIDGE_UNAVAILABLE: UXP WebSocket disconnected"));
      socket.onerror = fail; socket.onclose = () => { this.connected = false; for (const pending of this.pending.values()) pending.reject(new Error("BRIDGE_UNAVAILABLE: UXP panel disconnected")); this.pending.clear(); };
      socket.onmessage = (event) => { void this.handleMessage(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data), resolve, reject); };
    });
    this.heartbeat = setInterval(() => this.sendRaw({ type: "ping", timestamp: new Date().toISOString() }), 10_000);
  }

  async reconnect(attempts = 5): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) { try { await this.connect(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100))); } }
    throw (lastError instanceof Error ? lastError : new Error("BRIDGE_UNAVAILABLE: reconnect failed"));
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) throw new Error("PERMISSION_DENIED: method is not allowlisted");
    if (!this.connected) throw new Error("BRIDGE_UNAVAILABLE: panel is not connected");
    const id = randomBase64Url(12);
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sendRaw({ jsonrpc: "2.0", id, method, params }); });
  }

  close(): void { if (this.heartbeat) clearInterval(this.heartbeat); this.socket?.close(); this.socket = undefined; this.connected = false; }

  private sendRaw(value: unknown): void { const text = JSON.stringify(value); if (new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) throw new Error("RATE_LIMITED: frame exceeds configured limit"); this.socket?.send(text); }
  private async handleMessage(text: string, resolveConnect: () => void, rejectConnect: (error: Error) => void): Promise<void> {
    if (new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) { rejectConnect(new Error("RATE_LIMITED: frame exceeds configured limit")); return; }
    let value: unknown; try { value = JSON.parse(text); } catch { rejectConnect(new Error("INVALID_ARGUMENT: invalid JSON frame")); return; }
    if (!value || typeof value !== "object") return;
    const frame = value as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown>; type?: string; request?: Record<string, unknown> };
    if (frame.method === "auth.challenge" && frame.params) {
      const clientNonce = randomBase64Url(); const serverNonce = String(frame.params.serverNonce ?? ""); const sessionId = String(frame.params.sessionId ?? ""); const token = typeof this.options.token === "function" ? await this.options.token() : this.options.token;
      const proof = await this.hmac(token, ["adobe-mcp", PROTOCOL_VERSION, clientNonce, serverNonce, sessionId].join("\0"));
      this.helloRequestId = randomBase64Url(12);
      this.sendRaw({ jsonrpc: "2.0", id: this.helloRequestId, method: "bridge.hello", params: { protocolVersion: PROTOCOL_VERSION, instanceId: this.options.instanceId, client: { kind: "uxp", app: "premiere-pro", appVersion: this.options.appVersion }, capabilities: [...PREMIERE_UXP_CAPABILITIES], auth: { scheme: "challenge-hmac", clientNonce }, proof } });
      return;
    }
    const request = frame.type === "rpc" ? frame.request : frame;
    if (!request) return;
    const requestValue = request as { id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    if (requestValue.method && requestValue.id !== undefined) {
      try { const result = await this.handlers.dispatch(requestValue.method, requestValue.params ?? {}); this.sendRaw({ jsonrpc: "2.0", id: requestValue.id, result }); } catch (error) { this.sendRaw({ jsonrpc: "2.0", id: requestValue.id, error: { code: -32000, message: error instanceof Error ? error.message.slice(0, 2048) : "HOST_ERROR" } }); }
      return;
    }
    if (requestValue.id !== undefined) {
      if (this.helloRequestId === String(requestValue.id)) { this.helloRequestId = undefined; if (requestValue.error) rejectConnect(new Error(requestValue.error.message ?? "UNAUTHENTICATED: bridge hello failed")); else { this.connected = true; resolveConnect(); } return; }
      const pending = this.pending.get(String(requestValue.id)); if (!pending) return; this.pending.delete(String(requestValue.id)); if (requestValue.error) pending.reject(new Error(requestValue.error.message ?? "RPC failed")); else pending.resolve(requestValue.result);
    }
  }
}

export function createUxpPremierePanel(options: UxpPanelOptions): UxpPremierePanel { return new UxpPremierePanel(options); }
