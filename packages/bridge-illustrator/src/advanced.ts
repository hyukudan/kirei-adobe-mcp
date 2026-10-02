import { IllustratorImageTrace, IllustratorSwatchesCreate, IllustratorVariableTypography, z } from "@adobe-mcp/schemas";

export function buildImageTrace(input: z.input<typeof IllustratorImageTrace>): Record<string, unknown> {
  const value = IllustratorImageTrace.parse(input);
  const preset = { logo: "TRACING_PRESET_LOGO", silhouette: "TRACING_PRESET_SILHOUETTE", sketch: "TRACING_PRESET_SKETCH", highFidelityPhoto: "TRACING_PRESET_HIGH_FIDELITY_PHOTO" }[value.preset];
  return { imageId: value.imageId, preset, ...(value.threshold === undefined ? {} : { threshold: value.threshold }), ...(value.colors === undefined ? {} : { colors: value.colors }) };
}

export function buildGlobalSwatches(input: z.input<typeof IllustratorSwatchesCreate>): readonly Record<string, unknown>[] {
  const value = IllustratorSwatchesCreate.parse(input);
  return value.colors.map((entry) => ({ name: entry.name, color: entry.color, global: entry.global, harmony: value.harmony }));
}

export function buildVariableTypography(input: z.input<typeof IllustratorVariableTypography>): Record<string, unknown> {
  const value = IllustratorVariableTypography.parse(input);
  return { textItemId: value.textItemId, ...(value.fontFamily ? { fontFamily: value.fontFamily } : {}), axes: value.axes };
}
