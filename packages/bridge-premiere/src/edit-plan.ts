import { PremiereEditPlan, PremiereTimelineOperation, type TargetRef, type OperationReceipt } from "@adobe-mcp/schemas";
import type { z } from "zod";

export interface TimelineClip {
  readonly id: string;
  readonly trackIndex: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly mediaType: "video" | "audio" | "caption" | "unknown";
  readonly gainDb?: number;
  readonly keyframes?: readonly { time: number; value: number }[];
  readonly videoTransform?: { readonly positionKeyframes: readonly { time: number; x: number; y: number }[]; readonly scale: number; readonly aspectRatio: "9:16" };
  readonly cropKeyframes?: readonly { time: number; left: number; top: number; right: number; bottom: number }[];
  readonly transitionIn?: { readonly type: string; readonly durationSeconds: number };
  readonly transitionOut?: { readonly type: string; readonly durationSeconds: number };
}

export interface TimelineState {
  readonly clips: readonly TimelineClip[];
  readonly markers?: readonly { timeSeconds: number; name: string; comment: string; markerType: string }[];
  readonly captions?: readonly { startTime: number; endTime: number; text: string }[];
}

export interface PremiereEditPlanTransport {
  request(method: "premiere.editPlan.execute", payload: Record<string, unknown>): Promise<unknown>;
}

export interface AudioAnalysisSample { readonly startTime: number; readonly endTime: number; readonly levelDb: number; }
export interface TimeRange { readonly startTime: number; readonly endTime: number; }

/** Converts an audio analysis stream into deterministic silence ranges. */
export function detectSilenceRanges(samples: readonly AudioAnalysisSample[], thresholdDb = -48, minimumDurationSeconds = 0.25): readonly TimeRange[] {
  if (!Number.isFinite(thresholdDb) || thresholdDb >= 0 || !Number.isFinite(minimumDurationSeconds) || minimumDurationSeconds <= 0) throw new Error("INVALID_ARGUMENT: invalid silence detection parameters");
  const ranges: TimeRange[] = [];
  let open: TimeRange | undefined;
  for (const sample of samples) {
    if (!Number.isFinite(sample.startTime) || !Number.isFinite(sample.endTime) || sample.endTime <= sample.startTime) throw new Error("INVALID_ARGUMENT: invalid audio analysis sample");
    if (sample.levelDb <= thresholdDb) open = open ? { startTime: open.startTime, endTime: sample.endTime } : { startTime: sample.startTime, endTime: sample.endTime };
    else if (open) { if (open.endTime - open.startTime >= minimumDurationSeconds) ranges.push(open); open = undefined; }
  }
  if (open && open.endTime - open.startTime >= minimumDurationSeconds) ranges.push(open);
  return ranges;
}

export function buildAutoDuckingKeyframes(voiceRanges: readonly TimeRange[], attenuationDb: number, attackSeconds: number, releaseSeconds: number, clipStart = 0, clipEnd = Number.POSITIVE_INFINITY): readonly { time: number; value: number }[] {
  if (!Number.isFinite(attenuationDb) || attenuationDb > 0 || attenuationDb < -96 || attackSeconds < 0 || releaseSeconds < 0) throw new Error("INVALID_ARGUMENT: invalid auto-ducking parameters");
  const keyframes: Array<{ time: number; value: number }> = [];
  for (const range of voiceRanges) {
    const start = Math.max(clipStart, range.startTime);
    const end = Math.min(clipEnd, range.endTime);
    if (end <= start) continue;
    keyframes.push({ time: Math.max(clipStart, start - attackSeconds), value: 0 }, { time: start, value: attenuationDb }, { time: end, value: attenuationDb }, { time: Math.min(clipEnd, end + releaseSeconds), value: 0 });
  }
  return keyframes.sort((a, b) => a.time - b.time);
}

export function calculateAutoReframeKeyframes(facePositions: readonly { time: number; centerX: number }[], sourceWidth: number, outputWidth: number): readonly { time: number; position: number }[] {
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(outputWidth) || outputWidth <= 0) throw new Error("INVALID_ARGUMENT: invalid reframe dimensions");
  const visibleWidth = Math.min(sourceWidth, outputWidth);
  return facePositions.map((face) => ({ time: face.time, position: Math.max(0, Math.min(1, (face.centerX - visibleWidth / 2) / Math.max(1, sourceWidth - visibleWidth))) }));
}

