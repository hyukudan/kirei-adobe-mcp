import { z } from "zod";

const boundedText = (max = 256) => z.string().min(1).max(max);
export const AppId = z.enum(["photoshop", "illustrator", "after-effects", "premiere-pro"]);
export const OpaqueId = boundedText(256);
export const Revision = boundedText(128);
export const OperationId = z.string().uuid();
export const TargetRef = z.object({ app: AppId, instanceId: OpaqueId.optional(), projectId: OpaqueId.optional(), documentId: OpaqueId.optional(), entityId: OpaqueId.optional() }).strict();
export const RationalTime = z.object({ ticks: z.string().regex(/^-?\d+$/).max(32), timebase: z.string().regex(/^[1-9]\d*$/).max(12) }).strict();
export const PageRequest = z.object({ cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200).default(50) }).strict();
export const ReadOptions = z.object({ fields: z.array(boundedText(128)).max(64).optional(), depth: z.number().int().min(0).max(4).default(1), page: PageRequest.optional() }).strict();
export const MutationOptions = z.object({ operationId: OperationId, expectedRevision: Revision.optional(), dryRun: z.boolean().default(false), atomic: z.boolean().default(true), conflictPolicy: z.enum(["fail", "rebase-safe"]).default("fail"), verification: z.enum(["none", "state", "render-proof"]).default("state"), approvalToken: z.string().min(1).max(4096).optional(), explicitConfirmation: z.boolean().optional() }).strict();
export const FileGrant = z.object({ grantId: OpaqueId, access: z.enum(["read", "write", "read-write"]), suggestedName: z.string().max(255).optional() }).strict();
export const ResolvedFileGrant = FileGrant.extend({ canonicalPath: z.string().min(1).max(4096), expiresAt: z.string().datetime(), issuedAt: z.string().datetime() }).strict();
export const ArtifactRef = z.object({ artifactId: OpaqueId, kind: z.enum(["file", "directory", "snapshot", "preview", "report"]), displayName: boundedText(255), mediaType: z.string().max(256).optional(), sizeBytes: z.number().int().nonnegative().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), expiresAt: z.string().datetime().optional(), provenance: z.object({ sourceOperationId: OperationId.optional(), sourceArtifactId: OpaqueId.optional(), app: AppId.optional() }).strict().optional() }).strict();
export const Color = z.object({ space: z.enum(["rgb", "cmyk", "lab", "gray"]), components: z.array(z.number().min(0).max(1)).min(1).max(4), alpha: z.number().min(0).max(1).default(1) }).strict();
export const Transform2D = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const Bounds = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative(), unit: z.enum(["px", "pt", "mm", "in"]) }).strict();
export const PreviewCaptureInput = z.object({ target: TargetRef, format: z.enum(["png", "jpeg"]).default("png"), maxDimension: z.number().int().min(64).max(4096).default(1024), time: RationalTime.optional() }).strict();
export const PreviewCaptureData = z.object({ imageBase64: z.string().min(1), mimeType: z.enum(["image/png", "image/jpeg"]), width: z.number().int().positive(), height: z.number().int().positive(), revision: Revision, capturedAt: z.string().datetime() }).strict();
export const PreviewCaptureOutput = z.object({ ok: z.literal(true), data: PreviewCaptureData }).or(z.object({ ok: z.literal(false), error: z.unknown() }).strict());
export const VisualVerifyInput = z.object({ target: TargetRef, baselineImageBase64: z.string().min(1), tolerance: z.number().min(0).max(1).default(0.05), time: RationalTime.optional() }).strict();
export const VisualVerifyData = z.object({ match: z.boolean(), diffScore: z.number().min(0).max(1), currentImageBase64: z.string().min(1).optional(), details: z.record(z.string(), z.unknown()) }).strict();
export const VisualVerifyOutput = z.object({ ok: z.literal(true), data: VisualVerifyData }).or(z.object({ ok: z.literal(false), error: z.unknown() }).strict());

