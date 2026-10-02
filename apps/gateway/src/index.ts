import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { JsonRpcRequest, makeRpcError, computeAuthProof, localTokenPath, ProtocolVersion, readLocalToken } from "@adobe-mcp/protocol";
import type { JsonRpcResponse } from "@adobe-mcp/protocol";
import type { NormalizedError } from "@adobe-mcp/schemas";
import { discoverTools, getTool, riskForInput, INTERNAL_TOOL_CATALOG, PUBLIC_TOOL_CATALOG, TOOL_CATALOG, validateToolInput, validateToolOutput } from "@adobe-mcp/tool-catalog";
import { ToolDescribeInput, ToolDiscoveryInput, ToolDescribeResult, ToolDiscoveryResult } from "@adobe-mcp/schemas";
import { assertRiskAllowed, DEFAULT_POLICY, hashScope, loadPolicy, verifyApproval, consumeApprovalNonce } from "@adobe-mcp/policy";
import type { PolicyConfig } from "@adobe-mcp/policy";
const AFTER_EFFECTS_PRESET_RESOURCES = [
  { id: "effect.fast-blur", name: "Fast Blur", matchName: "ADBE Fast Blur", category: "effect", recipe: { blur: 12 }, version: "1" },
  { id: "effect.curves", name: "Curves", matchName: "ADBE CurvesCustom", category: "effect", recipe: { channel: "RGB" }, version: "1" },
  { id: "effect.color-balance", name: "Color Balance", matchName: "ADBE Color Balance", category: "effect", recipe: { preserveLuminosity: true }, version: "1" },
  { id: "animation.wiggle", name: "Procedural Wiggle", matchName: "ADBE Wiggle", category: "animation", recipe: { expression: "wiggle(frequency, amplitude)" }, version: "1" },
  { id: "animation.inertial-bounce", name: "Inertial Bounce", matchName: "ADBE Expression", category: "animation", recipe: { expression: "inertialBounce(amp, freq, decay)" }, version: "1" },
  { id: "camera.orbital-3d", name: "Orbital 3D Camera", matchName: "ADBE Camera", category: "camera", recipe: { rig: "orbit", threeD: true }, version: "1" },
  { id: "motion.motion-blur", name: "Motion Blur", matchName: "ADBE Motion Blur", category: "animation", recipe: { enabled: true }, version: "1" },
  { id: "tracking.null-parent", name: "Null Parent Tracking", matchName: "ADBE Layer Control", category: "tracking", recipe: { parent: "tracked-null" }, version: "1" },
] as const;
function listAfterEffectsPresetResources(): readonly { uri: string; name: string; mimeType: "application/json" }[] { return AFTER_EFFECTS_PRESET_RESOURCES.map((entry) => ({ uri: `adobe://aftereffects/presets/${entry.id}`, name: entry.name, mimeType: "application/json" })); }
function readAfterEffectsPresetResource(uri: string): string { const match = /^adobe:\/\/aftereffects\/presets\/([^/]+)$/.exec(uri); const entry = AFTER_EFFECTS_PRESET_RESOURCES.find((candidate) => candidate.id === match?.[1]); if (!entry) throw new Error("NOT_FOUND: After Effects preset resource"); return JSON.stringify(entry); }
const PROMPTS = [
  { name: "reframe-tiktok", description: "Convierte una secuencia 16:9 a 9:16 con seguimiento y verificación.", arguments: [{ name: "sequenceId", required: true }, { name: "target", required: false }] },
  { name: "podcast-cleanup", description: "Detecta silencios, aplica auto-ducking y ecualización declarativa.", arguments: [{ name: "sequenceId", required: true }, { name: "voiceTrackIndices", required: true }] },
  { name: "motion-graphic-bumper", description: "Compone un bumper de After Effects con textos animados y cámara 3D.", arguments: [{ name: "compId", required: true }, { name: "title", required: true }] },
  { name: "brand-vectorize", description: "Vectoriza un logotipo y extrae una paleta de color global.", arguments: [{ name: "imageArtifactUri", required: true }, { name: "preset", required: false }] }
] as const;
function dynamicResources(): readonly { uri: string; name: string; mimeType: "application/json" }[] {
  return [
    ...listAfterEffectsPresetResources(),
    { uri: "adobe://photoshop/active-document/hierarchy", name: "Photoshop active document hierarchy", mimeType: "application/json" },
    { uri: "adobe://premiere/active-sequence/timeline", name: "Premiere active sequence timeline", mimeType: "application/json" },
    { uri: "adobe://aftereffects/presets/catalog", name: "After Effects presets catalog", mimeType: "application/json" },
  ];
}
function readDynamicResource(uri: string): string {
  if (uri === "adobe://aftereffects/presets/catalog") return JSON.stringify({ version: "1", presets: AFTER_EFFECTS_PRESET_RESOURCES });
  if (uri === "adobe://photoshop/active-document/hierarchy") return JSON.stringify({ app: "photoshop", resource: "active-document/hierarchy", live: true, data: null });
  if (uri === "adobe://premiere/active-sequence/timeline") return JSON.stringify({ app: "premiere-pro", resource: "active-sequence/timeline", live: true, data: null });
  return readAfterEffectsPresetResource(uri);
}

