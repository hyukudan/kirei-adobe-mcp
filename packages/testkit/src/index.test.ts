import { describe, expect, it } from "vitest";
import { createMockBridges } from "./index.js";

describe("testkit package", () => {
  it("creates mock bridges for all four Adobe applications", () => {
    const bridges = createMockBridges();
    expect(bridges).toHaveLength(4);
    const apps = bridges.map((b) => b.descriptor.app);
    expect(apps).toContain("photoshop");
    expect(apps).toContain("illustrator");
    expect(apps).toContain("after-effects");
    expect(apps).toContain("premiere-pro");
  });
});
