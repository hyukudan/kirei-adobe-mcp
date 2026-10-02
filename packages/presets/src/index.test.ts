import { describe, expect, it } from "vitest";
import { getPreset, listPresets, verifyPreset } from "./index.js";

describe("shared presets", () => { it("contains verifiable LUT, typography and animation recipes", () => { expect(listPresets()).toHaveLength(6); expect(verifyPreset(getPreset("lut.neutral-film"))).toBe(true); expect(listPresets("animation")).toHaveLength(2); }); });
