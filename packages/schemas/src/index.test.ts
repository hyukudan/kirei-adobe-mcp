import { describe, expect, it } from "vitest";
import { ArtifactRef, MutationOptions, TargetRef } from "./index.js";

describe("schemas", () => {
  it("rejects unknown public fields", () => { expect(TargetRef.safeParse({ app: "photoshop", extra: true }).success).toBe(false); });
  it("applies safe defaults", () => { const result = MutationOptions.parse({ operationId: "00000000-0000-4000-8000-000000000000" }); expect(result.atomic).toBe(true); expect(result.verification).toBe("state"); });
  it("validates content-addressed artifact hashes", () => { expect(ArtifactRef.safeParse({ artifactId: "a", kind: "file", displayName: "x", sha256: "0".repeat(64) }).success).toBe(true); expect(ArtifactRef.safeParse({ artifactId: "a", kind: "file", displayName: "x", sha256: "bad" }).success).toBe(false); });
});
