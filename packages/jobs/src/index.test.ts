import { describe, expect, it } from "vitest";
import { JobStore } from "./index.js";
describe("jobs", () => { it("keeps terminal jobs immutable", () => { const store = new JobStore(); store.create({ id: "j", kind: "export", status: "queued", progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), artifacts: [] }); store.transition("j", "succeeded"); expect(() => store.transition("j", "running")).toThrow("terminal"); }); });
