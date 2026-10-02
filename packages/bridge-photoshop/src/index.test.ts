import { describe, expect, it } from "vitest";
import { MutationOptions } from "@adobe-mcp/schemas";
import { computeAuthProof, createLocalToken } from "@adobe-mcp/protocol";
import { createMockPhotoshopBridge, PhotoshopBridge } from "./index.js";
import type { PhotoshopSocket, PhotoshopTransport } from "./index.js";
import { createSelectionMask, createCurvesAdjustment, replaceLinkedSmartObject, applyNeuralFilter } from "./index.js";

describe("photoshop bridge contract", () => {
  it("supports connect, inspect and safe mutation", async () => {
    const bridge = createMockPhotoshopBridge();
    await bridge.connect();
    expect(await bridge.health()).toBe("ready");
    const target = { app: "photoshop" as const };
    const state = await bridge.inspect({ target });
    const receipt = await bridge.mutate({
      target,
      commands: [{ op: "set" }],
      options: MutationOptions.parse({ operationId: "00000000-0000-4000-8000-000000000000" })
    });
    expect(state.revision).toBeDefined();
    expect(receipt.status).toBe("applied");
    await bridge.close();
  });
});

class FakeSocket implements PhotoshopSocket {
  private readonly listeners = new Map<string, (value: unknown) => void>();
  private challengeSent = false;
  constructor(private readonly token: string) {}
  addEventListener(event: "open" | "message" | "close" | "error", listener: (value: unknown) => void): void {
    this.listeners.set(event, listener);
    if (event === "message" && !this.challengeSent) {
      this.challengeSent = true;
      queueMicrotask(() => this.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "auth.challenge", params: { serverNonce: "server", sessionId: "00000000-0000-4000-8000-000000000001", expiresAt: new Date(Date.now() + 30_000).toISOString() } })));
    }
  }
  send(data: string): void {
    const value = JSON.parse(data) as { id: string; method?: string; params?: { auth?: { clientNonce: string }; proof?: string }; type?: string; request?: { id: string; method: string } };
    if (value.method === "bridge.hello") {
      const auth = value.params?.auth;
      if (!auth || value.params?.proof !== computeAuthProof(this.token, auth.clientNonce, "server", "00000000-0000-4000-8000-000000000001")) throw new Error("invalid proof");
      queueMicrotask(() => this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { protocolVersion: "1.0" } })));
      return;
    }
    const request = value.request;
    if (!request) return;
    const result = request.method === "bridge.inspect" ? { target: { app: "photoshop" }, revision: "rev-1", data: { layers: [] } }
      : request.method === "bridge.mutate" ? { status: "applied", previousRevision: "rev-1", revision: "rev-2", appliedIndexes: [0], failedIndexes: [], tempIdMap: {}, compensations: [], verification: "passed" }
      : { ok: true, revision: "rev-2" };
    queueMicrotask(() => this.emit("message", JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id: request.id, result } })));
  }
  close(): void { this.emit("close", undefined); }
  private emit(event: string, value: unknown): void { this.listeners.get(event)?.(value); }
}

class FakeTransport implements PhotoshopTransport {
  constructor(private readonly token: string) {}
  async connect(_endpoint: string): Promise<PhotoshopSocket> { return new FakeSocket(this.token); }
}

describe("PhotoshopBridge UXP transport", () => {
  it("authenticates, tracks revisions and verifies a mutation", async () => {
    const token = createLocalToken();
    const bridge = new PhotoshopBridge({ token, transport: new FakeTransport(token), endpoint: "ws://127.0.0.1:4567" });
    await bridge.connect();
    const target = { app: "photoshop" as const };
    expect((await bridge.inspect({ target })).revision).toBe("rev-1");
    const receipt = await bridge.mutate({ target, commands: [{ op: "set" }], options: MutationOptions.parse({ operationId: "00000000-0000-4000-8000-000000000002" }) });
    expect(receipt.revision).toBe("rev-2");
    expect((await bridge.verify(target, "rev-2")).ok).toBe(true);
    await bridge.close();
  });
});

describe("Photoshop typed batchPlay builders", () => {
  it("creates allowlisted mask, adjustment, smart object and filter descriptors", () => {
    expect(createSelectionMask({ layerId: "layer-1", kind: "selection" }).descriptor._obj).toBe("make");
    expect(createCurvesAdjustment({ points: [[0, 0], [255, 255]] }).descriptor._obj).toBe("adjustmentLayer");
    expect(replaceLinkedSmartObject("layer-1", "artifact-1").descriptor._obj).toBe("newPlacedLayer");
    expect(applyNeuralFilter({ smoothness: 0.5 }).options.dialogMode).toBe("silent");
  });
});
