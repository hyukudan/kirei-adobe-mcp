import { SagaDefinition, type AppId } from "@adobe-mcp/schemas";

export interface SagaStepResult { readonly stepId: string; readonly status: "applied" | "already-applied" | "failed" | "compensated"; readonly output?: unknown; readonly error?: unknown; }
export interface SagaExecutionResult { readonly transactionId: string; readonly status: "succeeded" | "rolled-back" | "failed"; readonly steps: readonly SagaStepResult[]; readonly compensations: readonly string[]; readonly compensationErrors: readonly { stepId: string; error: unknown }[]; }
export interface SagaExecutor { execute(app: AppId, tool: string, input: unknown, idempotencyKey: string): Promise<unknown>; compensate(app: AppId, tool: string, input: unknown, idempotencyKey: string): Promise<void>; }

export class SagaTransactionLog {
  private readonly completed = new Map<string, unknown>();
  has(key: string): boolean { return this.completed.has(key); }
  get(key: string): unknown { return this.completed.get(key); }
  record(key: string, output: unknown): void { if (!this.completed.has(key)) this.completed.set(key, output); }
  clear(key: string): void { this.completed.delete(key); }
}

export async function executeSaga(definition: ReturnType<typeof SagaDefinition.parse>, executor: SagaExecutor, transactionId: string, log = new SagaTransactionLog()): Promise<SagaExecutionResult> {
  const definitionValue = SagaDefinition.parse(definition);
  const results: SagaStepResult[] = [];
  const applied: typeof definitionValue.steps[number][] = [];
  try {
    for (const step of definitionValue.steps) {
      const scopedKey = `${transactionId}:${step.idempotencyKey}`;
      if (log.has(scopedKey)) { results.push({ stepId: step.id, status: "already-applied", output: log.get(scopedKey) }); applied.push(step); continue; }
      try { const output = await executor.execute(step.app, step.tool, step.input, scopedKey); log.record(scopedKey, output); results.push({ stepId: step.id, status: "applied", output }); applied.push(step); }
      catch (error) { results.push({ stepId: step.id, status: "failed", error }); throw error; }
    }
    return { transactionId, status: "succeeded", steps: results, compensations: [], compensationErrors: [] };
  } catch {
    const compensations: string[] = [];
    const compensationErrors: Array<{ stepId: string; error: unknown }> = [];
    for (const step of [...applied].reverse()) {
      if (!step.compensateTool) continue;
      const scopedKey = `${transactionId}:${step.idempotencyKey}`;
      try { await executor.compensate(step.app, step.compensateTool, { transactionId, sourceStepId: step.id, output: log.get(scopedKey) }, `${transactionId}:compensate:${step.id}`); log.clear(scopedKey); compensations.push(step.id); const index = results.findIndex((entry) => entry.stepId === step.id); if (index >= 0) results[index] = { ...results[index]!, status: "compensated" }; }
      catch (error) { compensationErrors.push({ stepId: step.id, error }); const index = results.findIndex((entry) => entry.stepId === step.id); if (index >= 0) results[index] = { ...results[index]!, error: { original: results[index]!.error, compensation: error } }; }
    }
    return { transactionId, status: compensations.length === applied.length ? "rolled-back" : "failed", steps: results, compensations, compensationErrors };
  }
}

export function createCreativeAssemblySaga(inputs: { photoshop: unknown; illustrator: unknown; afterEffects: unknown; premiere: unknown }): ReturnType<typeof SagaDefinition.parse> {
  return SagaDefinition.parse({ id: "creative-assembly", version: "1", steps: [
    { id: "photoshop-layer-export", app: "photoshop", tool: "adobe.photoshop.exportLayers", input: inputs.photoshop, compensateTool: "adobe.operations.undo", idempotencyKey: "creative-assembly:photoshop" },
    { id: "illustrator-vector-comp", app: "illustrator", tool: "adobe.illustrator.exportArtboards", input: inputs.illustrator, compensateTool: "adobe.operations.undo", idempotencyKey: "creative-assembly:illustrator" },
    { id: "aftereffects-motion-graphics", app: "after-effects", tool: "adobe.aftereffects.preset.apply", input: inputs.afterEffects, compensateTool: "adobe.operations.undo", idempotencyKey: "creative-assembly:after-effects" },
    { id: "premiere-timeline-assembly", app: "premiere-pro", tool: "adobe.premiere.editPlan.execute", input: inputs.premiere, compensateTool: "adobe.operations.undo", idempotencyKey: "creative-assembly:premiere" },
  ] });
}
