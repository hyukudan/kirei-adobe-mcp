import { createIllustratorMockBridge } from "@adobe-mcp/bridge-illustrator";
import { createMockPhotoshopBridge } from "@adobe-mcp/bridge-photoshop";
import { BaseMockBridge, createMockDescriptor } from "@adobe-mcp/bridge-core";
import type { BridgeDescriptor } from "@adobe-mcp/bridge-core";
import { randomUUID } from "node:crypto";
type App = "photoshop" | "illustrator" | "after-effects" | "premiere-pro";
interface TargetRef { app: App; instanceId?: string; }
interface AdobeBridge { descriptor: { app: App; instanceId: string }; connect(): Promise<void>; inspect(request: { target: TargetRef }): Promise<{ revision: string }>; mutate(request: { target: TargetRef; commands: readonly Record<string, unknown>[]; options: { operationId: string; expectedRevision?: string; dryRun: boolean; atomic: boolean; conflictPolicy: "fail"; verification: "none" } }): Promise<Record<string, unknown>>; snapshot(target: TargetRef): Promise<{ verified: boolean; sha256: string }>; }

class ContractMockBridge extends BaseMockBridge {
  constructor(app: App, transport: "uxp" | "jsx") { super(); this.descriptor = createMockDescriptor(app, transport); }
  readonly descriptor: BridgeDescriptor;
}

export function createMockBridges() { return [createMockPhotoshopBridge(), createIllustratorMockBridge(), new ContractMockBridge("after-effects", "jsx"), new ContractMockBridge("premiere-pro", "uxp")]; }
export interface ContractReport { app: string; staleRevisionRejected: boolean; operationIdempotent: boolean; snapshotVerified: boolean; }
export async function runBridgeContract(bridge: AdobeBridge): Promise<ContractReport> {
  await bridge.connect(); const target: TargetRef = { app: bridge.descriptor.app, instanceId: bridge.descriptor.instanceId };
  const state = await bridge.inspect({ target }); let staleRevisionRejected = false; try { await bridge.mutate({ target, commands: [{}], options: { operationId: randomUUID(), expectedRevision: "stale", dryRun: false, atomic: false, conflictPolicy: "fail", verification: "none" } }); } catch (error) { staleRevisionRejected = error instanceof Error && error.message.startsWith("CONFLICT"); }
  const operationId = randomUUID(); const request = { target, commands: [{}], options: { operationId, expectedRevision: state.revision, dryRun: false, atomic: false, conflictPolicy: "fail" as const, verification: "none" as const } }; const first = await bridge.mutate(request); const second = await bridge.mutate(request);
  const snapshot = await bridge.snapshot(target); return { app: bridge.descriptor.app, staleRevisionRejected, operationIdempotent: JSON.stringify(first) === JSON.stringify(second), snapshotVerified: snapshot.verified && /^[a-f0-9]{64}$/.test(snapshot.sha256) };
}
