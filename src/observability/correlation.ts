import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, FiberRef } from "effect";

export type CorrelationContext = {
  runId: string;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  workflowName?: string;
  parentRunId?: string;
  traceId?: string;
  spanId?: string;
};

type CorrelationContextPatch = Partial<CorrelationContext> | undefined | null;

const storage = new AsyncLocalStorage<CorrelationContext>();

export const correlationContextFiberRef =
  FiberRef.unsafeMake<CorrelationContext | undefined>(undefined);

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeCorrelationContextPatch(
  patch: CorrelationContextPatch,
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
  patch?: CorrelationContextPatch,
): CorrelationContext | undefined {
  const normalizedPatch = normalizeCorrelationContextPatch(patch);
  const merged = {
    ...(base ?? {}),
    ...(normalizedPatch ?? {}),
  } as Partial<CorrelationContext>;
  return merged.runId ? (merged as CorrelationContext) : undefined;
}

export function getCurrentCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export function getCurrentCorrelationContextEffect() {
  return FiberRef.get(correlationContextFiberRef);
}

export function runWithCorrelationContext<T>(
  patch: CorrelationContextPatch,
  fn: () => T,
): T {
  const next = mergeCorrelationContext(storage.getStore(), patch);
  return next ? storage.run(next, fn) : fn();
}

export function updateCurrentCorrelationContext(
  patch: CorrelationContextPatch,
): void {
  const current = storage.getStore();
  const normalizedPatch = normalizeCorrelationContextPatch(patch);
  if (!current || !normalizedPatch) return;
  Object.assign(current, normalizedPatch);
}

export function withCorrelationContext<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  patch: CorrelationContextPatch,
) {
  const next = mergeCorrelationContext(storage.getStore(), patch);
  return next ? effect.pipe(Effect.locally(correlationContextFiberRef, next)) : effect;
}

export function withCurrentCorrelationContext<A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const current = storage.getStore();
  return current
    ? effect.pipe(Effect.locally(correlationContextFiberRef, current))
    : effect;
}

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
  if (typeof context.iteration === "number") {
    annotations.iteration = context.iteration;
  }
  if (typeof context.attempt === "number") {
    annotations.attempt = context.attempt;
  }

  return Object.keys(annotations).length > 0 ? annotations : undefined;
}
