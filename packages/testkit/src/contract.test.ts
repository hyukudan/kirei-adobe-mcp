import { describe, expect, it } from "vitest";
import { createMockBridges, runBridgeContract } from "./index.js";

describe("shared Adobe bridge contract", () => {
  it("enforces stale revisions, idempotency and verified snapshots for every test adapter", async () => {
    for (const bridge of createMockBridges()) {
      const report = await runBridgeContract(bridge);
      expect(report.staleRevisionRejected).toBe(true);
      expect(report.operationIdempotent).toBe(true);
      expect(report.snapshotVerified).toBe(true);
    }
  });
});
