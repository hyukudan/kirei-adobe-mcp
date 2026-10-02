import { describe, expect, it } from "vitest";
import { TOOL_CATALOG, getTool, riskForScope } from "./index.js";

describe("tool catalog", () => { it("contains the public tools including preview and visual verification", () => expect(TOOL_CATALOG).toHaveLength(42)); it("has schemas and risk metadata for every tool", () => { for (const tool of TOOL_CATALOG) { expect(tool.input).toBeDefined(); expect(tool.output).toBeDefined(); expect(tool.risk).toMatch(/^R[0-4]$/); } }); it("elevates large scopes", () => expect(riskForScope("R2", 51, 0, 0, 0)).toBe("R3")); it("rejects unknown tools", () => expect(() => getTool("adobe.unknown")).toThrow("NOT_FOUND")); });
