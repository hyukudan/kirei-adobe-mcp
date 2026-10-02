const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const PROTOCOL_VERSION = "1.0";
const ALLOWED_METHODS = new Set([
  "bridge.inspect", "bridge.mutate", "bridge.export", "bridge.snapshot", "bridge.verify", "bridge.cancel",
  "premiere.inspect", "premiere.project.edit", "premiere.sequences.edit", "premiere.timeline.edit", "premiere.effects.edit", "premiere.markers.edit", "premiere.export",
  "premiere.editPlan.execute",
]);

export const PREMIERE_CEP_CAPABILITIES = [
  "state.read@1", "state.write@1", "project.read@1", "project.write@1", "sequence.read@1", "sequence.write@1",
  "timeline.read@1", "timeline.write@1", "timeline.razor@1", "timeline.slip@1", "timeline.ripple-delete@1", "timeline.speed@1", "timeline.mute@1",
  "markers.read@1", "markers.write@1", "effects.read@1", "effects.write@1", "effects.keyframes@1", "export.file@1", "export.premiere@1", "export.media-encoder@1",
  "snapshot.create@1", "verification.timeline@1", "fallback.cep@1",
] as const;

export interface CepSocket { readonly readyState: number; onclose: (() => void) | null; onerror: (() => void) | null; onmessage: ((event: { data: string | ArrayBuffer }) => void) | null; send(data: string): void; close(): void; }
export type TokenProvider = () => Promise<string> | string;
export type TokenSource = TokenProvider | string;
export type HmacProvider = (token: string, message: string) => Promise<string>;
export type SocketFactory = (endpoint: string) => CepSocket;
export type EvalScript = (script: string, callback: (result: string) => void) => void;

export function assertLoopbackEndpoint(endpoint: string): void { let parsed: URL; try { parsed = new URL(endpoint); } catch { throw new Error("INVALID_ARGUMENT: daemon endpoint is not a URL"); } if (!["ws:", "wss:"].includes(parsed.protocol) || !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) throw new Error("PERMISSION_DENIED: panel may only connect to loopback daemon"); }

export const CEP_HANDLER_ALLOWLIST = {
  "bridge.inspect": "inspect", "premiere.inspect": "inspect", "bridge.mutate": "mutate", "bridge.export": "export",
  "premiere.export": "export", "bridge.snapshot": "snapshot", "bridge.verify": "verify", "bridge.cancel": "cancel",
  "premiere.project.edit": "projectEdit", "premiere.sequences.edit": "sequenceEdit", "premiere.timeline.edit": "timelineEdit",
  "premiere.effects.edit": "effectsEdit", "premiere.markers.edit": "markersEdit",
  "premiere.editPlan.execute": "editPlanExecute",
} as const;

export interface CepPremiereHost { invoke(handler: keyof typeof CEP_HANDLER_ALLOWLIST, payload: Record<string, unknown>): Promise<unknown>; }

/** The only script sent to ExtendScript is a fixed dispatcher plus JSON data. */
export function buildEvalScript(handler: keyof typeof CEP_HANDLER_ALLOWLIST, payload: Record<string, unknown>): string {
  if (!Object.prototype.hasOwnProperty.call(CEP_HANDLER_ALLOWLIST, handler)) throw new Error("PERMISSION_DENIED: CEP handler is not allowlisted");
  const encodedHandler = JSON.stringify(handler);
  const encodedPayload = JSON.stringify(payload);
  return `adobeMcpPremiere.dispatch(${encodedHandler},${encodedPayload})`;
}

export function createCepPremiereHost(evalScript: EvalScript): CepPremiereHost {
  return { invoke: (handler, payload) => new Promise((resolve, reject) => evalScript(buildEvalScript(handler, payload), (result) => { try { const value: unknown = JSON.parse(result); if (value && typeof value === "object" && "error" in value) reject(new Error(String((value as { error: unknown }).error))); else resolve(value); } catch (error) { reject(error instanceof Error ? error : new Error("HOST_ERROR: invalid CEP result")); } })) };
}

export class CepPremiereHandlers {
  constructor(private readonly host: CepPremiereHost) {}
  async dispatch(method: string, payload: Record<string, unknown>): Promise<unknown> { if (!Object.prototype.hasOwnProperty.call(CEP_HANDLER_ALLOWLIST, method)) throw new Error("PERMISSION_DENIED: Premiere CEP handler is not allowlisted"); return this.host.invoke(method as keyof typeof CEP_HANDLER_ALLOWLIST, payload); }
}

function randomBase64Url(bytes = 32): string { const values = new Uint8Array(bytes); globalThis.crypto.getRandomValues(values); let binary = ""; for (const value of values) binary += String.fromCharCode(value); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function decodeBase64Url(value: string): Uint8Array { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4); const binary = atob(padded); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
export async function browserHmacSha256(token: string, message: string): Promise<string> { if (!globalThis.crypto?.subtle) throw new Error("UNSUPPORTED_CAPABILITY: WebCrypto HMAC is unavailable"); const decoded = decodeBase64Url(token); const keyData = new ArrayBuffer(decoded.byteLength); new Uint8Array(keyData).set(decoded); const key = await globalThis.crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const digest = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)); let binary = ""; for (const value of new Uint8Array(digest)) binary += String.fromCharCode(value); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }

