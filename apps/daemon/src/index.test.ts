import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { LocalBridgeDaemon } from "./index.js";
import { computeAuthProof, createNonce, ProtocolVersion } from "@adobe-mcp/protocol";

type TestApp = "photoshop" | "illustrator" | "after-effects" | "premiere-pro";
async function authenticate(endpoint: string, token: string, kind: "jsx" | "gateway", instanceId: string, app: TestApp = "photoshop", capabilities?: string[]): Promise<{ socket: WebSocket; sessionId: string }> {
  const socket = new WebSocket(endpoint, { headers: { Origin: "null" } });
  let authSessionId = "";
  return new Promise((resolve, reject) => {
    const helloId = `hello-${instanceId}`;
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const value = JSON.parse(raw.toString()) as { method?: string; params?: { serverNonce: string; sessionId: string }; id?: string; error?: { message?: string } };
      if (value.method === "auth.challenge" && value.params) {
        authSessionId = value.params.sessionId;
        const clientNonce = createNonce();
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: helloId, method: "bridge.hello", params: { protocolVersion: ProtocolVersion, instanceId, client: { kind, app, appVersion: "test" }, capabilities: kind === "gateway" ? [] : capabilities ?? ["state.read@1", "preview.capture@1"], auth: { scheme: "challenge-hmac", clientNonce }, proof: computeAuthProof(token, clientNonce, value.params.serverNonce, value.params.sessionId) } }));
      } else if (value.id === helloId) {
        if (value.error) reject(new Error(value.error.message ?? "authentication failed")); else resolve({ socket, sessionId: authSessionId });
      }
    });
  });
}

async function status(socket: WebSocket, params: Record<string, unknown>): Promise<{ status: string; bridges: Array<{ instanceId: string; app: string; sessionId: string }> }> {
  return new Promise((resolve, reject) => {
    const id = `status-${Math.random()}`;
    const onMessage = (raw: WebSocket.RawData) => { const value = JSON.parse(raw.toString()) as { type?: string; request?: { id?: string; result?: { ok: boolean; data: { status: string; bridges: Array<{ instanceId: string; app: string; sessionId: string }> } } } }; if (value.type === "rpc" && value.request?.id === id && value.request.result) { socket.off("message", onMessage); resolve(value.request.result.data); } };
    socket.on("message", onMessage); socket.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id, method: "adobe.system.status", params } }));
    setTimeout(() => { socket.off("message", onMessage); reject(new Error("status request timed out")); }, 2_000);
  });
}