export function splitClip(trackIndex: number, timeSeconds: number): PremiereTimelineOperation {
  return PremiereTimelineOperation.parse({ op: "splitClip", trackIndex, timeSeconds });
}
export function moveClip(clipId: string, targetTrackIndex: number, targetTimeSeconds: number): PremiereTimelineOperation {
  return PremiereTimelineOperation.parse({ op: "moveClip", clipId, targetTrackIndex, targetTimeSeconds });
}
export function trimClip(clipId: string, inPoint: number, outPoint: number): PremiereTimelineOperation {
  return PremiereTimelineOperation.parse({ op: "trimClip", clipId, inPoint, outPoint });
}
export function rippleDelete(trackIndex: number, startTime: number, endTime: number): PremiereTimelineOperation {
  return PremiereTimelineOperation.parse({ op: "rippleDelete", trackIndex, startTime, endTime });
}
export function applyTransition(trackIndex: number, clipIdA: string, clipIdB: string, transitionType: "cross-dissolve" | "dip-to-black" | "exponential-fade", durationSeconds: number): PremiereTimelineOperation {
  return PremiereTimelineOperation.parse({ op: "applyTransition", trackIndex, clipIdA, clipIdB, transitionType, durationSeconds });
}
export function setAudioKeyframes(trackIndex: number, clipId: string, gainDb: number, keyframes: readonly { time: number; value: number }[]): PremiereTimelineOperation {
  return PremiereTimelineOperation.parse({ op: "setAudioKeyframes", trackIndex, clipId, gainDb, keyframes });
}
export function addSequenceMarker(timeSeconds: number, name: string, comment: string, markerType: "comment" | "chapter" | "web-link" | "flash-cue" | "segmentation"): PremiereTimelineOperation {
  return PremiereTimelineOperation.parse({ op: "addSequenceMarker", timeSeconds, name, comment, markerType });
}
export function addCaptionTrack(subtitles: readonly { startTime: number; endTime: number; text: string }[]): PremiereTimelineOperation {
  return PremiereTimelineOperation.parse({ op: "addCaptionTrack", subtitles });
}

export interface EditPlanExecutionResult {
  readonly receipt: OperationReceipt;
  readonly expandedOperations: readonly PremiereTimelineOperation[];
}

export function createEditPlan(target: TargetRef, operations: z.input<typeof PremiereEditPlan>["operations"], options: Record<string, unknown>): ReturnType<typeof PremiereEditPlan.parse> {
  return PremiereEditPlan.parse({ version: "1", target, operations, options });
}

