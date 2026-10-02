import { createHash } from "node:crypto";
import { IllustratorArtboardExport, IllustratorTextSpec, IllustratorVectorOperation, type ArtifactRef } from "@adobe-mcp/schemas";

export type IllustratorVectorCommand = ReturnType<typeof IllustratorVectorOperation.parse>;
export type IllustratorTextCommand = ReturnType<typeof IllustratorTextSpec.parse>;

export function createPath(points: readonly [number, number][], closed = false): IllustratorVectorCommand { return IllustratorVectorOperation.parse({ op: "create-path", points, closed }); }
export function createCompoundPath(itemIds: readonly string[]): IllustratorVectorCommand { return IllustratorVectorOperation.parse({ op: "compound-path", itemIds }); }
export function booleanPath(operation: "union" | "intersection" | "exclude", itemIds: readonly string[]): IllustratorVectorCommand { return IllustratorVectorOperation.parse({ op: "boolean", operation, itemIds }); }
export function setTypography(spec: ReturnType<typeof IllustratorTextSpec.parse>): IllustratorTextCommand { return IllustratorTextSpec.parse(spec); }

export function calculateDownscaledDimensions(width: number, height: number, scale: number, maxDimension?: number): { width: number; height: number; scale: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(scale) || scale <= 0) throw new Error("INVALID_ARGUMENT: invalid artboard dimensions");
  const limit = maxDimension === undefined ? Number.POSITIVE_INFINITY : maxDimension;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("INVALID_ARGUMENT: invalid maxDimension");
  const resolvedScale = Math.min(scale, limit / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * resolvedScale)), height: Math.max(1, Math.round(height * resolvedScale)), scale: resolvedScale };
}

export interface ArtboardRaster { readonly artboardId: string; readonly width: number; readonly height: number; readonly bytes: Uint8Array; readonly format: "svg" | "png"; }
export interface ArtboardExporter { export(artboardId: string, format: "svg" | "png", dimensions: { width: number; height: number }): Promise<Uint8Array>; }
export interface ArtboardExportManifestEntry { readonly artboardId: string; readonly fileName: string; readonly width: number; readonly height: number; readonly sha256: string; readonly sizeBytes: number; }
export interface ArtboardExportManifest { readonly version: "1"; readonly entries: readonly ArtboardExportManifestEntry[]; readonly sha256: string; readonly artifacts: readonly ArtifactRef[]; }

export async function exportArtboards(exporter: ArtboardExporter, request: ReturnType<typeof IllustratorArtboardExport.parse>, artboards: readonly { id: string; width: number; height: number }[]): Promise<ArtboardExportManifest> {
  const parsed = IllustratorArtboardExport.parse(request);
  const selected = artboards.filter((artboard) => parsed.artboardIds.includes(artboard.id));
  if (selected.length !== parsed.artboardIds.length) throw new Error("NOT_FOUND: one or more artboards are unavailable");
  const entries: ArtboardExportManifestEntry[] = [];
  const artifacts: ArtifactRef[] = [];
  for (const artboard of selected) {
    const dimensions = calculateDownscaledDimensions(artboard.width, artboard.height, parsed.scale, parsed.maxDimension);
    const bytes = await exporter.export(artboard.id, parsed.format, dimensions);
    const digest = createHash("sha256").update(bytes).digest("hex");
    entries.push({ artboardId: artboard.id, fileName: `${artboard.id}.${parsed.format}`, width: dimensions.width, height: dimensions.height, sha256: digest, sizeBytes: bytes.byteLength });
    artifacts.push({ artifactId: `artboard-${digest.slice(0, 16)}`, kind: "file", displayName: `${artboard.id}.${parsed.format}`, mediaType: parsed.format === "svg" ? "image/svg+xml" : "image/png", sizeBytes: bytes.byteLength, sha256: digest, provenance: { app: "illustrator" } });
  }
  const manifestHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { version: "1", entries, sha256: manifestHash, artifacts };
}