export interface GatewayDaemonClient { call(method: string, params: Record<string, unknown>): Promise<unknown>; close?(): Promise<void>; }
const jsonRpcCode: Record<NormalizedError["code"], number> = { INVALID_ARGUMENT: -32602, UNAUTHENTICATED: -32001, PERMISSION_DENIED: -32003, APP_NOT_RUNNING: -32004, BRIDGE_UNAVAILABLE: -32005, UNSUPPORTED_CAPABILITY: -32006, AMBIGUOUS_TARGET: -32007, NOT_FOUND: -32008, CONFLICT: -32009, LOCKED: -32010, USER_CANCELLED: -32011, TIMEOUT: -32012, RATE_LIMITED: -32013, PARTIAL_FAILURE: -32014, HOST_ERROR: -32015, EXPORT_FAILED: -32016, VERIFICATION_FAILED: -32017, SNAPSHOT_FAILED: -32018, INTERNAL: -32603 };
function codeFrom(error: unknown): NormalizedError["code"] { if (error instanceof Error && error.name === "ZodError") return "INVALID_ARGUMENT"; const message = error instanceof Error ? error.message : ""; const candidate = message.split(":", 1)[0] as NormalizedError["code"]; return candidate in jsonRpcCode ? candidate : "INTERNAL"; }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
function mcpToolResult(value: unknown): { content: McpContent[]; isError?: boolean } {
  if (value && typeof value === "object" && "ok" in value && (value as { ok?: unknown }).ok === true) {
    const data = (value as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const imageData = data as { imageBase64?: unknown; currentImageBase64?: unknown; mimeType?: unknown };
      const imageBase64 = typeof imageData.imageBase64 === "string" ? imageData.imageBase64 : typeof imageData.currentImageBase64 === "string" ? imageData.currentImageBase64 : undefined;
      const mimeType = typeof imageData.mimeType === "string" ? imageData.mimeType : imageBase64 ? "image/png" : undefined;
      if (imageBase64 && mimeType) {
        const safeValue = { ...(value as Record<string, unknown>), data: Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([key]) => key !== "imageBase64" && key !== "currentImageBase64")) };
        return { content: [{ type: "image", data: imageBase64, mimeType }, { type: "text", text: JSON.stringify(safeValue) }] };
      }
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...((value && typeof value === "object" && "ok" in value && (value as { ok?: unknown }).ok === false) ? { isError: true } : {}) };
}

/** Authenticated Gateway -> Daemon WebSocket client. The token never enters the URL. */
export class WebSocketDaemonClient implements GatewayDaemonClient {
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private readonly pending = new Map<string, Pending>();
  private authenticated = false;
  private readonly instanceId = `gateway-${randomUUID()}`;
  constructor(private readonly token: string, private readonly endpoint = `ws://127.0.0.1:${Number(process.env.ADOBE_MCP_DAEMON_PORT ?? 49152)}`, private readonly timeoutMs = 10_000) {}
  async call(method: string, params: Record<string, unknown>): Promise<unknown> { await this.connect(); const id = randomUUID(); const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject })); try { this.socket!.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id, method, params } })); } catch (error) { this.pending.delete(id); throw error instanceof Error ? error : new Error("BRIDGE_UNAVAILABLE: daemon socket write failed"); } return this.withTimeout(result); }
  async close(): Promise<void> { this.authenticated = false; for (const pending of this.pending.values()) pending.reject(new Error("BRIDGE_UNAVAILABLE: daemon disconnected")); this.pending.clear(); this.socket?.close(); this.socket = undefined; }
  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.endpoint, { headers: { Origin: "null" }, maxPayload: 8 * 1024 * 1024 }); this.socket = socket; let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); };
      const timer = setTimeout(() => { socket.close(); fail(new Error("TIMEOUT: daemon authentication timed out")); }, this.timeoutMs);
      socket.on("error", (error) => fail(error instanceof Error ? error : new Error("BRIDGE_UNAVAILABLE: daemon socket error")));
      socket.on("close", () => { this.authenticated = false; fail(new Error("BRIDGE_UNAVAILABLE: daemon closed connection")); });
      socket.on("message", (raw) => { try { const value = JSON.parse(raw.toString()) as { type?: string; request?: Record<string, unknown>; method?: string; params?: Record<string, unknown>; id?: string | number; result?: unknown; error?: { message?: string } }; if (value.method === "auth.challenge" && value.params) { const clientNonce = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""); const proof = computeAuthProof(this.token, clientNonce, String(value.params.serverNonce), String(value.params.sessionId)); socket.send(JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "bridge.hello", params: { protocolVersion: ProtocolVersion, instanceId: this.instanceId, client: { kind: "gateway", app: "photoshop", appVersion: "gateway" }, capabilities: [], auth: { scheme: "challenge-hmac", clientNonce }, proof } })); return; } const request = value.type === "rpc" && value.request ? value.request : value; if (request && request.id !== undefined && request.result && typeof request.result === "object" && "protocolVersion" in (request.result as object)) { this.authenticated = true; if (!settled) { settled = true; clearTimeout(timer); resolve(); } return; } if (request && request.id !== undefined) { const pending = this.pending.get(String(request.id)); if (!pending) return; this.pending.delete(String(request.id)); if (request.error) pending.reject(new Error(String((request.error as { message?: unknown }).message ?? "INTERNAL: daemon RPC failed"))); else pending.resolve(request.result); } } catch { fail(new Error("INVALID_ARGUMENT: daemon sent malformed frame")); } });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async withTimeout<T>(promise: Promise<T>): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("TIMEOUT: daemon request timed out")), this.timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
}

