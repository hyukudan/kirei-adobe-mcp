import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z, AppId, ArtifactRef, OperationId } from "@adobe-mcp/schemas";
import type { NormalizedError, TargetRef } from "@adobe-mcp/schemas";

export const ProtocolVersion = "1.0" as const;
export const RpcId = z.union([z.string().min(1).max(128), z.number().int().nonnegative()]);
export const JsonRpcRequest = z.object({ jsonrpc: z.literal("2.0"), id: RpcId, method: z.string().min(1).max(256), params: z.record(z.string(), z.unknown()).optional() }).strict();
const JsonRpcSuccess = z.object({ jsonrpc: z.literal("2.0"), id: RpcId, result: z.unknown() }).strict();
const JsonRpcFailure = z.object({ jsonrpc: z.literal("2.0"), id: RpcId.nullable(), error: z.object({ code: z.number().int(), message: z.string().min(1).max(2048), data: z.unknown().optional() }).strict() }).strict();
export const JsonRpcResponse = z.union([JsonRpcSuccess, JsonRpcFailure]);
export const JsonRpcNotification = z.object({ jsonrpc: z.literal("2.0"), method: z.string().min(1).max(256), params: z.record(z.string(), z.unknown()).optional() }).strict();
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;
export type JsonRpcResponse = { jsonrpc: "2.0"; id: z.infer<typeof RpcId> | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

export const AuthChallenge = z.object({ scheme: z.literal("challenge-hmac"), clientNonce: z.string().min(16).max(256), proof: z.string().min(32).max(256).optional() }).strict();
export const BridgeHello = z.object({ protocolVersion: z.literal(ProtocolVersion), instanceId: z.string().min(1), client: z.object({ kind: z.enum(["uxp", "cep", "jsx", "com", "aerender", "gateway"]), app: AppId, appVersion: z.string().min(1) }).strict(), capabilities: z.array(z.string().regex(/^[a-z0-9.-]+@\d+$/)).max(256), auth: AuthChallenge, proof: z.string().min(32).max(256).optional() }).strict();
export const BridgeWelcome = z.object({ protocolVersion: z.literal(ProtocolVersion), sessionId: z.string().uuid(), serverNonce: z.string(), expiresAt: z.string().datetime(), maxFrameBytes: z.number().int().positive() }).strict();
export type BridgeHello = z.infer<typeof BridgeHello>; export type BridgeWelcome = z.infer<typeof BridgeWelcome>;

export const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rpc"), request: JsonRpcRequest.or(JsonRpcResponse).or(JsonRpcNotification) }).strict(),
  z.object({ type: z.literal("event"), event: z.object({ eventId: z.string().uuid(), name: z.string(), timestamp: z.string().datetime(), sequence: z.number().int().nonnegative(), sessionId: z.string().optional(), requestId: z.string().optional(), operationId: OperationId.optional(), payload: z.record(z.string(), z.unknown()) }).strict() }).strict(),
  z.object({ type: z.literal("artifact"), artifact: ArtifactRef, chunk: z.string(), offset: z.number().int().nonnegative(), final: z.boolean() }).strict(),
  z.object({ type: z.literal("ping"), timestamp: z.string().datetime() }).strict(),
  z.object({ type: z.literal("pong"), timestamp: z.string().datetime() }).strict()
]);
export type Frame = z.infer<typeof Frame>;

export const EventName = z.enum(["bridge.connected", "bridge.disconnected", "host.activeChanged", "document.changed", "job.changed"]);
export type ProtocolError = NormalizedError;
export interface RpcTransport { send(frame: Frame): Promise<void>; close(): Promise<void>; }

export function createNonce(bytes = 32): string { return randomBytes(bytes).toString("base64url"); }
export function createLocalToken(): string { return randomBytes(32).toString("base64url"); }
export function localTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.ADOBE_MCP_DATA_DIR ?? (process.platform === "win32" ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Adobe", "adobe-mcp") : join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "adobe-mcp"));
  return env.ADOBE_MCP_DAEMON_TOKEN_FILE ?? join(root, "daemon.token");
}
export function loadOrCreateLocalToken(path = localTokenPath()): string {
  if (existsSync(path)) { const token = readFileSync(path, "utf8").trim(); if (/^[A-Za-z0-9_-]{43}$/.test(token)) return token; throw new Error("UNAUTHENTICATED: invalid daemon token file"); }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = createLocalToken(); writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are inherited from the private data directory. */ }
  return token;
}
export function readLocalToken(path = localTokenPath()): string { const token = readFileSync(path, "utf8").trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("UNAUTHENTICATED: invalid daemon token file"); return token; }
export function computeAuthProof(token: string, clientNonce: string, serverNonce: string, sessionId: string, protocolVersion = ProtocolVersion): string {
  return createHmac("sha256", Buffer.from(token, "base64url")).update(["adobe-mcp", protocolVersion, clientNonce, serverNonce, sessionId].join("\0")).digest("base64url");
}
export function verifyAuthProof(expected: string, actual: string): boolean {
  const a = Buffer.from(expected); const b = Buffer.from(actual); return a.length === b.length && timingSafeEqual(a, b);
}
export function isLoopbackHost(host: string): boolean { return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
export function isAllowedOrigin(origin: string, allowlist: readonly string[]): boolean { return allowlist.includes(origin); }
export function assertFrameSize(frame: string, maxBytes = 8 * 1024 * 1024): void { if (Buffer.byteLength(frame, "utf8") > maxBytes) throw new Error("frame exceeds configured limit"); }
export function makeRpcError(id: z.infer<typeof RpcId> | null, error: ProtocolError): z.infer<typeof JsonRpcResponse> { return { jsonrpc: "2.0", id, error: { code: -32000, message: error.message, data: error } }; }
export type GatewayTarget = TargetRef;
