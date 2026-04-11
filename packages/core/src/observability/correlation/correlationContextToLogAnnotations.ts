import type { CorrelationContext } from "./CorrelationContext.ts";

export function correlationContextToLogAnnotations(
  context?: CorrelationContext | null,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const annotations: Record<string, unknown> = {};
  if (context.runId) annotations.runId = context.runId;
  if (context.nodeId) annotations.nodeId = context.nodeId;
  if (context.workflowName) annotations.workflowName = context.workflowName;
  if (context.parentRunId) annotations.parentRunId = context.parentRunId;
  if (context.traceId) annotations.traceId = context.traceId;
  if (context.spanId) annotations.spanId = context.spanId;
  if (typeof context.iteration === "number") annotations.iteration = context.iteration;
  if (typeof context.attempt === "number") annotations.attempt = context.attempt;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}
