import { describe, expect, it } from "vitest";
import { decodeImageDimensions } from "@adobe-mcp/bridge-core";
import { encodePngBase64 } from "@adobe-mcp/bridge-core/testkit";
import type { PremiereDispatcher, PremiereTransport } from "./index.js";
import { PremiereBridge, SafePremiereDispatcher, calculatePreviewDimensions, createPremiereBridge, applyTimelineOperation, createEditPlan, executeEditPlan, splitClip, rippleDelete, expandEditPlan } from "./index.js";

const target = { app: "premiere-pro" as const, instanceId: "premiere-test", projectId: "project-1", documentId: "sequence-1" };
const operation = "00000000-0000-4000-8000-000000000001";
const snapshot = { id: "snapshot-1", target, revision: "rev-1", createdAt: "2026-10-01T00:00:00.000Z", sha256: "a".repeat(64), artifact: { artifactId: "artifact-1", kind: "snapshot" as const, displayName: "Premiere snapshot", sha256: "a".repeat(64), provenance: { app: "premiere-pro" as const } }, verified: true };
const receipt = { status: "applied" as const, previousRevision: "rev-1", revision: "rev-2", appliedIndexes: [0], failedIndexes: [], tempIdMap: {}, compensations: [], verification: "passed" as const };

function fakeDispatcher(log: Array<{ method: string; payload: Record<string, unknown> }>): PremiereDispatcher {
  return {
    async dispatch(method, payload) {
      log.push({ method, payload });
      if (method === "premiere.inspect") return { target, revision: "rev-1", data: { sequence: "sequence-1" } };
      if (method === "bridge.snapshot") return snapshot;
      if (method === "bridge.verify") return { ok: true, revision: "rev-2", details: { timeline: "consistent" } };
      if (method === "premiere.timeline.edit") return receipt;
      throw new Error(`unexpected method ${method}`);
    },
    async close() { return; },
  };
}

describe("Premiere bridge contract", () => {
  it("does not claim arbitrary execution", () => expect(createPremiereBridge().descriptor.capabilities).not.toContain("eval@1"));

  it("falls back from UXP to CEP only after a transport failure and validates payloads", async () => {
    const calls: string[] = [];
    const primary: PremiereTransport = { kind: "uxp", request: async () => { calls.push("uxp"); throw new Error("BRIDGE_UNAVAILABLE: UXP closed"); } };
    const fallback: PremiereTransport = { kind: "cep", request: async (method) => { calls.push(`cep:${method}`); return { target, revision: "rev-1", data: {} }; } };
    const dispatcher = new SafePremiereDispatcher(primary, fallback);
    await expect(dispatcher.dispatch("premiere.inspect", { target })).resolves.toMatchObject({ revision: "rev-1" });
    expect(calls).toEqual(["uxp", "cep:premiere.inspect"]);
    await expect(dispatcher.dispatch("premiere.timeline.edit", { target, commands: [{ op: "not-allowlisted", clipId: "clip-1" }], options: { operationId: operation } })).rejects.toThrow();
  });

  it("snapshots, mutates, verifies and caches an operation by operationId", async () => {
    const log: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const bridge = new PremiereBridge(fakeDispatcher(log));
    await expect(bridge.inspect({ target })).resolves.toMatchObject({ revision: "rev-1" });
    const request = { target, commands: [{ op: "cut", trackIds: ["track-1"], at: { ticks: "100", timebase: "25" } }], options: { operationId: operation, expectedRevision: "rev-1", dryRun: false, atomic: true, conflictPolicy: "fail" as const, verification: "state" as const } };
    const first = await bridge.mutate(request);
    const second = await bridge.mutate(request);
    expect(first).toMatchObject({ revision: "rev-2", snapshot });
    expect(second).toEqual(first);
    expect(log.map((entry) => entry.method)).toEqual(["premiere.inspect", "bridge.snapshot", "premiere.timeline.edit", "bridge.verify"]);
  });

  it("rejects stale revisions before any host mutation", async () => {
    const log: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const bridge = new PremiereBridge(fakeDispatcher(log));
    await bridge.inspect({ target });
    await expect(bridge.mutate({ target, commands: [{ op: "ripple-delete", clipIds: ["clip-1"] }], options: { operationId: "00000000-0000-4000-8000-000000000002", expectedRevision: "rev-old", dryRun: false, atomic: true, conflictPolicy: "fail", verification: "state" } })).rejects.toThrow("CONFLICT");
    expect(log.map((entry) => entry.method)).toEqual(["premiere.inspect"]);
  });

  it("generates and validates real downscaled PNG bytes from a large source", async () => {
    expect(calculatePreviewDimensions({ width: 3840, height: 2160 }, 1024)).toEqual({ width: 1024, height: 576, scale: 1024 / 3840 });
    const source = { width: 200, height: 100 };
    const exported = calculatePreviewDimensions(source, 100);
    const exportCalls: Array<{ width: number; height: number }> = [];
    const dispatcher: PremiereDispatcher = {
      async dispatch(method, payload) {
        if (method !== "bridge.preview.capture") throw new Error("unexpected method");
        const requested = calculatePreviewDimensions(source, Number(payload.maxDimension));
        exportCalls.push({ width: requested.width, height: requested.height });
        const imageBase64 = encodePngBase64(requested.width, requested.height, new Array(requested.width * requested.height * 4).fill(0));
        return { imageBase64, mimeType: "image/png", width: requested.width, height: requested.height, revision: "rev-1", capturedAt: "2026-10-01T00:00:00.000Z" };
      },
      async close() {},
    };
    const bridge = new PremiereBridge(dispatcher);
    const result = await bridge.capturePreview({ target, format: "png", maxDimension: 100 });
    expect(exported).toEqual({ width: 100, height: 50, scale: 0.5 });
    expect(exportCalls).toEqual([{ width: 100, height: 50 }]);
    expect(decodeImageDimensions(result.imageBase64)).toEqual({ format: "png", width: 100, height: 50 });
    expect(result).toMatchObject({ width: 100, height: 50 });
  });

  it("rejects real host bytes that exceed maxDimension", async () => {
    const oversized = encodePngBase64(200, 100, new Array(200 * 100 * 4).fill(255));
    const dispatcher: PremiereDispatcher = {
      async dispatch(method) {
        if (method === "bridge.preview.capture") return { imageBase64: oversized, mimeType: "image/png", width: 200, height: 100, revision: "rev-1", capturedAt: "2026-10-01T00:00:00.000Z" };
        throw new Error("unexpected method");
      },
      async close() {},
    };
    await expect(new PremiereBridge(dispatcher).capturePreview({ target, format: "png", maxDimension: 100 })).rejects.toThrow("HOST_ERROR: Premiere preview exceeds maxDimension");
  });
});