async function rpc(socket: WebSocket, method: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Math.random()}`;
    const onMessage = (raw: WebSocket.RawData) => { const value = JSON.parse(raw.toString()) as { type?: string; request?: { id?: string; result?: { ok: boolean; data?: unknown }; error?: unknown } }; if (value.type === "rpc" && value.request?.id === id) { socket.off("message", onMessage); clearTimeout(timeout); if (value.request.result) resolve(value.request.result); else reject(value.request.error ?? new Error("RPC failed")); } };
    const timeout = setTimeout(() => { socket.off("message", onMessage); reject(new Error(`${method} request timed out`)); }, 2_000);
    socket.on("message", onMessage); socket.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id, method, params } }));
  });
}

describe("daemon", () => {
  it("binds a local endpoint and registers four bridge instances", async () => { const daemon = new LocalBridgeDaemon(); const port = await daemon.start(); expect(port).toBeGreaterThan(0); expect(daemon.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/); await daemon.stop(); });
  it("correlates the authenticated session and applies status filters", async () => {
    const daemon = new LocalBridgeDaemon(); const port = await daemon.start();
    const panel = await authenticate(daemon.endpoint, daemon.authToken, "jsx", "session-test");
    const sessions = await daemon.lifecycle.connectedSessions(); expect(sessions).toHaveLength(1); expect(sessions[0]?.sessionId).toBe(panel.sessionId);
    const gateway = await authenticate(daemon.endpoint, daemon.authToken, "gateway", "gateway-test");
    const response = await new Promise<{ result: { ok: boolean; data: { bridges: Array<{ instanceId: string }> } } }>((resolve, reject) => {
      const id = "status-test"; const onMessage = (raw: WebSocket.RawData) => { const value = JSON.parse(raw.toString()) as { type?: string; request?: { id?: string; result?: { ok: boolean; data: { bridges: Array<{ instanceId: string }> } } } }; if (value.type === "rpc" && value.request?.id === id) { gateway.socket.off("message", onMessage); resolve(value.request as { result: { ok: boolean; data: { bridges: Array<{ instanceId: string }> } } }); } }; gateway.socket.on("message", onMessage); gateway.socket.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id, method: "adobe.system.status", params: { target: { app: "photoshop", instanceId: "session-test" }, includeBridges: true } } })); setTimeout(() => { gateway.socket.off("message", onMessage); reject(new Error("status request timed out")); }, 2_000); });
    expect(response.result.data.bridges.map((bridge) => bridge.instanceId)).toEqual(["session-test"]);
    panel.socket.close(); gateway.socket.close(); await daemon.stop();
  });

  it("supports includeBridges:false, app/no-match filters and preserves a session across reconnect", async () => {
    const daemon = new LocalBridgeDaemon(); await daemon.start();
    const photoshop = await authenticate(daemon.endpoint, daemon.authToken, "jsx", "ps-status", "photoshop");
    const afterEffects = await authenticate(daemon.endpoint, daemon.authToken, "jsx", "ae-status", "after-effects");
    const gateway = await authenticate(daemon.endpoint, daemon.authToken, "gateway", "gateway-status");
    await expect(status(gateway.socket, { target: { app: "after-effects" } })).resolves.toMatchObject({ bridges: [{ instanceId: "ae-status", app: "after-effects" }] });
    await expect(status(gateway.socket, { includeBridges: false })).resolves.toMatchObject({ bridges: [] });
    await expect(status(gateway.socket, { target: { app: "premiere-pro" } })).resolves.toMatchObject({ status: "stopped", bridges: [] });

    const firstSessionId = (await daemon.lifecycle.connectedSessions()).find((session) => session.instanceId === "ps-status")?.sessionId;
    const replacement = await authenticate(daemon.endpoint, daemon.authToken, "jsx", "ps-status", "photoshop");
    const replacementSessionId = (await daemon.lifecycle.connectedSessions()).find((session) => session.instanceId === "ps-status")?.sessionId;
    expect(replacementSessionId).toBe(replacement.sessionId);
    expect(replacementSessionId).not.toBe(firstSessionId);
    await new Promise<void>((resolve) => { photoshop.socket.once("close", () => resolve()); photoshop.socket.close(); });
    expect((await daemon.lifecycle.connectedSessions()).find((session) => session.instanceId === "ps-status")?.sessionId).toBe(replacement.sessionId);
    afterEffects.socket.close(); replacement.socket.close(); gateway.socket.close(); await daemon.stop();
  });

  it("normalizes raw Photoshop and Illustrator panel exports into immutable artifacts", async () => {
    const daemon = new LocalBridgeDaemon(); await daemon.start();
    const photoshop = await authenticate(daemon.endpoint, daemon.authToken, "jsx", "ps-export", "photoshop", ["state.read@1", "preview.capture@1", "export.file@1"]);
    const illustrator = await authenticate(daemon.endpoint, daemon.authToken, "jsx", "ai-export", "illustrator", ["state.read@1", "preview.capture@1", "export.file@1"]);
    const gateway = await authenticate(daemon.endpoint, daemon.authToken, "gateway", "gateway-export");
    expect(daemon.lifecycle.select({ app: "photoshop", instanceId: "ps-export" }).descriptor.capabilities).toContain("export.file@1");
    expect(daemon.capabilities.list("ps-export")).toContain("export.file@1");
    const respond = (socket: WebSocket, method: string, result: unknown) => socket.on("message", (raw) => { const value = JSON.parse(raw.toString()) as { type?: string; request?: { id?: string; method?: string } }; if (value.type === "rpc" && value.request?.method === method && value.request.id !== undefined) socket.send(JSON.stringify({ type: "rpc", request: { jsonrpc: "2.0", id: value.request.id, result } })); });
    respond(photoshop.socket, "bridge.exportLayers", { layerBytes: [{ layerId: "layer-1", name: "Hero", format: "png", bytesBase64: Buffer.from("photoshop-layer").toString("base64"), mediaType: "image/png" }] });
    respond(illustrator.socket, "bridge.exportArtboards", { artboards: [{ id: "board-1", name: "Cover", width: 1080, height: 1920, bytesBase64: Buffer.from("illustrator-artboard").toString("base64"), mediaType: "image/png" }] });
    const photoshopResult = await rpc(gateway.socket, "adobe.photoshop.exportLayers", { target: { app: "photoshop", instanceId: "ps-export" }, layerIds: ["layer-1"], format: "png", destination: { grantId: "grant-ps", access: "write", suggestedName: "hero.png" }, scale: 1, includeHidden: false, mutation: { operationId: randomUUID(), dryRun: false, atomic: true, conflictPolicy: "fail", verification: "none" } });
    const illustratorResult = await rpc(gateway.socket, "adobe.illustrator.exportArtboards", { target: { app: "illustrator", instanceId: "ai-export" }, artboardIds: ["board-1"], format: "png", destination: { grantId: "grant-ai", access: "write", suggestedName: "cover.png" }, scale: 1, mutation: { operationId: randomUUID(), dryRun: false, atomic: true, conflictPolicy: "fail", verification: "none" } });
    if (!photoshopResult.ok) throw new Error(`Photoshop export failed: ${JSON.stringify(photoshopResult)}`);
    if (!illustratorResult.ok) throw new Error(`Illustrator export failed: ${JSON.stringify(illustratorResult)}`);
    expect((photoshopResult.data as { artifacts: Array<{ sha256?: string }>; manifest: { entries: unknown[] } }).artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((illustratorResult.data as { artifacts: Array<{ sha256?: string }>; manifest: { entries: unknown[] } }).artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    photoshop.socket.close(); illustrator.socket.close(); gateway.socket.close(); await daemon.stop();
  });
});
