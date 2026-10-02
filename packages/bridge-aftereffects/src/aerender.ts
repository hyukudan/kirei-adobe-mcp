import { access, constants, existsSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, normalize, parse } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createNonce } from "@adobe-mcp/protocol";
import type { Job } from "@adobe-mcp/schemas";

const accessAsync = promisify(access);

export interface AerenderLocatorOptions {
  env?: NodeJS.ProcessEnv;
  fsExists?: (path: string) => boolean;
  fsReaddir?: (path: string) => string[];
  platform?: NodeJS.Platform;
  programFiles?: string;
}

export interface AerenderRequest {
  projectPath: string;
  comp?: string;
  outputPath?: string;
  startFrame?: number;
  endFrame?: number;
  settingsTemplate?: string;
  renderSettingsTemplate?: string;
  outputModuleTemplate?: string;
  operationId?: string;
  resourceLimits?: { maxCpuPercent?: number; maxMemoryMb?: number; maxRuntimeMs?: number };
}

export interface AerenderProgress {
  jobId: string;
  percent: number;
  completedFrames?: number;
  totalFrames?: number;
  elapsedMs: number;
  estimatedRemainingMs?: number;
  line?: string;
}

export interface ProcessUsage { cpuPercent?: number; memoryMb?: number; }
export interface AerenderWorkerOptions {
  locator?: (options?: AerenderLocatorOptions) => Promise<string>;
  spawnProcess?: typeof spawn;
  now?: () => number;
  usageProvider?: (pid: number) => Promise<ProcessUsage>;
  pollIntervalMs?: number;
  cancelGraceMs?: number;
  locatorOptions?: AerenderLocatorOptions;
}

export interface AerenderRunResult { jobId: string; job: Job; output?: string; exitCode: number | null; progress: AerenderProgress; }
export interface RenderFarmSegment { readonly startFrame: number; readonly endFrame: number; readonly outputPath: string; }
export interface RenderFarmResult { readonly projectPath: string; readonly outputPath: string; readonly segments: readonly AerenderRunResult[]; readonly outputSha256: string; }

export function segmentFrameRange(startFrame: number, endFrame: number, segmentSize: number): readonly { startFrame: number; endFrame: number }[] {
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame < startFrame || !Number.isInteger(segmentSize) || segmentSize < 1) throw new Error("INVALID_ARGUMENT: invalid render frame range");
  const result: Array<{ startFrame: number; endFrame: number }> = [];
  for (let start = startFrame; start <= endFrame; start += segmentSize) result.push({ startFrame: start, endFrame: Math.min(endFrame, start + segmentSize - 1) });
  return result;
}

export async function cloneProjectForAerender(projectPath: string, prefix = "adobe-mcp-aerender-"): Promise<{ directory: string; projectPath: string }> {
  if (!projectPath || projectPath.includes("\0")) throw new Error("INVALID_ARGUMENT: invalid project path");
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const destination = join(directory, parse(projectPath).base || "project.aep");
  await copyFile(projectPath, destination);
  return { directory, projectPath: destination };
}

export async function sha256File(filePath: string): Promise<string> { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }

export async function renderFarm(worker: AerenderWorker, request: AerenderRequest & { startFrame: number; endFrame: number; segmentSize: number }, onProgress?: (progress: AerenderProgress) => void): Promise<RenderFarmResult> {
  const cloned = await cloneProjectForAerender(request.projectPath);
  const segments = segmentFrameRange(request.startFrame, request.endFrame, request.segmentSize);
  const runs: AerenderRunResult[] = [];
  try {
    for (const segment of segments) {
      const outputPath = request.outputPath ? join(dirname(request.outputPath), `${parse(request.outputPath).name}.${segment.startFrame}-${segment.endFrame}${parse(request.outputPath).ext}`) : undefined;
      runs.push(await worker.run({ ...request, projectPath: cloned.projectPath, ...(outputPath === undefined ? {} : { outputPath }), startFrame: segment.startFrame, endFrame: segment.endFrame }, onProgress));
    }
    const finalOutput = request.outputPath ?? runs[runs.length - 1]?.output;
    if (!finalOutput) throw new Error("EXPORT_FAILED: render farm produced no output");
    const segmentPaths = runs.map((run) => run.output).filter((path): path is string => Boolean(path));
    if (segmentPaths.length !== runs.length) throw new Error("EXPORT_FAILED: aerender did not report every segment output");
    const chunks = await Promise.all(segmentPaths.map((path) => readFile(path)));
    await writeFile(finalOutput, Buffer.concat(chunks));
    return { projectPath: cloned.projectPath, outputPath: finalOutput, segments: runs, outputSha256: await sha256File(finalOutput) };
  } finally { await rm(cloned.directory, { recursive: true, force: true }); }
}