export const PremiereTimeSeconds = z.number().finite().nonnegative();
export const PremiereSubtitle = z.object({ startTime: PremiereTimeSeconds, endTime: PremiereTimeSeconds, text: z.string().max(100000) }).strict();
export const PsLayer = z.object({ id: OpaqueId, name: boundedText(512), kind: z.enum(["pixel", "text", "shape", "group", "adjustment", "smart-object", "fill", "unknown"]), parentId: OpaqueId.nullable(), visible: z.boolean(), locked: z.boolean(), opacity: z.number().min(0).max(1), blendMode: boundedText(128), bounds: Bounds, selected: z.boolean() }).strict();
export const PsDocumentState = z.object({ id: OpaqueId, revision: Revision, name: boundedText(512), saved: z.boolean(), width: z.number().positive(), height: z.number().positive(), unit: z.enum(["px", "pt", "mm", "in"]), resolutionPpi: z.number().positive(), mode: z.enum(["bitmap", "grayscale", "rgb", "cmyk", "lab", "multichannel", "duotone", "indexed"]), bitDepth: z.union([z.literal(8), z.literal(16), z.literal(32)]), activeLayerIds: z.array(OpaqueId).max(10000), layers: z.array(PsLayer).max(10000), truncated: z.boolean(), nextCursor: z.string().max(2048).optional() }).strict();
export const AiBounds = z.object({ left: z.number().finite(), top: z.number().finite(), right: z.number().finite(), bottom: z.number().finite(), unit: z.enum(["pt", "px", "mm", "in"]) }).strict();
export const AiItem = z.object({ id: OpaqueId, name: boundedText(512), type: z.enum(["path", "compound-path", "group", "text", "placed", "raster", "symbol", "mesh", "unknown"]), layerId: OpaqueId, parentId: OpaqueId.nullable(), bounds: AiBounds, visible: z.boolean(), locked: z.boolean(), selected: z.boolean(), opacity: z.number().min(0).max(1), geometry: z.record(z.string().max(128), z.unknown()).optional(), fillColor: Color.optional(), strokeColor: Color.optional() }).strict();
export const AiDocumentState = z.object({ id: OpaqueId, revision: Revision, name: boundedText(512), saved: z.boolean(), colorSpace: z.enum(["rgb", "cmyk"]), activeArtboardId: OpaqueId, artboards: z.array(z.object({ id: OpaqueId, name: boundedText(512), bounds: AiBounds }).strict()).max(1000), layers: z.array(z.object({ id: OpaqueId, name: boundedText(512), visible: z.boolean(), locked: z.boolean(), itemCount: z.number().int().nonnegative() }).strict()).max(10000), items: z.array(AiItem).max(100000), truncated: z.boolean(), nextCursor: z.string().max(2048).optional() }).strict();
export const AeValue = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.array(z.number().finite()).max(16)]);
export const AeLayer = z.object({ id: OpaqueId, index: z.number().int().positive(), name: boundedText(512), type: z.enum(["av", "text", "shape", "camera", "light", "null", "adjustment", "unknown"]), sourceId: OpaqueId.optional(), parentId: OpaqueId.nullable(), enabled: z.boolean(), locked: z.boolean(), threeD: z.boolean(), inPoint: RationalTime, outPoint: RationalTime, startTime: RationalTime, selected: z.boolean() }).strict();
export const AeCompState = z.object({ id: OpaqueId, revision: Revision, name: boundedText(512), width: z.number().int().positive(), height: z.number().int().positive(), pixelAspect: z.number().positive(), frameRate: z.number().positive(), duration: RationalTime, workArea: z.object({ start: RationalTime, duration: RationalTime }).strict(), layers: z.array(AeLayer).max(10000), truncated: z.boolean(), nextCursor: z.string().max(2048).optional() }).strict();
export const PrClip = z.object({ id: OpaqueId, name: boundedText(512), projectItemId: OpaqueId.optional(), trackId: OpaqueId, mediaType: z.enum(["video", "audio", "caption", "unknown"]), start: RationalTime, end: RationalTime, sourceIn: RationalTime, sourceOut: RationalTime, speed: z.number().finite(), enabled: z.boolean() }).strict();
export const PrTrack = z.object({ id: OpaqueId, index: z.number().int().nonnegative(), name: boundedText(512), type: z.enum(["video", "audio", "caption"]), locked: z.boolean(), muted: z.boolean().optional(), targeted: z.boolean().optional(), clips: z.array(PrClip).max(100000) }).strict();
export const PrSequenceState = z.object({ id: OpaqueId, revision: Revision, name: boundedText(512), frameSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(), frameRate: z.number().positive(), duration: RationalTime, tracks: z.array(PrTrack).max(1000), markers: z.array(z.object({ id: OpaqueId, name: boundedText(512), start: RationalTime, duration: RationalTime, comment: z.string().max(4096).optional() }).strict()).max(100000), truncated: z.boolean(), nextCursor: z.string().max(2048).optional() }).strict();

