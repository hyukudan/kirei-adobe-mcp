import { PremiereLumetriGrade, PremiereMogrtParametrize, PremiereProjectOrganize, z } from "@adobe-mcp/schemas";

export interface MogrtManifestParameter { readonly key: string; readonly type: "text" | "color" | "number" | "boolean" | "media"; readonly writable: boolean; readonly mediaSlot?: boolean; }
export interface MogrtParameterWrite { readonly key: string; readonly value: unknown; readonly mediaArtifactUri?: string; }

export function compileMogrtParameters(input: z.input<typeof PremiereMogrtParametrize>, manifest: readonly MogrtManifestParameter[]): readonly MogrtParameterWrite[] {
  const value = PremiereMogrtParametrize.parse(input);
  const byKey = new Map(manifest.map((item) => [item.key, item]));
  return value.parameters.map((parameter) => {
    const known = byKey.get(parameter.key);
    if (!known || !known.writable || known.type !== parameter.type) throw new Error(`UNSUPPORTED_CAPABILITY: MOGRT parameter ${parameter.key} is not writable or has a mismatched type`);
    if (parameter.type === "media" && !parameter.mediaArtifactUri) throw new Error(`INVALID_ARGUMENT: media parameter ${parameter.key} requires mediaArtifactUri`);
    return { key: parameter.key, value: parameter.value, ...(parameter.mediaArtifactUri ? { mediaArtifactUri: parameter.mediaArtifactUri } : {}) };
  });
}

export function compileLumetriRecipe(input: z.input<typeof PremiereLumetriGrade>): Record<string, unknown> {
  const value = PremiereLumetriGrade.parse(input);
  return { basic: value.basic ?? {}, wheels: value.wheels ?? {}, curves: value.curves ?? {}, ...(value.lut ? { lut: value.lut } : {}), manifestVersion: "lumetri-1" };
}

export function compileProjectOrganization(input: z.input<typeof PremiereProjectOrganize>): Record<string, unknown> {
  const value = PremiereProjectOrganize.parse(input);
  return { bins: value.createBins, imports: value.imports.map((item) => ({ ...item, labelColor: item.labelColor })), operationId: value.options.operationId };
}