export function aerenderCandidates(options: AerenderLocatorOptions = {}): string[] {
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  const readDir = options.fsReaddir ?? ((path: string) => { try { return readdirSync(path); } catch { return []; } });
  if ((options.platform ?? process.platform) === "win32") {
    const pf = options.programFiles ?? env.ProgramFiles ?? "C:\\Program Files";
    const adobe = join(pf, "Adobe");
    for (const name of readDir(adobe).filter((entry) => /^Adobe After Effects(?:$|[ _-])/i.test(entry))) candidates.push(join(adobe, name, "Support Files", "aerender.exe"));
  } else {
    for (const name of readDir("/Applications").filter((entry) => /^Adobe After Effects(?:$|[ _-])/i.test(entry))) candidates.push(join("/Applications", name, "aerender"));
  }
  return [...new Set(candidates.filter((path): path is string => Boolean(path)))];
}

export function isOfficialAerenderPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const candidate = normalize(path).replace(/\\/g, "/");
  return platform === "win32" ? /^C:\/Program Files\/Adobe\/Adobe After Effects(?:[^/]*)\/Support Files\/aerender\.exe$/i.test(candidate) : /^\/Applications\/Adobe After Effects(?:[^/]*)\/aerender$/.test(candidate);
}

export async function locateAerender(options: AerenderLocatorOptions = {}): Promise<string> {
  const exists = options.fsExists ?? existsSync;
  for (const candidate of aerenderCandidates(options)) {
    if (!isOfficialAerenderPath(candidate, options.platform ?? process.platform) || !exists(candidate)) continue;
    if (options.fsExists) return candidate;
    try { await accessAsync(candidate, constants.X_OK); return candidate; } catch { /* next installed version */ }
  }
  throw new Error("NOT_FOUND: aerender executable was not found");
}

function boundedNumber(value: number | undefined, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`INVALID_ARGUMENT: ${name} is outside its allowed range`);
  return value;
}

/** Builds argv independently from spawn: paths and templates can never become shell syntax. */
export function buildAerenderArgs(request: AerenderRequest): string[] {
  if (!request.projectPath) throw new Error("INVALID_ARGUMENT: projectPath is required");
  const args = ["-project", request.projectPath];
  if (request.comp !== undefined) { if (!request.comp) throw new Error("INVALID_ARGUMENT: comp cannot be empty"); args.push("-comp", request.comp); }
  if (request.outputPath !== undefined) args.push("-output", request.outputPath);
  if (request.startFrame !== undefined) args.push("-s", String(boundedNumber(request.startFrame, 0, 2_147_483_647, "startFrame")));
  if (request.endFrame !== undefined) args.push("-e", String(boundedNumber(request.endFrame, 0, 2_147_483_647, "endFrame")));
  const settingsTemplate = request.renderSettingsTemplate ?? request.settingsTemplate;
  if (settingsTemplate !== undefined) args.push("-RStemplate", settingsTemplate);
  if (request.outputModuleTemplate !== undefined) args.push("-OMtemplate", request.outputModuleTemplate);
  return args;
}

export function parseAerenderProgress(line: string): Omit<AerenderProgress, "jobId" | "elapsedMs"> | undefined {
  const percentage = line.match(/(?:progress|completed)\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i) ?? line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const frames = line.match(/(?:frame|frames)\s*(\d+)\s*(?:of|\/)\s*(\d+)/i) ?? line.match(/(\d+)\s*\/\s*(\d+)\s*frames?/i);
  if (!percentage && !frames) return undefined;
  const completedFrames = frames ? Number(frames[1]) : undefined;
  const totalFrames = frames ? Number(frames[2]) : undefined;
  const percent = percentage ? Math.min(100, Math.max(0, Number(percentage[1]))) / 100 : (totalFrames ? Math.min(1, (completedFrames ?? 0) / totalFrames) : 0);
  return { percent, ...(completedFrames === undefined ? {} : { completedFrames }), ...(totalFrames === undefined ? {} : { totalFrames }), line };
}

function makeJob(id: string, operationId?: string): Job {
  const timestamp = new Date().toISOString();
  return { id, kind: "after-effects.aerender", status: "running", progress: 0, createdAt: timestamp, updatedAt: timestamp, ...(operationId ? { operationId } : {}), artifacts: [] };
}

/** aerender worker with cooperative cancellation and injectable resource polling. */
export class AerenderWorker {
  private readonly options: Required<Pick<AerenderWorkerOptions, "now" | "pollIntervalMs" | "cancelGraceMs">> & AerenderWorkerOptions;
  private readonly processes = new Map<string, ChildProcess>();
  private readonly jobs = new Map<string, Job>();
  private readonly cancelRequested = new Set<string>();