export const PhotoshopLayerCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), tempId: boundedText(128), kind: z.enum(["pixel", "text", "shape", "group", "adjustment"]), name: boundedText(512), parentId: OpaqueId.optional(), properties: z.record(z.string().max(128), z.unknown()).default({}) }).strict(),
  z.object({ op: z.literal("set"), layerId: OpaqueId, patch: z.object({ name: z.string().max(512).optional(), visible: z.boolean().optional(), opacity: z.number().min(0).max(1).optional(), blendMode: z.string().max(128).optional(), locked: z.boolean().optional() }).strict() }).strict(),
  z.object({ op: z.literal("transform"), layerIds: z.array(OpaqueId).min(1).max(500), matrix: Transform2D }).strict(),
  z.object({ op: z.literal("delete"), layerIds: z.array(OpaqueId).min(1).max(500), permanent: z.literal(false).default(false) }).strict(),
  z.object({ op: z.literal("filter"), layerId: OpaqueId, filter: boundedText(256), parameters: z.record(z.string().max(128), z.unknown()).default({}) }).strict(),
  z.object({ op: z.literal("text"), layerId: OpaqueId, text: z.string().max(1_000_000), properties: z.record(z.string().max(128), z.unknown()).default({}) }).strict()
]);
export const IllustratorEditCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create-layer"), tempId: boundedText(128), name: boundedText(512), parentId: OpaqueId.optional() }).strict(),
  z.object({ op: z.literal("create-item"), tempId: boundedText(128), itemType: z.enum(["rectangle", "ellipse", "path", "text", "group"]), layerId: OpaqueId, geometry: z.record(z.string().max(128), z.unknown()), style: z.record(z.string().max(128), z.unknown()) }).strict(),
  z.object({ op: z.literal("transform"), itemIds: z.array(OpaqueId).min(1).max(500), matrix: Transform2D }).strict(),
  z.object({ op: z.literal("delete"), itemIds: z.array(OpaqueId).min(1).max(500), permanent: z.literal(false).default(false) }).strict(),
  z.object({ op: z.literal("create-path"), points: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(100000), closed: z.boolean().default(false), layerId: OpaqueId.optional(), tempId: OpaqueId.optional(), style: z.record(z.string().max(128), z.unknown()).default({}) }).strict(),
  z.object({ op: z.literal("compound-path"), itemIds: z.array(OpaqueId).min(2).max(1000), tempId: OpaqueId.optional() }).strict(),
  z.object({ op: z.literal("boolean"), operation: z.enum(["union", "intersection", "exclude"]), itemIds: z.array(OpaqueId).min(2).max(1000), tempId: OpaqueId.optional() }).strict(),
  z.object({ op: z.literal("set-typography"), itemId: OpaqueId, text: z.string().max(100000).optional(), fontFamily: z.string().max(256).optional(), fontSize: z.number().positive().max(10000).optional(), kerning: z.number().finite().min(-10000).max(10000).optional(), tracking: z.number().finite().min(-10000).max(10000).optional(), alignment: z.enum(["left", "center", "right", "justify"]).optional() }).strict()
]);
export const AfterEffectsEditCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create-layer"), tempId: boundedText(128), kind: z.enum(["solid", "text", "shape", "null", "camera", "light"]), name: boundedText(512), options: z.record(z.string().max(128), z.unknown()).default({}) }).strict(),
  z.object({ op: z.literal("set-property"), layerId: OpaqueId, propertyPath: z.array(boundedText(128)).min(1).max(16), value: AeValue }).strict(),
  z.object({ op: z.literal("set-keyframes"), layerId: OpaqueId, propertyPath: z.array(boundedText(128)).min(1).max(16), mode: z.enum(["merge", "replace-range"]), keyframes: z.array(z.object({ time: RationalTime, value: AeValue, interpolation: z.enum(["linear", "bezier", "hold"]) }).strict()).min(1).max(5000) }).strict(),
  z.object({ op: z.literal("delete-layer"), layerIds: z.array(OpaqueId).min(1).max(500), permanent: z.literal(false).default(false) }).strict()
]);
export const PremiereTimelineCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), projectItemId: OpaqueId, trackId: OpaqueId, at: RationalTime, sourceIn: RationalTime.optional(), sourceOut: RationalTime.optional(), mode: z.enum(["insert", "overwrite"]) }).strict(),
  z.object({ op: z.literal("move"), clipIds: z.array(OpaqueId).min(1).max(500), delta: RationalTime, targetTrackId: OpaqueId.optional() }).strict(),
  z.object({ op: z.literal("trim"), clipId: OpaqueId, edge: z.enum(["in", "out"]), to: RationalTime, ripple: z.boolean() }).strict(),
  z.object({ op: z.literal("cut"), trackIds: z.array(OpaqueId).min(1).max(500), at: RationalTime }).strict(),
  z.object({ op: z.literal("delete"), clipIds: z.array(OpaqueId).min(1).max(500), ripple: z.boolean(), permanent: z.literal(false).default(false) }).strict(),
  z.object({ op: z.literal("slip"), clipId: OpaqueId, delta: RationalTime }).strict(),
  z.object({ op: z.literal("ripple-delete"), clipIds: z.array(OpaqueId).min(1).max(500) }).strict(),
  z.object({ op: z.literal("speed"), clipId: OpaqueId, speed: z.number().finite().positive().max(1000) }).strict(),
  z.object({ op: z.literal("mute"), clipIds: z.array(OpaqueId).min(1).max(500), muted: z.boolean() }).strict(),
  z.object({ op: z.literal("overwrite"), projectItemId: OpaqueId, trackId: OpaqueId, at: RationalTime, sourceIn: RationalTime.optional(), sourceOut: RationalTime.optional() }).strict(),
  z.object({ op: z.literal("splitClip"), trackIndex: z.number().int().nonnegative(), timeSeconds: PremiereTimeSeconds }).strict(),
  z.object({ op: z.literal("moveClip"), clipId: OpaqueId, targetTrackIndex: z.number().int().nonnegative(), targetTimeSeconds: PremiereTimeSeconds }).strict(),
  z.object({ op: z.literal("trimClip"), clipId: OpaqueId, inPoint: PremiereTimeSeconds, outPoint: PremiereTimeSeconds }).strict(),
  z.object({ op: z.literal("rippleDelete"), trackIndex: z.number().int().nonnegative(), startTime: PremiereTimeSeconds, endTime: PremiereTimeSeconds }).strict(),
  z.object({ op: z.literal("applyTransition"), trackIndex: z.number().int().nonnegative(), clipIdA: OpaqueId, clipIdB: OpaqueId, transitionType: z.enum(["cross-dissolve", "dip-to-black", "exponential-fade"]), durationSeconds: z.number().positive() }).strict(),
  z.object({ op: z.literal("setAudioKeyframes"), trackIndex: z.number().int().nonnegative(), clipId: OpaqueId, gainDb: z.number().finite().min(-96).max(24), keyframes: z.array(z.object({ time: PremiereTimeSeconds, value: z.number().finite().min(-96).max(24) }).strict()) }).strict(),
  z.object({ op: z.literal("addSequenceMarker"), timeSeconds: PremiereTimeSeconds, name: z.string().max(512), comment: z.string().max(4096), markerType: z.enum(["comment", "chapter", "web-link", "flash-cue", "segmentation"]) }).strict(),
  z.object({ op: z.literal("addCaptionTrack"), subtitles: z.array(PremiereSubtitle).min(1).max(100000) }).strict()
]);