export function expandEditPlan(plan: ReturnType<typeof PremiereEditPlan.parse>): readonly PremiereTimelineOperation[] {
  const expanded: PremiereTimelineOperation[] = [];
  for (const operation of plan.operations) {
    if (operation.op === "cutSilences") {
      for (const range of operation.ranges) for (const trackIndex of operation.trackIndices) expanded.push(operation.ripple ? rippleDelete(trackIndex, range.startTime, range.endTime) : PremiereTimelineOperation.parse({ op: "deleteRange", trackIndex, startTime: range.startTime, endTime: range.endTime, ripple: false }));
    } else if (operation.op === "autoDucking") {
      // A host may provide concrete clip/range analysis. With no clip IDs the
      // declarative operation remains host-resolvable and is not fabricated.
      const clipIds = (operation as unknown as { musicClipIds?: readonly string[] }).musicClipIds ?? [];
      const ranges = (operation as unknown as { voiceRanges?: readonly TimeRange[] }).voiceRanges ?? [];
      for (const [index, clipId] of clipIds.entries()) expanded.push(setAudioKeyframes(operation.musicTrackIndices[index % operation.musicTrackIndices.length] ?? 0, clipId, operation.attenuationDb, buildAutoDuckingKeyframes(ranges, operation.attenuationDb, operation.attackSeconds, operation.releaseSeconds)));
    } else if (operation.op === "autoReframe") {
      const visibleWidth = Math.min(operation.sourceWidth, operation.sourceHeight * 9 / 16);
      const scale = Math.max(1, operation.sourceWidth / Math.max(1, visibleWidth));
      const positionKeyframes = operation.horizontalKeyframes.map((keyframe) => ({ time: keyframe.time, x: visibleWidth / 2 + keyframe.position * Math.max(0, operation.sourceWidth - visibleWidth), y: operation.sourceHeight / 2 }));
      const cropKeyframes = operation.horizontalKeyframes.map((keyframe) => {
        const left = keyframe.position * Math.max(0, 1 - visibleWidth / operation.sourceWidth);
        return { time: keyframe.time, left, top: 0, right: Math.min(1, left + visibleWidth / operation.sourceWidth), bottom: 1 };
      });
      expanded.push(PremiereTimelineOperation.parse({ op: "setVideoTransform", trackIndex: operation.trackIndex, clipIds: operation.clipIds, positionKeyframes, scale, outputAspectRatio: "9:16" }));
      expanded.push(PremiereTimelineOperation.parse({ op: "setCropKeyframes", trackIndex: operation.trackIndex, clipIds: operation.clipIds, keyframes: cropKeyframes, outputAspectRatio: "9:16" }));
    } else expanded.push(operation);
  }
  return expanded;
}

export async function executeEditPlan(transport: PremiereEditPlanTransport, plan: ReturnType<typeof PremiereEditPlan.parse>): Promise<EditPlanExecutionResult> {
  const expandedOperations = expandEditPlan(plan);
  const value = await transport.request("premiere.editPlan.execute", { ...plan, operations: expandedOperations });
  const candidate = value && typeof value === "object" && "receipt" in value ? (value as { receipt: unknown }).receipt : value;
  const receipt = (await import("@adobe-mcp/schemas")).OperationReceipt.parse(candidate);
  return { receipt, expandedOperations };
}

