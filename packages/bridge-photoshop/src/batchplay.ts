import { createHash } from "node:crypto";
import type { z } from "zod";
import { PhotoshopAdjustmentSpec, PhotoshopBatchPlayCommand, PhotoshopBatchPlayDescriptor, PhotoshopFilterSpec, PhotoshopLayerMaskSpec, PhotoshopSmartObjectSpec, type ArtifactRef } from "@adobe-mcp/schemas";

export type BatchPlayDescriptor = ReturnType<typeof PhotoshopBatchPlayDescriptor.parse>;
export type BatchPlayCommand = ReturnType<typeof PhotoshopBatchPlayCommand.parse>;
export type LayerMaskInput = z.input<typeof PhotoshopLayerMaskSpec>;
export type AdjustmentInput = z.input<typeof PhotoshopAdjustmentSpec>;
export type SmartObjectInput = z.input<typeof PhotoshopSmartObjectSpec>;

function command(action: BatchPlayCommand["action"], descriptor: Record<string, unknown>): BatchPlayCommand {
  return PhotoshopBatchPlayCommand.parse({ action, descriptor, options: { dialogMode: "silent", synchronousExecution: true, modalBehavior: "fail" } });
}
function target(layerId: string): Array<Record<string, unknown>> { return [{ _ref: "layer", _id: layerId }]; }

export function createSelectionMask(spec: LayerMaskInput): BatchPlayCommand {
  const value = PhotoshopLayerMaskSpec.parse(spec);
  return command("create", { _obj: "make", _target: [{ _ref: "channel" }], at: { _obj: "channel", _ref: "channel", _name: "mask" }, using: { _obj: "selection" }, layerId: value.layerId, invert: value.invert, density: value.density, featherPixels: value.featherPixels });
}
export function createVectorMask(spec: LayerMaskInput): BatchPlayCommand {
  const value = PhotoshopLayerMaskSpec.parse({ ...spec, kind: "vector" });
  return command("create", { _obj: "make", _target: [{ _ref: "path" }], at: { _obj: "path", _name: "vector mask" }, layerId: value.layerId, invert: value.invert, density: value.density, featherPixels: value.featherPixels });
}
export function invertLayerMask(layerId: string): BatchPlayCommand { return command("apply", { _obj: "invert", _target: target(layerId), channel: "mask" }); }
export function setMaskDensity(layerId: string, density: number): BatchPlayCommand { const parsed = PhotoshopLayerMaskSpec.parse({ layerId, kind: "selection", density }); return command("set", { _obj: "channel", _target: target(layerId), density: parsed.density }); }
export function setMaskFeather(layerId: string, featherPixels: number): BatchPlayCommand { const parsed = PhotoshopLayerMaskSpec.parse({ layerId, kind: "selection", featherPixels }); return command("set", { _obj: "channel", _target: target(layerId), feather: parsed.featherPixels }); }

export function createAdjustmentLayer(spec: AdjustmentInput): BatchPlayCommand {
  const value = PhotoshopAdjustmentSpec.parse(spec);
  return command("create", { _obj: "adjustmentLayer", type: value.kind, layerId: value.layerId, properties: value.properties });
}
export function createCurvesAdjustment(properties: Record<string, unknown> = {}): BatchPlayCommand { return createAdjustmentLayer({ kind: "curves", properties }); }
export function createLevelsAdjustment(properties: Record<string, unknown> = {}): BatchPlayCommand { return createAdjustmentLayer({ kind: "levels", properties }); }
export function createHueSaturationAdjustment(properties: Record<string, unknown> = {}): BatchPlayCommand { return createAdjustmentLayer({ kind: "hue-saturation", properties }); }
export function createColorBalanceAdjustment(properties: Record<string, unknown> = {}): BatchPlayCommand { return createAdjustmentLayer({ kind: "color-balance", properties }); }
export function createBrightnessContrastAdjustment(properties: Record<string, unknown> = {}): BatchPlayCommand { return createAdjustmentLayer({ kind: "brightness-contrast", properties }); }

export function createSmartObject(spec: SmartObjectInput): BatchPlayCommand {
  const value = PhotoshopSmartObjectSpec.parse(spec);
  return command("create", { _obj: "newPlacedLayer", action: value.action, layerId: value.layerId, artifactId: value.artifactId, grantId: value.grantId });
}
export function replaceLinkedSmartObject(layerId: string, artifactId: string): BatchPlayCommand { return createSmartObject({ action: "replace-linked", layerId, artifactId }); }
export function editEmbeddedSmartObject(layerId: string): BatchPlayCommand { return createSmartObject({ action: "edit-embedded", layerId }); }
export function applyNeuralFilter(parameters: Record<string, unknown> = {}): BatchPlayCommand { return command("apply", { _obj: "neuralFilter", parameters: PhotoshopFilterSpec.parse({ filter: "neural", parameters }).parameters }); }
export function applyCameraRaw(parameters: Record<string, unknown> = {}): BatchPlayCommand { return command("apply", { _obj: "cameraRawFilter", parameters: PhotoshopFilterSpec.parse({ filter: "camera-raw", parameters }).parameters }); }

export function buildBatchPlay(commands: readonly BatchPlayCommand[]): readonly BatchPlayCommand[] { return commands.map((entry) => PhotoshopBatchPlayCommand.parse(entry)); }

export interface LayerExportInput { readonly layerId: string; readonly name: string; readonly format: "png" | "psd"; readonly bytes: Uint8Array; readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; }
export interface LayerExportManifestEntry { readonly layerId: string; readonly name: string; readonly fileName: string; readonly sha256: string; readonly sizeBytes: number; readonly bounds?: LayerExportInput["bounds"]; }
export interface LayerExportManifest { readonly version: "1"; readonly sourceDocumentId: string; readonly createdAt: string; readonly entries: readonly LayerExportManifestEntry[]; readonly sha256: string; readonly artifact: ArtifactRef; }

export function sha256Bytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function buildLayerExportManifest(sourceDocumentId: string, layers: readonly LayerExportInput[]): LayerExportManifest {
  const entries = layers.map((layer) => ({ layerId: layer.layerId, name: layer.name, fileName: `${layer.layerId}.${layer.format}`, sha256: sha256Bytes(layer.bytes), sizeBytes: layer.bytes.byteLength, ...(layer.bounds === undefined ? {} : { bounds: layer.bounds }) }));
  const digest = sha256Bytes(new TextEncoder().encode(JSON.stringify({ sourceDocumentId, entries })));
  return { version: "1", sourceDocumentId, createdAt: new Date().toISOString(), entries, sha256: digest, artifact: { artifactId: `layers-${digest.slice(0, 16)}`, kind: "directory", displayName: "photoshop-layers", mediaType: "application/json", sizeBytes: layers.reduce((total, layer) => total + layer.bytes.byteLength, 0), sha256: digest, provenance: { app: "photoshop" } } };
}
export function exportLayers(sourceDocumentId: string, layers: readonly LayerExportInput[]): LayerExportManifest { return buildLayerExportManifest(sourceDocumentId, layers); }
