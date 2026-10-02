import { describe, expect, it } from "vitest";
import { parsePolicy } from "./index.js";

describe("config package", () => {
  it("parses valid policy config", () => {
    const policy = parsePolicy({
      apps: ["photoshop"],
      roots: ["D:/test"],
      formats: ["png"],
      limits: {
        maxPendingRequests: 10,
        maxFrameBytes: 1024,
        maxEntities: 10,
        maxFiles: 5,
        maxBytes: 1000,
        maxMinutes: 1
      },
      risk: {
        interactiveFrom: "R2",
        denyUnattendedAt: "R3"
      },
      interaction: {
        externalNetwork: false,
        arbitraryExecution: false,
        loopbackOnly: true
      },
      retention: {
        snapshotsDays: 7,
        logsDays: 30
      },
      telemetry: "off"
    });
    expect(policy.apps).toContain("photoshop");
  });
});
