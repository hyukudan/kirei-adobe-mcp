import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRiskAllowed, calculateRisk, redact, validateGrantedPath } from "./index.js";

describe("policy", () => { it("allows only canonical paths under configured roots", () => { const root = mkdtempSync(join(tmpdir(), "adobe-mcp-")); mkdirSync(join(root, "files")); const file = join(root, "files", "a.txt"); writeFileSync(file, "ok"); expect(validateGrantedPath(file, [root], "read")).toBe(file); expect(() => validateGrantedPath(join(root, "..", "outside.txt"), [root], "write")).toThrow("outside"); }); it("enforces risk approvals", () => { expect(calculateRisk("R2", { entities: 51, files: 0, bytes: 0, minutes: 0 })).toBe("R3"); expect(() => assertRiskAllowed("R3", false, false)).toThrow("approval"); expect(() => assertRiskAllowed("R4", true, true, true)).toThrow("R4"); }); it("redacts secrets", () => expect(redact({ token: "top-secret", message: "safe" })).toEqual({ token: "[REDACTED]", message: "safe" })); });
