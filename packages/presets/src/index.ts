import { createHash } from "node:crypto";
import { Preset } from "@adobe-mcp/schemas";

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export const SHARED_PRESETS = [
  { id: "lut.cinematic-teal-orange", kind: "lut", name: "Cinematic Teal Orange", version: "1", payload: { format: "cube", size: 33, values: [] as readonly number[] } },
  { id: "lut.80s-horror-film", kind: "lut", name: "80s Retro Horror Film", version: "1", payload: { format: "cube", size: 33, values: [] as readonly number[] } },
  { id: "lut.cyberpunk-neon", kind: "lut", name: "Cyberpunk Neon", version: "1", payload: { format: "cube", size: 33, values: [] as readonly number[] } },
  { id: "lut.neutral-film", kind: "lut", name: "Neutral Film", version: "1", payload: { format: "cube", size: 33, values: [] as readonly number[] } },
  { id: "typography.80s-horror-title", kind: "typography", name: "80s Horror Title", version: "1", payload: { family: "Impact", weight: 900, sizePx: 84, tracking: 150 } },
  { id: "typography.editorial-sans", kind: "typography", name: "Editorial Sans", version: "1", payload: { family: "Source Sans 3", weight: 600, tracking: 0 } },
  { id: "typography.caption-safe", kind: "typography", name: "Caption Safe", version: "1", payload: { family: "Arial", weight: 700, sizePx: 42, outlinePx: 4 } },
  { id: "animation.wiggle", kind: "animation", name: "Wiggle", version: "1", payload: { frequency: 2, amplitude: 18 } },
  { id: "animation.inertial-bounce", kind: "animation", name: "Inertial Bounce", version: "1", payload: { frequency: 4, decay: 5 } },
] as const;

export const PRESET_LIBRARY: readonly ReturnType<typeof Preset.parse>[] = SHARED_PRESETS.map((preset) => Preset.parse({ ...preset, sha256: hash(preset) }));
export function listPresets(kind?: ReturnType<typeof Preset.shape.kind.parse>): readonly ReturnType<typeof Preset.parse>[] { return kind === undefined ? PRESET_LIBRARY : PRESET_LIBRARY.filter((preset) => preset.kind === kind); }
export function getPreset(id: string): ReturnType<typeof Preset.parse> { const preset = PRESET_LIBRARY.find((candidate) => candidate.id === id); if (!preset) throw new Error(`NOT_FOUND: preset ${id}`); return preset; }
export function verifyPreset(preset: ReturnType<typeof Preset.parse>): boolean { return hash({ id: preset.id, kind: preset.kind, name: preset.name, version: preset.version, payload: preset.payload }) === preset.sha256; }