describe("Premiere timeline DOM and EditPlan", () => {
  it("splits clips and ripple-deletes a range without leaving a gap", () => {
    const state = { clips: [{ id: "clip-1", trackIndex: 0, startTime: 0, endTime: 10, mediaType: "video" as const }, { id: "clip-2", trackIndex: 0, startTime: 10, endTime: 20, mediaType: "video" as const }] };
    const split = applyTimelineOperation(state, splitClip(0, 5));
    expect(split.clips.map((clip) => [clip.startTime, clip.endTime])).toEqual([[0, 5], [5, 10], [10, 20]]);
    const rippled = applyTimelineOperation(split, rippleDelete(0, 5, 10));
    expect(rippled.clips.map((clip) => [clip.startTime, clip.endTime])).toEqual([[0, 5], [5, 15]]);
  });
  it("expands cut-silence EditPlans through the declarative RPC", async () => {
    const calls: string[] = [];
    const plan = createEditPlan(target, [{ op: "cutSilences", ranges: [{ startTime: 1, endTime: 2 }], trackIndices: [0], ripple: true }], { operationId: operation, dryRun: true });
    const result = await executeEditPlan({ async request(method, payload) { calls.push(`${method}:${(payload.operations as unknown[]).length}`); return receipt; } }, plan);
    expect(calls).toEqual(["premiere.editPlan.execute:1"]);
    expect(result.receipt.status).toBe("applied");
  });
  it("expands autoReframe into video transform/crop operations and preserves non-ripple gaps", () => {
    const plan = createEditPlan(target, [{ op: "autoReframe", aspectRatio: "9:16", sourceWidth: 1920, sourceHeight: 1080, horizontalKeyframes: [{ time: 0, position: 0.25 }, { time: 1, position: 0.75 }] }], { operationId: operation, dryRun: true });
    const expanded = expandEditPlan(plan);
    expect(expanded.map((entry) => entry.op)).toEqual(["setVideoTransform", "setCropKeyframes"]);
    expect(expanded.some((entry) => entry.op === "setAudioKeyframes")).toBe(false);
    const state = { clips: [{ id: "clip-1", trackIndex: 0, startTime: 0, endTime: 10, mediaType: "video" as const }, { id: "clip-2", trackIndex: 0, startTime: 10, endTime: 20, mediaType: "video" as const }] };
    const noRipple = expandEditPlan(createEditPlan(target, [{ op: "cutSilences", ranges: [{ startTime: 5, endTime: 7 }], trackIndices: [0], ripple: false }], { operationId: operation, dryRun: true }))[0]!;
    expect(noRipple.op).toBe("deleteRange");
    expect(applyTimelineOperation(state, noRipple).clips.map((clip) => [clip.startTime, clip.endTime])).toEqual([[0, 5], [7, 10], [10, 20]]);
  });
  it("applies contiguous transitions and rejects missing/non-contiguous clips", () => {
    const state = { clips: [{ id: "a", trackIndex: 0, startTime: 0, endTime: 5, mediaType: "video" as const }, { id: "b", trackIndex: 0, startTime: 5, endTime: 10, mediaType: "video" as const }] };
    const transition = { op: "applyTransition" as const, trackIndex: 0, clipIdA: "a", clipIdB: "b", transitionType: "cross-dissolve" as const, durationSeconds: 1, edge: "between" as const };
    expect(applyTimelineOperation(state, transition).clips).toMatchObject([{ transitionOut: { type: "cross-dissolve" } }, { transitionIn: { type: "cross-dissolve" } }]);
    expect(() => applyTimelineOperation(state, { ...transition, clipIdB: "missing" })).toThrow("NOT_FOUND");
    expect(() => applyTimelineOperation({ clips: [{ ...state.clips[0]! }, { ...state.clips[1]!, startTime: 6, endTime: 11 }] }, transition)).toThrow("not contiguous");
  });
});
