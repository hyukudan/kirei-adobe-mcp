import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApprovalToken, FileGrant } from "@adobe-mcp/schemas";
import { ApprovalToken as ApprovalTokenSchema } from "@adobe-mcp/schemas";
import { Risk, riskForScope } from "@adobe-mcp/tool-catalog";

export interface PolicyConfig { roots: readonly string[]; externalNetwork: boolean; arbitraryExecution: boolean; loopbackOnly: boolean; interactiveFrom: Risk; denyUnattendedAt: Risk; maxPendingRequests?: number; maxFrameBytes?: number; maxEntities?: number; maxFiles?: number; maxBytes?: number; maxMinutes?: number; }
export interface ScopeEstimate { entities: number; files: number; bytes: number; minutes: number; }
export interface Approval { token: string; planHash: string; risk: Risk; scope: string; expiresAt: number; nonce: string; }
export const DEFAULT_POLICY: PolicyConfig = { roots: [], externalNetwork: false, arbitraryExecution: false, loopbackOnly: true, interactiveFrom: "R3", denyUnattendedAt: "R4" };

export function validateLoopback(host: string): void { if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("PERMISSION_DENIED: loopback only"); }
export function validateOrigin(origin: string, allowlist: readonly string[]): void { if (!allowlist.includes(origin)) throw new Error("PERMISSION_DENIED: origin not allowlisted"); }
function canonicalRoot(root: string): string { if (!isAbsolute(root) || !existsSync(root)) throw new Error("PERMISSION_DENIED: configured root is unavailable"); return realpathSync(root); }
function hasSymlinkComponent(path: string): boolean { let current = resolve(path); for (;;) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true; const parent = resolve(current, ".."); if (parent === current) return false; current = parent; } }
export function validateGrantedPath(filePath: string, roots: readonly string[], access: FileGrant["access"]): string {
  if (!isAbsolute(filePath)) throw new Error("INVALID_ARGUMENT: path must be absolute");
  if (!roots.length) throw new Error("PERMISSION_DENIED: no file roots configured");
  const canonical = existsSync(filePath) ? realpathSync(filePath) : resolve(filePath);
  if (hasSymlinkComponent(filePath)) throw new Error("PERMISSION_DENIED: symlink path component");
  const allowed = roots.some((root) => { const rootPath = canonicalRoot(root); const rel = relative(rootPath, canonical); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); });
  if (!allowed) throw new Error("PERMISSION_DENIED: path outside grant root");
  if (access === "read" && !existsSync(canonical)) throw new Error("NOT_FOUND: granted file");
  return canonical;
}

export function loadPolicy(filePath: string): PolicyConfig {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
  const limits = parsed.limits ?? {};
  const policy: PolicyConfig = { roots: Array.isArray(parsed.roots) ? parsed.roots : [], externalNetwork: parsed.interaction?.externalNetwork === true, arbitraryExecution: parsed.interaction?.arbitraryExecution === true, loopbackOnly: parsed.interaction?.loopbackOnly !== false, interactiveFrom: parsed.risk?.interactiveFrom ?? "R3", denyUnattendedAt: parsed.risk?.denyUnattendedAt ?? "R4", maxPendingRequests: limits.maxPendingRequests, maxFrameBytes: limits.maxFrameBytes, maxEntities: limits.maxEntities, maxFiles: limits.maxFiles, maxBytes: limits.maxBytes, maxMinutes: limits.maxMinutes };
  return policy;
}
export function resolveFileGrant(grant: FileGrant, filePath: string, policy: PolicyConfig, now = Date.now()): string {
  if (!grant.grantId || (grant.access !== "read" && grant.access !== "write" && grant.access !== "read-write")) throw new Error("INVALID_ARGUMENT: invalid file grant");
  if (!Number.isFinite(now)) throw new Error("INVALID_ARGUMENT: invalid clock");
  return validateGrantedPath(filePath, policy.roots, grant.access);
}

export function calculateRisk(base: Risk, estimate: ScopeEstimate): Risk { return riskForScope(base, estimate.entities, estimate.files, estimate.bytes, estimate.minutes); }
export function assertRiskAllowed(risk: Risk, unattended: boolean, hasApproval: boolean, explicitConfirmation = false): void { if (risk === "R3" && !hasApproval) throw new Error("PERMISSION_DENIED: R3 requires approval"); if (risk === "R4" && (unattended || !hasApproval || !explicitConfirmation)) throw new Error("PERMISSION_DENIED: R4 requires recent explicit confirmation"); }

function approvalPayload(token: Omit<ApprovalToken, "signature">): string { return [token.tokenId, token.planHash, token.scopeHash, token.risk, token.nonce, token.issuedAt, token.expiresAt].join("\0"); }
export function issueApproval(planHash: string, scopeHash: string, risk: Risk, secret: string, ttlMs = 10 * 60 * 1000, now = new Date()): ApprovalToken {
  if (ttlMs <= 0 || ttlMs > 10 * 60 * 1000) throw new Error("INVALID_ARGUMENT: approval TTL must be <= 10 minutes");
  const issuedAt = now.toISOString(); const expiresAt = new Date(now.getTime() + ttlMs).toISOString(); const unsigned = { tokenId: randomBytes(16).toString("base64url"), planHash, scopeHash, risk, nonce: randomBytes(32).toString("base64url"), issuedAt, expiresAt } as const;
  const signature = createHmac("sha256", secret).update(approvalPayload(unsigned)).digest("base64url");
  return ApprovalTokenSchema.parse({ ...unsigned, signature });
}
export function verifyApproval(token: unknown, expected: { planHash: string; scopeHash: string; risk: Risk }, secret: string, now = Date.now()): ApprovalToken {
  const parsed = ApprovalTokenSchema.parse(token); if (parsed.planHash !== expected.planHash || parsed.scopeHash !== expected.scopeHash || parsed.risk !== expected.risk) throw new Error("PERMISSION_DENIED: approval scope mismatch");
  if (Date.parse(parsed.expiresAt) <= now || Date.parse(parsed.issuedAt) > now) throw new Error("PERMISSION_DENIED: approval expired");
  const expectedSignature = createHmac("sha256", secret).update(approvalPayload({ tokenId: parsed.tokenId, planHash: parsed.planHash, scopeHash: parsed.scopeHash, risk: parsed.risk, nonce: parsed.nonce, issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt })).digest("base64url");
  const a = Buffer.from(expectedSignature); const b = Buffer.from(parsed.signature); if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("UNAUTHENTICATED: invalid approval signature");
  return parsed;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
export function hashScope(scope: { entities: number; files: number; bytes: number; minutes: number }): string { return createHash("sha256").update(canonical(scope)).digest("hex"); }
export function hashPlan(plan: Omit<import("@adobe-mcp/schemas").Plan, "planHash">): string { return createHash("sha256").update(canonical(plan)).digest("hex"); }
export function consumeApprovalNonce(token: Pick<import("@adobe-mcp/schemas").ApprovalToken, "nonce">, used: Set<string>): void { if (used.has(token.nonce)) throw new Error("PERMISSION_DENIED: approval nonce has already been consumed"); used.add(token.nonce); }
export function redact(value: unknown): unknown { if (typeof value === "string") return value.replace(/(token|secret|authorization|password)=[^\s&]+/gi, "$1=[REDACTED]").replace(/[A-Za-z0-9_-]{40,}/g, "[REDACTED]"); if (Array.isArray(value)) return value.map(redact); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /token|secret|password|authorization/i.test(k) ? "[REDACTED]" : redact(v)])); return value; }
