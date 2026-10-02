import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import type { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { computeAuthProof, ProtocolVersion } from "@adobe-mcp/protocol";
import { AfterEffectsBridge, TcpAfterEffectsPanelTransport, createAfterEffectsBridge, type AfterEffectsPanelTransport, type PanelHello } from "./index.js";
import { AerenderWorker, buildAerenderArgs, parseAerenderProgress, segmentFrameRange, type AerenderRequest } from "./aerender.js";
import { listAfterEffectsPresetResources, readAfterEffectsPresetResource } from "./presets.js";

const welcome = { protocolVersion: ProtocolVersion, sessionId: "00000000-0000-4000-8000-000000000001", serverNonce: "server-nonce-1234567890", expiresAt: "2030-01-01T00:00:00.000Z", maxFrameBytes: 8 * 1024 * 1024 };

class MockPanelTransport implements AfterEffectsPanelTransport {
  hello?: PanelHello;
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async connect(hello: PanelHello) { this.hello = hello; return welcome; }
  async request(method: string, params?: Record<string, unknown>) {
    this.calls.push(params === undefined ? { method } : { method, params });
    if (method === "ae.inspect") return { revision: "rev-1", data: { compositions: [] } };
    if (method === "ae.mutate") return { status: "applied", revision: "rev-2", appliedIndexes: [0], failedIndexes: [], tempIdMap: {}, compensations: [], verification: "passed" };
    if (method === "ae.verify") return { ok: true, revision: "rev-2" };
    if (method === "adobe.aftereffects.preset.apply") return { applied: true, presetId: "effect.fast-blur", layerId: "layer-1", modifiedProperties: ["ADBE Fast Blur.blur"] };
    return { artifact: { artifactId: "a", kind: "file", displayName: "render.mov" }, receipt: { status: "queued", appliedIndexes: [], failedIndexes: [], tempIdMap: {}, compensations: [] } };
  }
  async close() {}
}

describe("after effects bridge contract", () => {
  it("declares the JSX transport and authenticated capabilities", () => {
    const bridge = createAfterEffectsBridge();
    expect(bridge.descriptor.transport).toBe("jsx");
    expect(bridge.descriptor.capabilities).toContain("keyframes.write@1");
  });

  it("connects, inspects and forwards only schema-approved mutations", async () => {
    const transport = new MockPanelTransport();
    const bridge = new AfterEffectsBridge({ transport, instanceId: "ae-test", appVersion: "24.0" });
    await bridge.connect();
    const state = await bridge.inspect({ target: { app: "after-effects", instanceId: "ae-test" }, depth: 2 });
    expect(state.data).toEqual({ compositions: [] });
    const receipt = await bridge.mutate({
      target: { app: "after-effects", instanceId: "ae-test", entityId: "comp-1" },
      commands: [{ op: "set-property", layerId: "layer-1", propertyPath: ["Transform", "Opacity"], value: 50 }],
      options: { operationId: "00000000-0000-4000-8000-000000000002", dryRun: false, atomic: true, conflictPolicy: "fail", verification: "state" },
    });
    expect(receipt.revision).toBe("rev-2");
    await expect(bridge.mutate({
      target: { app: "after-effects" },
      commands: [{ op: "run-script", source: "alert(1)" }],
      options: { operationId: "00000000-0000-4000-8000-000000000003", dryRun: false, atomic: true, conflictPolicy: "fail", verification: "state" },
    })).rejects.toThrow("INVALID_ARGUMENT");
    expect(transport.calls.map((call) => call.method)).toEqual(["ae.inspect", "ae.mutate"]);
  });

  it("uses the protocol challenge inputs supplied by the transport", async () => {
    const transport = new MockPanelTransport();
    const bridge = new AfterEffectsBridge({ transport });
    await bridge.connect();
    expect(transport.hello?.auth.scheme).toBe("challenge-hmac");
    expect(transport.hello?.protocolVersion).toBe("1.0");
    expect(computeAuthProof("dGVzdA==", transport.hello!.auth.clientNonce, welcome.serverNonce, welcome.sessionId)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("applies a catalogued preset through the strict specialized result", async () => {
    const transport = new MockPanelTransport(); const bridge = new AfterEffectsBridge({ transport }); await bridge.connect();
    await expect(bridge.applyPreset({ target: { app: "after-effects", entityId: "comp-1" }, presetId: "effect.fast-blur", layerId: "layer-1", parameters: {}, mutation: { operationId: "00000000-0000-4000-8000-000000000004", dryRun: false, atomic: true, conflictPolicy: "fail", verification: "state" } })).resolves.toEqual({ applied: true, presetId: "effect.fast-blur", layerId: "layer-1", modifiedProperties: ["ADBE Fast Blur.blur"] });
  });
});

describe("After Effects TCP JSON-lines framing", () => {
  it("reassembles split response chunks and sends every request as one newline-delimited frame", async () => {
    const server = createServer();
    let received = "";
    const frames: string[] = [];
    let authenticated = false;
    let commandExecuted = false;
    const clientNonce = "client-nonce";
    const expectedProof = computeAuthProof("dGVzdA==", clientNonce, welcome.serverNonce, welcome.sessionId);
    server.on("connection", (socket) => {
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
        let newline = received.indexOf("\n");
        while (newline >= 0) {
          const line = received.slice(0, newline); received = received.slice(newline + 1); frames.push(line); newline = received.indexOf("\n");
          const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
          if (request.method === "bridge.hello") {
            const auth = request.params?.auth as { clientNonce?: string } | undefined;
            if (auth?.clientNonce !== clientNonce) throw new Error("handshake client nonce mismatch");
          } else if (request.method === "bridge.auth") {
            const auth = request.params as { sessionId?: string; proof?: string; clientNonce?: string; serverNonce?: string } | undefined;
            if (auth?.sessionId !== welcome.sessionId || auth.clientNonce !== clientNonce || auth.serverNonce !== welcome.serverNonce || auth.proof !== expectedProof) throw new Error("handshake auth payload mismatch");
            authenticated = true;
          } else if (request.method === "ae.preview.capture") {
            commandExecuted = authenticated;
          }
          const response = JSON.stringify({ id: request.id, result: request.method === "bridge.hello" ? welcome : request.method === "bridge.auth" ? { authenticated: true } : { payload: "x".repeat(20_000) } }) + "\n";
          if (request.method === "bridge.hello") { socket.write(response.slice(0, 7)); setTimeout(() => socket.write(response.slice(7)), 0); }
          else socket.write(response);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const transport = new TcpAfterEffectsPanelTransport({ port, token: "dGVzdA==" });
    try {
      await expect(transport.connect({ protocolVersion: ProtocolVersion, instanceId: "ae-stream", client: { kind: "jsx", app: "after-effects", appVersion: "24" }, capabilities: [], auth: { scheme: "challenge-hmac", clientNonce } })).resolves.toMatchObject({ sessionId: welcome.sessionId });
      await expect(transport.request("ae.preview.capture", { target: { app: "after-effects" } })).resolves.toMatchObject({ payload: "x".repeat(20_000) });
      expect(authenticated).toBe(true);
      expect(commandExecuted).toBe(true);
      expect(frames).toHaveLength(3);
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("aerender worker", () => {
  it("builds safe argv without shell interpolation", () => {
    expect(buildAerenderArgs({ projectPath: "C:\\renders\\a; & dangerous.aep", comp: "Main Comp", outputPath: "C:\\out\\shot [1].mov", startFrame: 1, endFrame: 24 })).toEqual([
      "-project", "C:\\renders\\a; & dangerous.aep", "-comp", "Main Comp", "-output", "C:\\out\\shot [1].mov", "-s", "1", "-e", "24",
    ]);
  });

  it("parses percentage and frame progress with an ETA", () => {
    expect(parseAerenderProgress("PROGRESS: 25%")).toMatchObject({ percent: 0.25 });
    expect(parseAerenderProgress("Rendering frame 12 of 48")).toMatchObject({ percent: 0.25, completedFrames: 12, totalFrames: 48 });
    expect(parseAerenderProgress("starting aerender")).toBeUndefined();
  });

  it("runs a mocked aerender process with shell disabled", async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: Writable; stderr: Writable };
    child.pid = 123;
    child.stdout = new EventEmitter() as unknown as Writable;
    child.stderr = new EventEmitter() as unknown as Writable;
    const spawnCalls: unknown[] = [];
    const worker = new AerenderWorker({
      locator: async () => "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\aerender.exe",
      spawnProcess: ((file: string, args: readonly string[], options: Record<string, unknown>) => {
        spawnCalls.push({ file, args, options });
        setTimeout(() => { child.stdout.emit("data", "PROGRESS: 50%\\n"); child.emit("close", 0); }, 0);
        return child as never;
      }) as never,
      now: () => 1_000,
    });
    const result = await worker.run({ projectPath: "C:\\project.aep", outputPath: "C:\\output.mov" } satisfies AerenderRequest);
    expect(result.job.status).toBe("succeeded");
    expect(result.progress.percent).toBe(0.5);
    expect(spawnCalls[0]).toMatchObject({ options: { shell: false, windowsHide: true } });
  });
  it("segments frame ranges and exposes preset resources", () => {
    expect(segmentFrameRange(0, 9, 4)).toEqual([{ startFrame: 0, endFrame: 3 }, { startFrame: 4, endFrame: 7 }, { startFrame: 8, endFrame: 9 }]);
    const resource = listAfterEffectsPresetResources()[0]!;
    expect(JSON.parse(readAfterEffectsPresetResource(resource.uri)) as { matchName: string }).toHaveProperty("matchName");
  });
});
