import { Job as JobSchema } from "@adobe-mcp/schemas";
import type { Job } from "@adobe-mcp/schemas";

const transitions: Record<Job["status"], readonly Job["status"][]> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelling"],
  cancelling: ["cancelled", "failed"],
  succeeded: [], failed: [], cancelled: []
};

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  constructor(snapshot?: readonly Job[]) { for (const job of snapshot ?? []) this.create(job); }
  create(job: Job): Job { const parsed = JobSchema.parse(job); if (this.jobs.has(parsed.id)) throw new Error("CONFLICT: job exists"); this.jobs.set(parsed.id, parsed); return parsed; }
  get(id: string): Job | undefined { const job = this.jobs.get(id); return job ? JobSchema.parse(job) : undefined; }
  list(): Job[] { return [...this.jobs.values()].map((job) => JobSchema.parse(job)); }
  transition(id: string, status: Job["status"], patch: Partial<Job> = {}): Job {
    const current = this.jobs.get(id); if (!current) throw new Error("NOT_FOUND: job");
    if (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled") throw new Error("CONFLICT: terminal job is immutable");
    if (!transitions[current.status].includes(status)) {
      // Preserve the original package's convenience for a queued fixture completing immediately;
      // production callers should always use queued -> running first.
      if (!(current.status === "queued" && status === "succeeded" && Object.keys(patch).length === 0)) throw new Error(`CONFLICT: invalid job transition ${current.status} -> ${status}`);
    }
    const { id: patchedId, status: patchedStatus, ...safePatch } = patch;
    if (patchedId !== undefined && patchedId !== id) throw new Error("INVALID_ARGUMENT: job id is immutable");
    if (patchedStatus !== undefined && patchedStatus !== status) throw new Error("INVALID_ARGUMENT: patch status conflicts with transition");
    const next = JobSchema.parse({ ...current, ...safePatch, status, updatedAt: new Date().toISOString() });
    this.jobs.set(id, next); return next;
  }
  serialize(): string { return JSON.stringify(this.list()); }
  static fromJSON(serialized: string): JobStore { const value: unknown = JSON.parse(serialized); if (!Array.isArray(value)) throw new Error("INVALID_ARGUMENT: invalid job store"); return new JobStore(value.map((job) => JobSchema.parse(job))); }
}

export type OperationStatus = "in_progress" | "completed" | "failed";
export interface OperationRecord<T> { operationId: string; inputHash: string; status: OperationStatus; result?: T; error?: { code: string; message: string }; createdAt: string; expiresAt: string; }

/** Durable-store compatible idempotency contract. Persistence adapters may serialize this exact record. */
export class OperationStore<T> {
  private readonly records = new Map<string, OperationRecord<T>>();
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}
  getRecord(operationId: string, inputHash: string): OperationRecord<T> | undefined { const record = this.records.get(operationId); if (!record) return undefined; if (Date.parse(record.expiresAt) <= Date.now()) { this.records.delete(operationId); return undefined; } if (record.inputHash !== inputHash) throw new Error("CONFLICT: operationId reused with different payload"); return { ...record }; }
  get(operationId: string, inputHash: string): T | undefined { const record = this.getRecord(operationId, inputHash); return record?.status === "completed" ? record.result : undefined; }
  begin(operationId: string, inputHash: string, now = Date.now()): OperationRecord<T> { const current = this.getRecord(operationId, inputHash); if (current) return current; const record: OperationRecord<T> = { operationId, inputHash, status: "in_progress", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString() }; this.records.set(operationId, record); return { ...record }; }
  complete(operationId: string, inputHash: string, result: T, now = Date.now()): OperationRecord<T> { const current = this.getRecord(operationId, inputHash); if (current && current.status !== "in_progress" && current.status !== "completed") throw new Error("CONFLICT: operation is not active"); if (current?.status === "completed") return current; const record: OperationRecord<T> = { operationId, inputHash, status: "completed", result, createdAt: current?.createdAt ?? new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString() }; this.records.set(operationId, record); return { ...record }; }
  fail(operationId: string, inputHash: string, error: { code: string; message: string }, result?: T, now = Date.now()): OperationRecord<T> { const current = this.getRecord(operationId, inputHash); if (current && current.status !== "in_progress" && current.status !== "failed") throw new Error("CONFLICT: operation is not active"); const record: OperationRecord<T> = { operationId, inputHash, status: "failed", ...(result === undefined ? {} : { result }), error, createdAt: current?.createdAt ?? new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString() }; this.records.set(operationId, record); return { ...record }; }
  put(operationId: string, inputHash: string, result: T, now = Date.now()): OperationRecord<T> { return this.complete(operationId, inputHash, result, now); }
  list(): OperationRecord<T>[] { return [...this.records.values()]; }
  serialize(): string { return JSON.stringify(this.list()); }
  static fromJSON<T>(serialized: string, ttlMs?: number): OperationStore<T> { const value: unknown = JSON.parse(serialized); if (!Array.isArray(value)) throw new Error("INVALID_ARGUMENT: invalid operation store"); const store = new OperationStore<T>(ttlMs); for (const item of value) { if (!item || typeof item !== "object" || typeof (item as { operationId?: unknown }).operationId !== "string" || typeof (item as { inputHash?: unknown }).inputHash !== "string") throw new Error("INVALID_ARGUMENT: invalid operation record"); const candidate = item as Partial<OperationRecord<T>>; const status = candidate.status ?? "completed"; if (status !== "in_progress" && status !== "completed" && status !== "failed") throw new Error("INVALID_ARGUMENT: invalid operation status"); store.records.set(candidate.operationId!, { ...candidate, status } as OperationRecord<T>); } return store; }
}