/** Deterministic timeline math used by host adapters and exhaustive tests. */
export function applyTimelineOperation(state: TimelineState, operation: PremiereTimelineOperation): TimelineState {
  const requireClip = (id: string): TimelineClip => {
    const clip = state.clips.find((candidate) => candidate.id === id);
    if (!clip) throw new Error(`NOT_FOUND: Premiere clip ${id} does not exist in the timeline`);
    return clip;
  };
  const clipsForOperation = (trackIndex: number, ids: readonly string[]): readonly TimelineClip[] => {
    if (ids.length) return ids.map(requireClip).map((clip) => { if (clip.trackIndex !== trackIndex) throw new Error(`CONFLICT: Premiere clip ${clip.id} is not on track ${trackIndex}`); return clip; });
    const clips = state.clips.filter((clip) => clip.trackIndex === trackIndex && clip.mediaType === "video");
    if (!clips.length) throw new Error(`NOT_FOUND: no video clips exist on track ${trackIndex}`);
    return clips;
  };
  if (operation.op === "splitClip") {
    const next: TimelineClip[] = [];
    for (const clip of state.clips) {
      if (clip.trackIndex !== operation.trackIndex || operation.timeSeconds <= clip.startTime || operation.timeSeconds >= clip.endTime) { next.push(clip); continue; }
      const left = { ...clip, endTime: operation.timeSeconds, id: `${clip.id}:a` };
      const right = { ...clip, startTime: operation.timeSeconds, id: `${clip.id}:b` };
      next.push(left, right);
    }
    return { ...state, clips: next };
  }
  if (operation.op === "trimClip") { const clip = requireClip(operation.clipId); if (operation.outPoint <= operation.inPoint) throw new Error("INVALID_ARGUMENT: trim outPoint must be greater than inPoint"); return { ...state, clips: state.clips.map((candidate) => candidate.id === clip.id ? { ...candidate, startTime: operation.inPoint, endTime: operation.outPoint } : candidate) }; }
  if (operation.op === "moveClip") { const clip = requireClip(operation.clipId); return { ...state, clips: state.clips.map((candidate) => candidate.id === clip.id ? { ...candidate, trackIndex: operation.targetTrackIndex, startTime: operation.targetTimeSeconds, endTime: operation.targetTimeSeconds + (clip.endTime - clip.startTime) } : candidate) }; }
  if (operation.op === "rippleDelete") {
    const duration = operation.endTime - operation.startTime;
    return { ...state, clips: state.clips.flatMap((clip) => {
      if (clip.trackIndex !== operation.trackIndex || clip.endTime <= operation.startTime) return [clip];
      if (clip.startTime >= operation.endTime) return [{ ...clip, startTime: clip.startTime - duration, endTime: clip.endTime - duration }];
      if (clip.startTime < operation.startTime && clip.endTime > operation.endTime) return [{ ...clip, endTime: clip.endTime - duration }];
      if (clip.startTime < operation.startTime) return [{ ...clip, endTime: operation.startTime }];
      if (clip.endTime > operation.endTime) return [{ ...clip, startTime: operation.startTime, endTime: clip.endTime - duration }];
      return [];
    }) };
  }
  if (operation.op === "deleteRange") {
    if (operation.endTime <= operation.startTime) throw new Error("INVALID_ARGUMENT: delete range must be positive");
    return { ...state, clips: state.clips.flatMap((clip) => {
      if (clip.trackIndex !== operation.trackIndex || clip.endTime <= operation.startTime || clip.startTime >= operation.endTime) return [clip];
      const result: TimelineClip[] = [];
      if (clip.startTime < operation.startTime) result.push({ ...clip, id: `${clip.id}:pre`, endTime: operation.startTime });
      if (clip.endTime > operation.endTime) result.push({ ...clip, id: `${clip.id}:post`, startTime: operation.endTime });
      return result;
    }) };
  }
  if (operation.op === "setAudioKeyframes") { requireClip(operation.clipId); return { ...state, clips: state.clips.map((clip) => clip.id === operation.clipId ? { ...clip, gainDb: operation.gainDb, keyframes: operation.keyframes } : clip) }; }
  if (operation.op === "setVideoTransform") { const clips = clipsForOperation(operation.trackIndex, operation.clipIds); const ids = new Set(clips.map((clip) => clip.id)); return { ...state, clips: state.clips.map((clip) => ids.has(clip.id) ? { ...clip, videoTransform: { positionKeyframes: operation.positionKeyframes, scale: operation.scale, aspectRatio: operation.outputAspectRatio } } : clip) }; }
  if (operation.op === "setCropKeyframes") { const clips = clipsForOperation(operation.trackIndex, operation.clipIds); const ids = new Set(clips.map((clip) => clip.id)); return { ...state, clips: state.clips.map((clip) => ids.has(clip.id) ? { ...clip, cropKeyframes: operation.keyframes } : clip) }; }
  if (operation.op === "applyTransition") {
    const a = operation.clipIdA ? requireClip(operation.clipIdA) : undefined;
    const b = operation.clipIdB ? requireClip(operation.clipIdB) : undefined;
    if (a && a.trackIndex !== operation.trackIndex || b && b.trackIndex !== operation.trackIndex) throw new Error("CONFLICT: transition clips must be on the requested track");
    if (operation.edge === "between") {
      if (!a || !b) throw new Error("INVALID_ARGUMENT: transition requires two clips");
      const contiguous = Math.abs(a.endTime - b.startTime) < 1e-6 || Math.abs(b.endTime - a.startTime) < 1e-6;
      if (!contiguous) throw new Error("CONFLICT: transition clips are not contiguous");
    }
    return { ...state, clips: state.clips.map((clip) => clip.id === a?.id ? { ...clip, transitionOut: { type: operation.transitionType, durationSeconds: operation.durationSeconds } } : clip.id === b?.id ? { ...clip, transitionIn: { type: operation.transitionType, durationSeconds: operation.durationSeconds } } : clip) };
  }
  if (operation.op === "addSequenceMarker") return { ...state, markers: [...(state.markers ?? []), operation] };
  if (operation.op === "addCaptionTrack") return { ...state, captions: operation.subtitles };
  return state;
}