  constructor(options: AerenderWorkerOptions = {}) { this.options = { now: Date.now, pollIntervalMs: 1_000, cancelGraceMs: 3_000, ...options }; }
  getJob(jobId: string): Job | undefined { return this.jobs.get(jobId); }

  async run(request: AerenderRequest, onProgress?: (progress: AerenderProgress) => void): Promise<AerenderRunResult> {
    const supplied = request as AerenderRequest & { aerenderPath?: unknown };
    if (supplied.aerenderPath !== undefined) throw new Error("PERMISSION_DENIED: aerender executable is selected from Adobe installations only");
    const executable = await (this.options.locator ?? locateAerender)(this.options.locatorOptions);
    if (!isOfficialAerenderPath(executable, this.options.locatorOptions?.platform ?? process.platform)) throw new Error("PERMISSION_DENIED: aerender executable is outside the official Adobe allowlist");
    const args = buildAerenderArgs(request);
    const jobId = `aerender-${createNonce(12)}`;
    this.jobs.set(jobId, makeJob(jobId, request.operationId));
    const spawnProcess = this.options.spawnProcess ?? spawn;
    // shell:false is explicit even though it is Node's default.
    const child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.processes.set(jobId, child);
    const started = this.options.now();
    let latest: AerenderProgress = { jobId, percent: 0, elapsedMs: 0 };
    let output = "";
    let stderr = "";
    let lineBuffer = "";
    let usageTimer: ReturnType<typeof setInterval> | undefined;
    const limits = request.resourceLimits;
    const update = (line: string) => {
      output += line;
      const parsed = parseAerenderProgress(line);
      if (!parsed) return;
      const elapsedMs = Math.max(0, this.options.now() - started);
      const estimatedRemainingMs = parsed.percent > 0 ? Math.max(0, elapsedMs * (1 - parsed.percent) / parsed.percent) : undefined;
      latest = { jobId, ...parsed, elapsedMs, ...(estimatedRemainingMs === undefined ? {} : { estimatedRemainingMs }) };
      const current = this.jobs.get(jobId);
      if (current) this.jobs.set(jobId, { ...current, progress: latest.percent, updatedAt: new Date().toISOString() });
      onProgress?.(latest);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => { lineBuffer += chunk.toString(); const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop() ?? ""; for (const line of lines) update(line); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); update(chunk.toString()); });
    if (limits && this.options.usageProvider && child.pid) usageTimer = setInterval(() => { void this.enforceLimits(jobId, child, limits); }, this.options.pollIntervalMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); }).finally(() => { if (usageTimer) clearInterval(usageTimer); this.processes.delete(jobId); });
    if (lineBuffer) update(lineBuffer);
    const cancelled = this.cancelRequested.has(jobId);
    const status: Job["status"] = cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
    const finalJob: Job = { ...this.jobs.get(jobId)!, status, progress: status === "succeeded" ? 1 : latest.percent, updatedAt: new Date().toISOString(), ...(status === "failed" ? { error: { code: "EXPORT_FAILED" as const, message: stderr.slice(-2048) || `aerender exited with code ${exitCode ?? "unknown"}`, requestId: jobId, retryable: false, details: {}, appliedOperationIds: [] } } : {}) };
    this.jobs.set(jobId, finalJob);
    return { jobId, job: finalJob, ...(request.outputPath ? { output: request.outputPath } : {}), exitCode, progress: latest };
  }

  async cancel(jobId: string): Promise<void> {
    const child = this.processes.get(jobId);
    if (!child) throw new Error("NOT_FOUND: aerender job is not running");
    this.cancelRequested.add(jobId);
    const current = this.jobs.get(jobId);
    if (current) this.jobs.set(jobId, { ...current, status: "cancelling", updatedAt: new Date().toISOString() });
    child.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { if (!child.killed) child.kill("SIGTERM"); resolve(); }, this.options.cancelGraceMs);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }

  private async enforceLimits(jobId: string, child: ChildProcess, limits: NonNullable<AerenderRequest["resourceLimits"]>): Promise<void> {
    if (!child.pid || !this.options.usageProvider) return;
    const usage = await this.options.usageProvider(child.pid);
    const cpuExceeded = limits.maxCpuPercent !== undefined && usage.cpuPercent !== undefined && usage.cpuPercent > limits.maxCpuPercent;
    const memoryExceeded = limits.maxMemoryMb !== undefined && usage.memoryMb !== undefined && usage.memoryMb > limits.maxMemoryMb;
    const runtimeExceeded = limits.maxRuntimeMs !== undefined && (this.options.now() - new Date(this.jobs.get(jobId)?.createdAt ?? 0).getTime()) > limits.maxRuntimeMs;
    if (cpuExceeded || memoryExceeded || runtimeExceeded) { this.cancelRequested.add(jobId); child.kill("SIGINT"); }
  }
}