export const PremiereProjectCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("import"), grantId: OpaqueId.optional(), artifactId: OpaqueId.optional(), binId: OpaqueId.optional(), name: z.string().max(512).optional() }).strict(),
  z.object({ op: z.literal("create-bin"), tempId: OpaqueId, name: boundedText(512), parentBinId: OpaqueId.optional() }).strict(),
  z.object({ op: z.literal("move"), projectItemIds: z.array(OpaqueId).min(1).max(500), binId: OpaqueId }).strict(),
  z.object({ op: z.literal("rename"), projectItemId: OpaqueId, name: boundedText(512) }).strict(),
  z.object({ op: z.literal("save-copy"), destination: FileGrant }).strict()
]).superRefine((command, context) => { if (command.op === "import" && !command.grantId && !command.artifactId) context.addIssue({ code: z.ZodIssueCode.custom, message: "import requires grantId or artifactId" }); });

export const PremiereSequenceCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: boundedText(512), width: z.number().int().positive(), height: z.number().int().positive(), frameRate: z.number().positive() }).strict(),
  z.object({ op: z.literal("delete"), sequenceId: OpaqueId, permanent: z.literal(false).default(false) }).strict(),
  z.object({ op: z.literal("set-sequence"), patch: z.object({ name: boundedText(512).optional(), frameRate: z.number().positive().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }).strict() }).strict()
]);

export const PremiereMarkerCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), tempId: OpaqueId, start: RationalTime, duration: RationalTime, name: z.string().max(512).optional(), comment: z.string().max(4096).optional(), color: Color.optional() }).strict(),
  z.object({ op: z.literal("update"), markerId: OpaqueId, start: RationalTime.optional(), duration: RationalTime.optional(), name: z.string().max(512).optional(), comment: z.string().max(4096).optional(), color: Color.optional() }).strict(),
  z.object({ op: z.literal("delete"), markerIds: z.array(OpaqueId).min(1).max(500), permanent: z.literal(false).default(false) }).strict(),
  z.object({ op: z.literal("add"), sequenceId: OpaqueId, start: RationalTime, duration: RationalTime, name: z.string().max(512), comment: z.string().max(4096).optional() }).strict(),
  z.object({ op: z.literal("remove"), markerId: OpaqueId }).strict()
]);

