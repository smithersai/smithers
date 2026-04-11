import type * as Tracer from "effect/Tracer";
import { smithersTraceSpanStorage } from "./_smithersTraceSpanStorage";

export function getCurrentSmithersTraceSpan(): Tracer.AnySpan | undefined {
  return smithersTraceSpanStorage.getStore();
}
