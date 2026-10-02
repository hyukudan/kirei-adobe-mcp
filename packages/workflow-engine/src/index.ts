interface Schema { parse(value: unknown): unknown; }
export interface WorkflowNode { id: string; tool: string; input?: unknown; dependsOn?: readonly string[]; retries?: number; compensateWith?: string; output?: { schema?: Schema; path?: string }; when?: { path: string; equals: unknown }; }
export interface Workflow { version: string; nodes: readonly WorkflowNode[]; }
export interface WorkflowStepResult { nodeId: string; status: "succeeded" | "failed"; attempts: number; output?: unknown; error?: unknown; }
export interface WorkflowExecutionResult { status: "succeeded" | "failed"; steps: readonly WorkflowStepResult[]; compensations: readonly string[]; data: Readonly<Record<string, unknown>>; }
export type WorkflowExecutor = (tool: string, input: unknown, context: Readonly<Record<string, unknown>>) => Promise<unknown>;

function assertPointer(value: string): void { if (value.length > 1024 || !/^(|\/(?:[^~/]|~0|~1)*)$/.test(value)) throw new Error("INVALID_ARGUMENT: unsupported JSON pointer"); }
function assertNode(node: WorkflowNode): void { if (!/^[A-Za-z0-9._-]{1,128}$/.test(node.id) || !node.tool || node.tool.length > 256) throw new Error("INVALID_ARGUMENT: invalid workflow node"); if ((node.retries ?? 0) < 0 || (node.retries ?? 0) > 3 || !Number.isInteger(node.retries ?? 0)) throw new Error("INVALID_ARGUMENT: maximum retries is 3"); if (node.output?.path !== undefined) assertPointer(node.output.path); if (node.when) assertPointer(node.when.path); }
export function validateWorkflow(workflow: Workflow): void {
  if (!workflow || workflow.version.length > 32 || workflow.nodes.length === 0 || workflow.nodes.length > 100) throw new Error("INVALID_ARGUMENT: invalid workflow size");
  const ids = new Set<string>(); for (const node of workflow.nodes) { assertNode(node); if (ids.has(node.id)) throw new Error("INVALID_ARGUMENT: duplicate workflow node"); ids.add(node.id); }
  const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const visit = (id: string): void => { if (visiting.has(id)) throw new Error("INVALID_ARGUMENT: workflow cycle"); if (visited.has(id)) return; const node = byId.get(id); if (!node) throw new Error(`INVALID_ARGUMENT: unknown dependency ${id}`); visiting.add(id); for (const dependency of node.dependsOn ?? []) visit(dependency); visiting.delete(id); visited.add(id); };
  for (const node of workflow.nodes) visit(node.id);
}
function pointerGet(value: unknown, pointer: string): unknown { if (!pointer) return value; return pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")).reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value); }
export function executionOrder(workflow: Workflow): string[] { validateWorkflow(workflow); const byId = new Map(workflow.nodes.map((node) => [node.id, node])); const order: string[] = []; const added = new Set<string>(); const visit = (id: string): void => { const node = byId.get(id)!; for (const dependency of node.dependsOn ?? []) visit(dependency); if (!added.has(id)) { added.add(id); order.push(id); } }; for (const node of workflow.nodes) visit(node.id); return order; }

export async function executeWorkflow(workflow: Workflow, executor: WorkflowExecutor): Promise<WorkflowExecutionResult> {
  validateWorkflow(workflow); const byId = new Map(workflow.nodes.map((node) => [node.id, node])); const data: Record<string, unknown> = {}; const results: WorkflowStepResult[] = []; const completed: WorkflowNode[] = [];
  try {
    for (const nodeId of executionOrder(workflow)) {
      const node = byId.get(nodeId)!; if (node.when && pointerGet(data, node.when.path) !== node.when.equals) { results.push({ nodeId, status: "succeeded", attempts: 0, output: undefined }); continue; }
      const input = node.input; let attempts = 0; let output: unknown; let lastError: unknown;
      for (let attempt = 0; attempt <= (node.retries ?? 0); attempt++) { attempts++; try { output = await executor(node.tool, input, data); if (node.output?.schema) output = node.output.schema.parse(output); lastError = undefined; break; } catch (error) { lastError = error; } }
      if (lastError !== undefined) { results.push({ nodeId, status: "failed", attempts, error: lastError }); throw lastError; }
      data[node.id] = output; results.push({ nodeId, status: "succeeded", attempts, output }); completed.push(node);
    }
    return { status: "succeeded", steps: results, compensations: [], data };
  } catch (error) {
    const compensations: string[] = []; for (const node of completed.reverse()) if (node.compensateWith) { await executor(node.compensateWith, { sourceNodeId: node.id, sourceOutput: data[node.id] }, data); compensations.push(node.compensateWith); }
    return { status: "failed", steps: results, compensations, data };
  }
}

export * from "./saga.js";