export interface CepPanelOptions { endpoint: string; instanceId: string; appVersion: string; token: TokenSource; host: CepPremiereHost; socketFactory?: SocketFactory; hmac?: HmacProvider; }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; }

export class CepPremierePanel {
  private socket: CepSocket | undefined; private connected = false; private helloRequestId: string | undefined; private readonly pending = new Map<string, Pending>(); private readonly handlers: CepPremiereHandlers; private readonly socketFactory: SocketFactory; private readonly hmac: HmacProvider; private heartbeat?: ReturnType<typeof setInterval>;
  constructor(private readonly options: CepPanelOptions) { this.handlers = new CepPremiereHandlers(options.host); this.socketFactory = options.socketFactory ?? ((endpoint) => new WebSocket(endpoint) as unknown as CepSocket); this.hmac = options.hmac ?? browserHmacSha256; }
  async connect(): Promise<void> { if (this.connected) return; assertLoopbackEndpoint(this.options.endpoint); const socket = this.socketFactory(this.options.endpoint); this.socket = socket; await new Promise<void>((resolve, reject) => { const fail = () => reject(new Error("BRIDGE_UNAVAILABLE: CEP WebSocket disconnected")); socket.onerror = fail; socket.onclose = () => { this.connected = false; for (const pending of this.pending.values()) pending.reject(new Error("BRIDGE_UNAVAILABLE: CEP panel disconnected")); this.pending.clear(); }; socket.onmessage = (event) => { void this.handleMessage(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data), resolve, reject); }; }); this.heartbeat = setInterval(() => this.send({ type: "ping", timestamp: new Date().toISOString() }), 10_000); }
  async reconnect(attempts = 5): Promise<void> { let lastError: unknown; for (let attempt = 0; attempt < attempts; attempt++) { try { await this.connect(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100))); } } throw (lastError instanceof Error ? lastError : new Error("BRIDGE_UNAVAILABLE: reconnect failed")); }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> { if (!ALLOWED_METHODS.has(method)) throw new Error("PERMISSION_DENIED: method is not allowlisted"); if (!this.connected) throw new Error("BRIDGE_UNAVAILABLE: panel is not connected"); const id = randomBase64Url(12); return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ jsonrpc: "2.0", id, method, params }); }); }
  close(): void { if (this.heartbeat) clearInterval(this.heartbeat); this.socket?.close(); this.socket = undefined; this.connected = false; }
  private send(value: unknown): void { const text = JSON.stringify(value); if (new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) throw new Error("RATE_LIMITED: frame exceeds configured limit"); this.socket?.send(text); }
  private async handleMessage(text: string, resolveConnect: () => void, rejectConnect: (error: Error) => void): Promise<void> { if (new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) { rejectConnect(new Error("RATE_LIMITED: frame exceeds configured limit")); return; } let value: unknown; try { value = JSON.parse(text); } catch { rejectConnect(new Error("INVALID_ARGUMENT: invalid JSON frame")); return; } if (!value || typeof value !== "object") return; const frame = value as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown>; type?: string; request?: Record<string, unknown> }; if (frame.method === "auth.challenge" && frame.params) { const clientNonce = randomBase64Url(); const token = typeof this.options.token === "function" ? await this.options.token() : this.options.token; const proof = await this.hmac(token, ["adobe-mcp", PROTOCOL_VERSION, clientNonce, String(frame.params.serverNonce ?? ""), String(frame.params.sessionId ?? "")].join("\0")); this.helloRequestId = randomBase64Url(12); this.send({ jsonrpc: "2.0", id: this.helloRequestId, method: "bridge.hello", params: { protocolVersion: PROTOCOL_VERSION, instanceId: this.options.instanceId, client: { kind: "cep", app: "premiere-pro", appVersion: this.options.appVersion }, capabilities: [...PREMIERE_CEP_CAPABILITIES], auth: { scheme: "challenge-hmac", clientNonce }, proof } }); return; } const request = frame.type === "rpc" ? frame.request : frame; if (!request) return; const message = request as { id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }; if (message.method && message.id !== undefined) { try { const result = await this.handlers.dispatch(message.method, message.params ?? {}); this.send({ jsonrpc: "2.0", id: message.id, result }); } catch (error) { this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message.slice(0, 2048) : "HOST_ERROR" } }); } return; } if (message.id !== undefined) { if (this.helloRequestId === String(message.id)) { this.helloRequestId = undefined; if (message.error) rejectConnect(new Error(message.error.message ?? "UNAUTHENTICATED: bridge hello failed")); else { this.connected = true; resolveConnect(); } return; } const pending = this.pending.get(String(message.id)); if (!pending) return; this.pending.delete(String(message.id)); if (message.error) pending.reject(new Error(message.error.message ?? "RPC failed")); else pending.resolve(message.result); } }
}

export function createCepPremierePanel(options: CepPanelOptions): CepPremierePanel { return new CepPremierePanel(options); }