export const PremiereEffectCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), clipId: OpaqueId, effectId: OpaqueId, propertyPath: z.array(boundedText(128)).min(1).max(16), value: z.unknown() }).strict(),
  z.object({ op: z.literal("set-keyframes"), clipId: OpaqueId, effectId: OpaqueId, propertyPath: z.array(boundedText(128)).min(1).max(16), mode: z.enum(["merge", "replace-range"]), keyframes: z.array(z.object({ time: RationalTime, value: z.unknown(), interpolation: z.enum(["linear", "bezier", "hold"]) }).strict()).min(1).max(5000) }).strict(),
  z.object({ op: z.literal("remove"), clipId: OpaqueId, effectId: OpaqueId }).strict(),
  z.object({ op: z.literal("apply"), clipIds: z.array(OpaqueId).min(1).max(500), effectId: OpaqueId, parameters: z.record(z.string().max(128), z.unknown()).default({}) }).strict()
]);

export const Plan = z.object({ planId: OpaqueId, planHash: z.string().regex(/^[a-f0-9]{64}$/), target: TargetRef, toolName: boundedText(256), risk: z.enum(["R0", "R1", "R2", "R3", "R4"]), scope: z.object({ entities: z.number().int().nonnegative(), files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), minutes: z.number().nonnegative() }).strict(), expectedRevisions: z.record(OpaqueId, Revision), expiresAt: z.string().datetime(), commandsDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ApprovalToken = z.object({ tokenId: OpaqueId, planHash: z.string().regex(/^[a-f0-9]{64}$/), scopeHash: z.string().regex(/^[a-f0-9]{64}$/), risk: z.enum(["R0", "R1", "R2", "R3", "R4"]), nonce: z.string().min(16).max(256), issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), signature: z.string().min(32).max(256) }).strict();
export const CapabilityDescriptor = z.object({ name: z.string().regex(/^[a-z0-9.-]+@\d+$/), description: z.string().max(1024).optional(), version: z.number().int().positive() }).strict();
export const Snapshot = z.object({ id: OpaqueId, target: TargetRef, revision: Revision, createdAt: z.string().datetime(), sha256: z.string().regex(/^[a-f0-9]{64}$/), artifact: ArtifactRef, verified: z.boolean() }).strict();
export const Compensable = z.object({ operationId: OperationId, index: z.number().int().nonnegative(), action: z.string().min(1).max(256), status: z.enum(["pending", "applied", "failed", "compensated"]), details: z.record(z.string().max(128), z.unknown()).default({}) }).strict();
export const ErrorCode = z.enum(["INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "APP_NOT_RUNNING", "BRIDGE_UNAVAILABLE", "UNSUPPORTED_CAPABILITY", "AMBIGUOUS_TARGET", "NOT_FOUND", "CONFLICT", "LOCKED", "USER_CANCELLED", "TIMEOUT", "RATE_LIMITED", "PARTIAL_FAILURE", "HOST_ERROR", "EXPORT_FAILED", "VERIFICATION_FAILED", "SNAPSHOT_FAILED", "INTERNAL"]);
export const NormalizedError = z.object({ code: ErrorCode, message: z.string().max(2048), requestId: OpaqueId, retryable: z.boolean(), details: z.record(z.string().max(128), z.unknown()).default({}), appliedOperationIds: z.array(OperationId).max(500).default([]), recovery: z.string().max(1024).optional() }).strict();
export const Job = z.object({ id: OpaqueId, kind: boundedText(128), status: z.enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]), progress: z.number().min(0).max(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), operationId: OperationId.optional(), artifacts: z.array(ArtifactRef).max(100), error: NormalizedError.optional() }).strict();
export const OperationReceipt = z.object({ status: z.enum(["planned", "applied", "partial", "rolled-back", "queued"]), previousRevision: Revision.optional(), revision: Revision.optional(), appliedIndexes: z.array(z.number().int().nonnegative()).max(500), failedIndexes: z.array(z.number().int().nonnegative()).max(500), tempIdMap: z.record(OpaqueId, OpaqueId).default({}), snapshot: Snapshot.optional(), verification: z.enum(["skipped", "passed", "failed"]).optional(), compensations: z.array(Compensable).max(500).default([]), job: Job.optional() }).strict();

