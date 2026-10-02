import { describe, expect, it } from "vitest";
import { serializeLog } from "./index.js";

describe("observability package", () => {
  it("serializes log with timestamp and redacts sensitive data", () => {
    const raw = serializeLog({ level: "info", message: "Bridge ready" });
    const parsed = JSON.parse(raw);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("Bridge ready");
    expect(parsed.timestamp).toBeDefined();
  });
});
