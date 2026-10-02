import { describe, expect, it } from "vitest";
import { booleanPath, calculateDownscaledDimensions, createIllustratorBridge, invokeVerifiedJsx, loadJsxManifest, readVerifiedJsx, type IllustratorRpcTransport } from "./index.js";

const target = { app: "illustrator" as const, instanceId: "ai-test", documentId: "doc-test" };
const options = { operationId: "11111111-1111-4111-8111-111111111111", dryRun: false, atomic: true, conflictPolicy: "fail" as const, verification: "state" as const };

function documentState(revision = "ai-rev-0") {
  return {
    id: "doc-test", revision, name: "Test.ai", saved: true, colorSpace: "rgb" as const, activeArtboardId: "artboard-1",
    artboards: [{ id: "artboard-1", name: "Artboard 1", bounds: { left: 0, top: 100, right: 100, bottom: 0, unit: "pt" as const } }],
    layers: [{ id: "layer-1", name: "Layer 1", visible: true, locked: false, itemCount: 1 }],
    items: [{ id: "item-1", name: "Rectangle", type: "path" as const, layerId: "layer-1", parentId: null, bounds: { left: 0, top: 100, right: 100, bottom: 0, unit: "pt" as const }, visible: true, locked: false, selected: false, opacity: 1, geometry: { pointCount: 4 }, fillColor: { space: "rgb" as const, components: [1, 0, 0], alpha: 1 } }],
    truncated: false,
  };
}

function receipt(revision = "ai-rev-1") {
  return { status: "applied" as const, previousRevision: "ai-rev-0", revision, appliedIndexes: [0], failedIndexes: [], tempIdMap: {}, compensations: [], verification: "passed" as const };
}

class FakeTransport implements IllustratorRpcTransport {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  async connect(): Promise<void> {}
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "bridge.inspect") return { target, revision: "ai-rev-0", data: documentState() };
    if (method === "bridge.mutate") return receipt();
    if (method === "bridge.snapshot") return { id: "snapshot-1", target, revision: "ai-rev-1", createdAt: "2026-10-01T00:00:00.000Z", sha256: "a".repeat(64), artifact: { artifactId: "artifact-1", kind: "snapshot", displayName: "snapshot", sha256: "a".repeat(64), provenance: { app: "illustrator" } }, verified: true };
    if (method === "bridge.verify") return { ok: true, revision: "ai-rev-1", details: { checked: true } };
    if (method === "bridge.export") return { artifact: { artifactId: "artifact-2", kind: "file", displayName: "out.svg", mediaType: "image/svg+xml" }, receipt: receipt() };
    throw new Error("NOT_FOUND");
  }
  async close(): Promise<void> {}
}

describe("IllustratorBridge", () => {
  it("exposes a real UXP descriptor and connects through an injected transport", async () => {
    const transport = new FakeTransport();
    const bridge = createIllustratorBridge({ transport, instanceId: "ai-test", appVersion: "28.0" });
    expect(bridge.descriptor.app).toBe("illustrator");
    expect(bridge.descriptor.transport).toBe("uxp");
    expect(bridge.descriptor.capabilities).toContain("page-items.read@1");
    await bridge.connect();
    const inspected = await bridge.inspect({ target, depth: 2 });
    expect(inspected.data.colorSpace).toBe("rgb");
    expect(inspected.data.items).toHaveLength(1);
  });

  it("validates commands, enforces revisions and makes operation IDs idempotent", async () => {
    const transport = new FakeTransport();
    const bridge = createIllustratorBridge({ transport });
    await bridge.connect();
    await bridge.inspect({ target });
    const request = { target, commands: [{ op: "create-layer", tempId: "new-layer", name: "New Layer" }], options };
    const first = await bridge.mutate(request);
    const second = await bridge.mutate(request);
    expect(second).toEqual(first);
    expect(transport.calls.filter((call) => call.method === "bridge.mutate")).toHaveLength(1);
    await expect(bridge.mutate({ ...request, options: { ...options, operationId: "22222222-2222-4222-8222-222222222222", expectedRevision: "stale" } })).rejects.toThrow("CONFLICT");
  });

  it("requires verified snapshots and validates export formats", async () => {
    const bridge = createIllustratorBridge({ transport: new FakeTransport() });
    await bridge.connect();
    const snapshot = await bridge.snapshot(target);
    expect(snapshot.verified).toBe(true);
    expect((await bridge.export({ target, destination: { grantId: "grant", access: "write", suggestedName: "out.svg" }, options: { format: "svg" }, mutation: options })).artifact.mediaType).toBe("image/svg+xml");
    await expect(bridge.export({ target, destination: { grantId: "grant", access: "write" }, options: { format: "eps" }, mutation: options })).rejects.toThrow("not supported");
  });
});

describe("Illustrator JSX fallback", () => {
  it("loads the versioned manifest and verifies the bundled source hash", async () => {
    const manifest = await loadJsxManifest();
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.files[0]?.handlers).toContain("inspect");
    await expect(readVerifiedJsx(manifest.files[0]!)).resolves.toContain("AdobeMcpIllustrator");
  });

  it("only invokes a verified allowlisted handler", async () => {
    const calls: string[] = [];
    const transport: IllustratorRpcTransport = { async connect() {}, async close() {}, async call(method) { calls.push(method); return { ok: true }; } };
    await expect(invokeVerifiedJsx(transport, "inspect", { target })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["jsx.invoke"]);
    await expect(invokeVerifiedJsx(transport, "eval" as never, {})).rejects.toThrow("not allowlisted");
  });
});

describe("Illustrator vector and artboard pipeline", () => {
  it("builds boolean path intent and performs real dimensional downscaling", () => {
    expect(booleanPath("union", ["a", "b"])).toEqual({ op: "boolean", operation: "union", itemIds: ["a", "b"] });
    expect(calculateDownscaledDimensions(2000, 1000, 1, 500)).toEqual({ width: 500, height: 250, scale: 0.25 });
  });
});