// F2/F3/F4 contracts. These are deliberately host-neutral: UXP, CEP, JSX and
// CLI adapters consume the same validated intent and never expose native DOMs.
export const PremiereTimelineOperation = z.union([
  z.object({ op: z.literal("splitClip"), trackIndex: z.number().int().nonnegative(), timeSeconds: PremiereTimeSeconds }).strict(),
  z.object({ op: z.literal("moveClip"), clipId: OpaqueId, targetTrackIndex: z.number().int().nonnegative(), targetTimeSeconds: PremiereTimeSeconds }).strict(),
  z.object({ op: z.literal("trimClip"), clipId: OpaqueId, inPoint: PremiereTimeSeconds, outPoint: PremiereTimeSeconds }).strict(),
  z.object({ op: z.literal("rippleDelete"), trackIndex: z.number().int().nonnegative(), startTime: PremiereTimeSeconds, endTime: PremiereTimeSeconds }).strict(),
  z.object({ op: z.literal("deleteRange"), trackIndex: z.number().int().nonnegative(), startTime: PremiereTimeSeconds, endTime: PremiereTimeSeconds, ripple: z.literal(false) }).strict(),
  z.object({ op: z.literal("applyTransition"), trackIndex: z.number().int().nonnegative(), clipIdA: OpaqueId.optional(), clipIdB: OpaqueId.optional(), edge: z.enum(["between", "in", "out"]).default("between"), transitionType: z.enum(["cross-dissolve", "dip-to-black", "exponential-fade"]), durationSeconds: z.number().positive().finite() }).strict().superRefine((value, context) => {
    if (value.edge === "between" && (!value.clipIdA || !value.clipIdB)) context.addIssue({ code: z.ZodIssueCode.custom, message: "between transition requires clipIdA and clipIdB" });
    if (value.edge !== "between" && !value.clipIdA && !value.clipIdB) context.addIssue({ code: z.ZodIssueCode.custom, message: "edge transition requires a clip id" });
  }),
  z.object({ op: z.literal("setVideoTransform"), trackIndex: z.number().int().nonnegative(), clipIds: z.array(OpaqueId).max(500).default([]), positionKeyframes: z.array(z.object({ time: PremiereTimeSeconds, x: z.number().finite(), y: z.number().finite() }).strict()).min(2).max(5000), scale: z.number().positive().finite(), outputAspectRatio: z.literal("9:16") }).strict(),
  z.object({ op: z.literal("setCropKeyframes"), trackIndex: z.number().int().nonnegative(), clipIds: z.array(OpaqueId).max(500).default([]), keyframes: z.array(z.object({ time: PremiereTimeSeconds, left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }).strict()).min(2).max(5000), outputAspectRatio: z.literal("9:16") }).strict(),
  z.object({ op: z.literal("setAudioKeyframes"), trackIndex: z.number().int().nonnegative(), clipId: OpaqueId, gainDb: z.number().finite().min(-96).max(24), keyframes: z.array(z.object({ time: PremiereTimeSeconds, value: z.number().finite().min(-96).max(24) }).strict()).max(5000) }).strict(),
  z.object({ op: z.literal("addSequenceMarker"), timeSeconds: PremiereTimeSeconds, name: z.string().max(512), comment: z.string().max(4096), markerType: z.enum(["comment", "chapter", "web-link", "flash-cue", "segmentation"]) }).strict(),
  z.object({ op: z.literal("addCaptionTrack"), subtitles: z.array(PremiereSubtitle).min(1).max(100000) }).strict(),
]);
export const PremiereCutSilencesPlan = z.object({ op: z.literal("cutSilences"), ranges: z.array(z.object({ startTime: PremiereTimeSeconds, endTime: PremiereTimeSeconds }).strict()).min(1).max(10000), trackIndices: z.array(z.number().int().nonnegative()).min(1).max(1000), ripple: z.boolean().default(true) }).strict();
export const PremiereAutoDuckingPlan = z.object({ op: z.literal("autoDucking"), voiceTrackIndices: z.array(z.number().int().nonnegative()).min(1).max(100), musicTrackIndices: z.array(z.number().int().nonnegative()).min(1).max(100), musicClipIds: z.array(OpaqueId).max(10000).default([]), voiceRanges: z.array(z.object({ startTime: PremiereTimeSeconds, endTime: PremiereTimeSeconds }).strict()).default([]), attenuationDb: z.number().finite().min(-96).max(0), attackSeconds: z.number().finite().nonnegative().max(60), releaseSeconds: z.number().finite().nonnegative().max(60), threshold: z.number().finite().min(-96).max(24).default(-24) }).strict();
export const PremiereAutoReframePlan = z.object({ op: z.literal("autoReframe"), aspectRatio: z.literal("9:16"), horizontalKeyframes: z.array(z.object({ time: PremiereTimeSeconds, position: z.number().finite().min(0).max(1) }).strict()).min(2).max(5000), sourceWidth: z.number().int().positive(), sourceHeight: z.number().int().positive(), trackIndex: z.number().int().nonnegative().default(0), clipIds: z.array(OpaqueId).max(500).default([]) }).strict();
export const PremiereEditPlan = z.object({ version: z.literal("1"), target: TargetRef.refine((value) => value.app === "premiere-pro", { message: "EditPlan target must be Premiere Pro" }), operations: z.array(z.union([PremiereTimelineOperation, PremiereCutSilencesPlan, PremiereAutoDuckingPlan, PremiereAutoReframePlan])).min(1).max(500), options: MutationOptions }).strict();

