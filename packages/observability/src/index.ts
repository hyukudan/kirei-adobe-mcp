import { redact } from "@adobe-mcp/policy";
export interface LogRecord { level: "debug" | "info" | "warn" | "error"; message: string; requestId?: string; operationId?: string; traceId?: string; data?: unknown; }
export function serializeLog(record: LogRecord): string { return JSON.stringify(redact({ timestamp: new Date().toISOString(), ...record })); }
