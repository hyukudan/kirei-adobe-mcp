import { describe, expect, it } from "vitest";
import { computeAuthProof, verifyAuthProof, BridgeHello } from "./index.js";

describe("protocol", () => {
  it("verifies challenge HMAC and rejects tampering", () => {
    const proof = computeAuthProof("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "client-nonce-123456", "server-nonce-123456", "00000000-0000-4000-8000-000000000000");
    expect(verifyAuthProof(proof, proof)).toBe(true); expect(verifyAuthProof(proof, proof + "x")).toBe(false);
  });
  it("requires strict bridge hello fields", () => {
    expect(BridgeHello.safeParse({ protocolVersion: "1.0", instanceId: "i", client: { kind: "uxp", app: "photoshop", appVersion: "27" }, capabilities: ["state.read@1"], auth: { scheme: "challenge-hmac", clientNonce: "1234567890123456" } }).success).toBe(true);
    expect(BridgeHello.safeParse({ protocolVersion: "1.0", instanceId: "i", client: { kind: "uxp", app: "photoshop", appVersion: "27" }, capabilities: ["state.read@1"], auth: { scheme: "challenge-hmac", clientNonce: "1234567890123456" }, extra: true }).success).toBe(false);
  });
});