export const PhotoshopBatchPlayDescriptor = z.object({ _obj: z.string().min(1).max(256), _target: z.array(z.record(z.string().max(128), z.unknown())).max(32).optional(), _options: z.record(z.string().max(128), z.unknown()).optional() }).catchall(z.unknown()).strict();
export const PhotoshopBatchPlayCommand = z.object({ action: z.enum(["create", "apply", "set", "delete"]), descriptor: PhotoshopBatchPlayDescriptor, options: z.object({ dialogMode: z.enum(["silent", "display", "dontDisplay"]).default("silent"), synchronousExecution: z.boolean().default(true), modalBehavior: z.enum(["execute", "fail"]).default("execute") }).strict().default({}) }).strict();
export const PhotoshopLayerMaskSpec = z.object({ layerId: OpaqueId, kind: z.enum(["selection", "vector"]), invert: z.boolean().default(false), density: z.number().finite().min(0).max(100).default(100), featherPixels: z.number().finite().nonnegative().max(10000).default(0) }).strict();
export const PhotoshopAdjustmentSpec = z.object({ layerId: OpaqueId.optional(), kind: z.enum(["curves", "levels", "hue-saturation", "color-balance", "brightness-contrast"]), properties: z.record(z.string().max(128), z.unknown()).default({}) }).strict();
export const PhotoshopSmartObjectSpec = z.object({ layerId: OpaqueId.optional(), action: z.enum(["create", "replace-linked", "edit-embedded"]), artifactId: OpaqueId.optional(), grantId: OpaqueId.optional() }).strict().superRefine((value, context) => { if ((value.action === "replace-linked" || value.action === "edit-embedded") && !value.layerId) context.addIssue({ code: z.ZodIssueCode.custom, message: "layerId is required", path: ["layerId"] }); });
export const PhotoshopFilterSpec = z.object({ filter: z.enum(["neural", "camera-raw"]), parameters: z.record(z.string().max(128), z.unknown()).default({}) }).strict();
export const PhotoshopLayerExportSpec = z.object({ target: TargetRef.refine((value) => value.app === "photoshop"), layerIds: z.array(OpaqueId).max(10000).optional(), groupIds: z.array(OpaqueId).max(1000).optional(), format: z.enum(["png", "psd"]), destination: FileGrant, scale: z.number().positive().max(16).default(1), includeHidden: z.boolean().default(false), mutation: MutationOptions }).strict();
export const PhotoshopLayerExportResult = z.object({ manifest: z.record(z.string(), z.unknown()), artifacts: z.array(ArtifactRef).max(10000) }).strict();

export const AfterEffectsPreset = z.object({ id: OpaqueId, name: boundedText(512), matchName: boundedText(256), category: z.enum(["effect", "animation", "camera", "tracking", "render"]), recipe: z.record(z.string().max(128), z.unknown()), version: boundedText(64) }).strict();
export const AfterEffectsPresetApply = z.object({ target: TargetRef.refine((value) => value.app === "after-effects"), presetId: OpaqueId, layerId: OpaqueId, parameters: z.record(z.string().max(128), z.unknown()).default({}), mutation: MutationOptions }).strict();
export const AfterEffectsPresetApplyResult = z.object({ applied: z.literal(true), presetId: OpaqueId, layerId: OpaqueId, modifiedProperties: z.array(z.string().max(256)).max(500) }).strict();
export const PremiereEditPlanResult = z.object({ appliedOperations: z.number().int().nonnegative().max(500), timelineRevision: Revision, summary: z.record(z.string(), z.unknown()) }).strict();
export const AfterEffectsRenderSegment = z.object({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().nonnegative() }).strict().superRefine((value, context) => { if (value.endFrame < value.startFrame) context.addIssue({ code: z.ZodIssueCode.custom, message: "endFrame must be >= startFrame", path: ["endFrame"] }); });
export const AfterEffectsRenderPlan = z.object({ projectPath: z.string().min(1).max(4096), outputPath: z.string().min(1).max(4096), comp: boundedText(512).optional(), segments: z.array(AfterEffectsRenderSegment).min(1).max(100), operationId: OperationId.optional() }).strict();