export class GatewayServer {
  private readonly usedApprovalNonces = new Set<string>();
  constructor(private readonly daemon: GatewayDaemonClient, private readonly timeoutMs = 30_000, readonly policy: PolicyConfig = DEFAULT_POLICY, private readonly approvalSecret?: string) {}
  listTools(): readonly string[] { return PUBLIC_TOOL_CATALOG.map((tool) => tool.name); }
  async handle(request: unknown): Promise<JsonRpcResponse> {
    const parsed = JsonRpcRequest.safeParse(request); if (!parsed.success) return this.error(null, "INVALID_ARGUMENT", "Invalid JSON-RPC request", "gateway"); const id = parsed.data.id; const method = parsed.data.method;
    if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: dynamicResources() } };
    if (method === "resources/read") { const uri = (parsed.data.params ?? {}).uri; if (typeof uri !== "string") return this.error(id, "INVALID_ARGUMENT", "resource uri required", String(id)); return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "application/json", text: readDynamicResource(uri) }] } }; }
    if (method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };
    if (method === "prompts/get") { const name = (parsed.data.params ?? {}).name; const prompt = PROMPTS.find((candidate) => candidate.name === name); if (!prompt) return this.error(id, "NOT_FOUND", "prompt not found", String(id)); const args = ((parsed.data.params ?? {}).arguments ?? {}) as Record<string, unknown>; const text = `${prompt.description}\n\nInput: ${JSON.stringify(args)}\nSuggested operations: use adobe.tools.discover, adobe.operations.plan and adobe.operations.execute.`; return { jsonrpc: "2.0", id, result: { description: prompt.description, messages: [{ role: "user", content: { type: "text", text } }] } }; }
    if (method === "adobe.tools.discover") { const input = ToolDiscoveryInput.parse(parsed.data.params ?? {}); const tools = discoverTools(input).map((tool) => ({ name: tool.name, description: tool.description, ...(tool.app ? { app: tool.app } : {}), categories: [...(tool.categories ?? [])], risk: tool.risk, mutating: tool.mutating, verification: tool.verification ?? "implemented", requiredCapabilities: [...tool.requiredCapabilities] })); const data = ToolDiscoveryResult.parse({ tools, total: tools.length }); return { jsonrpc: "2.0", id, result: { ok: true, data } }; }
    if (method === "adobe.tools.describe") { const input = ToolDescribeInput.parse(parsed.data.params ?? {}); const tool = getTool(input.name); const data = ToolDescribeResult.parse({ tool: { name: tool.name, description: tool.description, ...(tool.app ? { app: tool.app } : {}), categories: [...(tool.categories ?? [])], risk: tool.risk, mutating: tool.mutating, verification: tool.verification ?? "implemented", requiredCapabilities: [...tool.requiredCapabilities] }, inputSchema: tool.inputJsonSchema, outputSchema: tool.outputJsonSchema, examples: (tool.examples ?? []).map((example) => ({ title: "Example", input: example })), limitations: [...(tool.limitations ?? [])] }); return { jsonrpc: "2.0", id, result: { ok: true, data } }; }
    if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2026-07-28", serverInfo: { name: "adobe-mcp", version: "0.2.0" }, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: true }, prompts: { listChanged: false } } } };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: PUBLIC_TOOL_CATALOG.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputJsonSchema, outputSchema: tool.outputJsonSchema })) } };
    try { if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "adobe-mcp", version: "0.1.0" }, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } } } }; if (method === "notifications/initialized") return { jsonrpc: "2.0", id, result: {} }; if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOL_CATALOG.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputJsonSchema })) } }; if (method === "tools/call") { const params = parsed.data.params ?? {}; if (typeof params.name !== "string") throw new Error("INVALID_ARGUMENT: tool name required"); const response = await this.callTool(params.name, (params.arguments ?? {}) as Record<string, unknown>, id); return response.result && !("error" in response) ? { ...response, result: mcpToolResult(response.result) } : response; } const response = await this.callTool(method, parsed.data.params ?? {}, id); return response; } catch (error) { const code = codeFrom(error); const safeMessage = code === "INTERNAL" ? "Internal error" : error instanceof Error ? error.message.slice(0, 2048) : "Request failed"; if (method === "tools/call") { const normalized: NormalizedError = { code, message: safeMessage, requestId: String(id).slice(0, 256), retryable: ["TIMEOUT", "RATE_LIMITED", "BRIDGE_UNAVAILABLE"].includes(code), details: {}, appliedOperationIds: [] }; return { jsonrpc: "2.0", id, result: mcpToolResult({ ok: false, error: normalized }) }; } return this.error(id, code, safeMessage, String(id)); }
  }
  private async callTool(name: string, rawInput: Record<string, unknown>, id: string | number): Promise<JsonRpcResponse> { const tool = getTool(name); const input = validateToolInput(name, rawInput) as Record<string, unknown>; const risk = riskForInput(name, input); const options = (input.options ?? input.mutation ?? {}) as { approvalToken?: string; explicitConfirmation?: boolean }; const supplied = (input.approval ?? options.approvalToken) as unknown; const hasApproval = supplied !== undefined; if (risk === "R3" || risk === "R4") { if (!hasApproval || !this.approvalSecret || !input.plan || typeof input.plan !== "object") throw new Error("PERMISSION_DENIED: R3/R4 approval must be bound to a stored plan"); const token: unknown = typeof supplied === "string" ? JSON.parse(supplied) : supplied; const plan = input.plan as { planHash?: unknown; scope?: { entities: number; files: number; bytes: number; minutes: number }; risk?: string }; if (typeof plan.planHash !== "string" || !plan.scope || typeof plan.risk !== "string") throw new Error("PERMISSION_DENIED: approval token is not bound to a plan"); const verified = verifyApproval(token, { planHash: plan.planHash, scopeHash: hashScope(plan.scope), risk }, this.approvalSecret); consumeApprovalNonce(verified, this.usedApprovalNonces); } assertRiskAllowed(risk, false, hasApproval, options.explicitConfirmation === true); const result = await this.withTimeout(this.daemon.call(name, input), this.timeoutMs); const checked = validateToolOutput(name, result); return { jsonrpc: "2.0", id, result: checked }; }
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("TIMEOUT: daemon request timed out")), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
  async serveStdio(): Promise<void> { const rl = createInterface({ input: process.stdin, crlfDelay: Infinity }); for await (const line of rl) { if (!line.trim()) continue; let request: unknown; try { request = JSON.parse(line); } catch { process.stdout.write(JSON.stringify(this.error(null, "INVALID_ARGUMENT", "Malformed JSON", "gateway")) + "\n"); continue; } process.stdout.write(JSON.stringify(await this.handle(request)) + "\n"); } }
  private error(id: JsonRpcResponse["id"], code: NormalizedError["code"], message: string, requestId: string): JsonRpcResponse { const normalized: NormalizedError = { code, message, requestId: requestId.slice(0, 256), retryable: ["TIMEOUT", "RATE_LIMITED", "BRIDGE_UNAVAILABLE"].includes(code), details: {}, appliedOperationIds: [] }; return makeRpcError(id, normalized); }
}
export { DEFAULT_POLICY };
if (import.meta.url === `file://${process.argv[1]}`) { const daemon = new WebSocketDaemonClient(readLocalToken(localTokenPath())); const policyPath = join(process.cwd(), "adobe-mcp.policy.json"); const policy = existsSync(policyPath) ? loadPolicy(policyPath) : DEFAULT_POLICY; await new GatewayServer(daemon, 30_000, policy, process.env.ADOBE_MCP_APPROVAL_SECRET).serveStdio(); }
