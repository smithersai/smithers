import { getCurrentSmithersTraceSpan } from "./getCurrentSmithersTraceSpan";

export function getCurrentSmithersTraceAnnotations():
  | Readonly<Record<string, string>>
  | undefined {
  const span = getCurrentSmithersTraceSpan();
  if (!span) {
    return undefined;
  }
  return {
    traceId: span.traceId,
    spanId: span.spanId,
  };
}