export const IllustratorVectorOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create-path"), points: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2).max(100000), closed: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal("compound-path"), itemIds: z.array(OpaqueId).min(2).max(1000) }).strict(),
  z.object({ op: z.literal("boolean"), operation: z.enum(["union", "intersection", "exclude"]), itemIds: z.array(OpaqueId).min(2).max(1000) }).strict(),
]);
export const IllustratorTextSpec = z.object({ itemId: OpaqueId, text: z.string().max(100000).optional(), fontFamily: z.string().max(256).optional(), fontSize: z.number().positive().max(10000).optional(), kerning: z.number().finite().min(-10000).max(10000).optional(), tracking: z.number().finite().min(-10000).max(10000).optional(), alignment: z.enum(["left", "center", "right", "justify"]).optional() }).strict();
export const IllustratorArtboardExport = z.object({ target: TargetRef.refine((value) => value.app === "illustrator"), artboardIds: z.array(OpaqueId).min(1).max(1000), format: z.enum(["svg", "png"]), destination: FileGrant, scale: z.number().positive().max(16).default(1), maxDimension: z.number().int().positive().max(100000).optional(), mutation: MutationOptions }).strict();
export const IllustratorArtboardExportResult = z.object({ manifest: z.record(z.string(), z.unknown()), artifacts: z.array(ArtifactRef).max(1000) }).strict();

export const ArtifactMetadata = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), uri: z.string().regex(/^artifact:\/\/sha256-[a-f0-9]{64}$/), mediaType: z.string().max(256).optional(), sizeBytes: z.number().int().nonnegative(), createdAt: z.string().datetime(), immutable: z.literal(true), provenance: z.record(z.string().max(128), z.unknown()).default({}) }).strict();
export const Preset = z.object({ id: OpaqueId, kind: z.enum(["lut", "typography", "animation"]), name: boundedText(512), version: boundedText(64), payload: z.record(z.string().max(128), z.unknown()), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const SagaStep = z.object({ id: OpaqueId, app: AppId, tool: boundedText(256), input: z.unknown(), compensateTool: boundedText(256).optional(), idempotencyKey: boundedText(256) }).strict();
export const SagaDefinition = z.object({ id: OpaqueId, version: boundedText(64), steps: z.array(SagaStep).min(1).max(100) }).strict();

export type PremiereTimelineOperation = z.infer<typeof PremiereTimelineOperation>;
export type PremiereEditPlan = z.infer<typeof PremiereEditPlan>;
export type PhotoshopBatchPlayDescriptor = z.infer<typeof PhotoshopBatchPlayDescriptor>;
export type PhotoshopLayerMaskSpec = z.infer<typeof PhotoshopLayerMaskSpec>;
export type PhotoshopAdjustmentSpec = z.infer<typeof PhotoshopAdjustmentSpec>;
export type AfterEffectsPreset = z.infer<typeof AfterEffectsPreset>;
export type AfterEffectsRenderPlan = z.infer<typeof AfterEffectsRenderPlan>;
export type IllustratorVectorOperation = z.infer<typeof IllustratorVectorOperation>;
export type IllustratorTextSpec = z.infer<typeof IllustratorTextSpec>;
export type IllustratorArtboardExport = z.infer<typeof IllustratorArtboardExport>;
export type PhotoshopLayerExportSpec = z.infer<typeof PhotoshopLayerExportSpec>;
export type PhotoshopLayerExportResult = z.infer<typeof PhotoshopLayerExportResult>;
export type IllustratorArtboardExportResult = z.infer<typeof IllustratorArtboardExportResult>;
export type AfterEffectsPresetApply = z.infer<typeof AfterEffectsPresetApply>;
export type AfterEffectsPresetApplyResult = z.infer<typeof AfterEffectsPresetApplyResult>;
export type PremiereEditPlanResult = z.infer<typeof PremiereEditPlanResult>;
export type ArtifactMetadata = z.infer<typeof ArtifactMetadata>;
export type Preset = z.infer<typeof Preset>;
export type SagaDefinition = z.infer<typeof SagaDefinition>;

export const DocumentState = PsDocumentState;
export const Layer = PsLayer;
export const Composition = AeCompState;
export const Track = PrTrack;
export const Sequence = PrSequenceState;
export const ExportPreset = z.object({ id: OpaqueId, name: boundedText(512), app: AppId, format: boundedText(64), version: boundedText(64), supportsAlpha: z.boolean().optional() }).strict();
export type AppId = z.infer<typeof AppId>; export type TargetRef = z.infer<typeof TargetRef>; export type MutationOptions = z.infer<typeof MutationOptions>; export type FileGrant = z.infer<typeof FileGrant>; export type ArtifactRef = z.infer<typeof ArtifactRef>; export type Snapshot = z.infer<typeof Snapshot>; export type NormalizedError = z.infer<typeof NormalizedError>; export type Job = z.infer<typeof Job>; export type OperationReceipt = z.infer<typeof OperationReceipt>; export type Plan = z.infer<typeof Plan>; export type ApprovalToken = z.infer<typeof ApprovalToken>; export type PreviewCaptureInput = z.infer<typeof PreviewCaptureInput>; export type PreviewCaptureData = z.infer<typeof PreviewCaptureData>; export type VisualVerifyInput = z.infer<typeof VisualVerifyInput>; export type VisualVerifyData = z.infer<typeof VisualVerifyData>;
export { z };
