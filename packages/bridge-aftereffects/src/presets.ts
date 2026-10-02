import { createHash } from "node:crypto";
import { AfterEffectsPreset, AfterEffectsPresetApply, AfterEffectsPresetApplyResult } from "@adobe-mcp/schemas";

export const AFTER_EFFECTS_PRESETS = [
  { id: "effect.fast-blur", name: "Fast Blur", matchName: "ADBE Fast Blur", category: "effect", recipe: { blur: 12 }, version: "1" },
  { id: "effect.curves", name: "Curves", matchName: "ADBE CurvesCustom", category: "effect", recipe: { channel: "RGB" }, version: "1" },
  { id: "effect.color-balance", name: "Color Balance", matchName: "ADBE Color Balance", category: "effect", recipe: { preserveLuminosity: true }, version: "1" },
  { id: "animation.wiggle", name: "Procedural Wiggle", matchName: "ADBE Wiggle", category: "animation", recipe: { expression: "wiggle(frequency, amplitude)" }, version: "1" },
  { id: "animation.inertial-bounce", name: "Inertial Bounce", matchName: "ADBE Expression", category: "animation", recipe: { expression: "inertialBounce(amp, freq, decay)" }, version: "1" },
  { id: "camera.orbital-3d", name: "Orbital 3D Camera", matchName: "ADBE Camera", category: "camera", recipe: { rig: "orbit", threeD: true }, version: "1" },
  { id: "motion.motion-blur", name: "Motion Blur", matchName: "ADBE Motion Blur", category: "animation", recipe: { enabled: true }, version: "1" },
  { id: "tracking.null-parent", name: "Null Parent Tracking", matchName: "ADBE Layer Control", category: "tracking", recipe: { parent: "tracked-null" }, version: "1" },
] as const;

function presetHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export const AFTER_EFFECTS_PRESET_CATALOG = AFTER_EFFECTS_PRESETS.map((preset) => AfterEffectsPreset.parse(preset));
export function listAfterEffectsPresets(): readonly ReturnType<typeof AfterEffectsPreset.parse>[] { return AFTER_EFFECTS_PRESETS.map((preset) => AfterEffectsPreset.parse(preset)); }
export function readAfterEffectsPreset(id: string): ReturnType<typeof AfterEffectsPreset.parse> { const preset = AFTER_EFFECTS_PRESETS.find((entry) => entry.id === id); if (!preset) throw new Error(`NOT_FOUND: After Effects preset ${id}`); return AfterEffectsPreset.parse(preset); }
export function listAfterEffectsPresetResources(): readonly { uri: string; name: string; mimeType: "application/json" }[] { return AFTER_EFFECTS_PRESETS.map((preset) => ({ uri: `adobe://aftereffects/presets/${preset.id}`, name: preset.name, mimeType: "application/json" as const })); }
export function readAfterEffectsPresetResource(uri: string): string { const prefix = "adobe://aftereffects/presets/"; if (!uri.startsWith(prefix)) throw new Error("INVALID_ARGUMENT: invalid After Effects preset resource URI"); return JSON.stringify(readAfterEffectsPreset(uri.slice(prefix.length))); }

export interface AfterEffectsPresetTransport { request(method: "adobe.aftereffects.preset.apply", payload: Record<string, unknown>): Promise<unknown>; }
export async function applyAfterEffectsPreset(transport: AfterEffectsPresetTransport, request: ReturnType<typeof AfterEffectsPresetApply.parse>): Promise<ReturnType<typeof AfterEffectsPresetApplyResult.parse>> {
  const parsed = AfterEffectsPresetApply.parse(request);
  const preset = readAfterEffectsPreset(parsed.presetId);
  const value = await transport.request("adobe.aftereffects.preset.apply", { ...parsed, preset: { ...preset, recipe: { ...preset.recipe, ...parsed.parameters } } });
  return AfterEffectsPresetApplyResult.parse(value);
}

export function presetFingerprint(id: string): string { return presetHash(readAfterEffectsPreset(id)); }
