import type { CorrelationContext } from "./CorrelationContext.ts";
import type { CorrelationPatch } from "./CorrelationPatch.ts";

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePatch(
  patch: CorrelationPatch,
): Partial<CorrelationContext> | undefined {
  if (!patch) return undefined;
  const normalized: Partial<CorrelationContext> = {};
  const runId = cleanString(patch.runId);
  const nodeId = cleanString(patch.nodeId);
  const workflowName = cleanString(patch.workflowName);
  const parentRunId = cleanString(patch.parentRunId);
  const traceId = cleanString(patch.traceId);
  const spanId = cleanString(patch.spanId);
  const iteration = cleanNumber(patch.iteration);
  const attempt = cleanNumber(patch.attempt);
  if (runId) normalized.runId = runId;
  if (nodeId) normalized.nodeId = nodeId;
  if (workflowName) normalized.workflowName = workflowName;
  if (parentRunId) normalized.parentRunId = parentRunId;
  if (traceId) normalized.traceId = traceId;
  if (spanId) normalized.spanId = spanId;
  if (iteration !== undefined) normalized.iteration = iteration;
  if (attempt !== undefined) normalized.attempt = attempt;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeCorrelationContext(
  base?: CorrelationContext | null,
  patch?: CorrelationPatch,
): CorrelationContext | undefined {
  const normalizedPatch = normalizePatch(patch);
  const merged = { ...base, ...normalizedPatch } as Partial<CorrelationContext>;
  return merged.runId ? (merged as CorrelationContext) : undefined;
}
