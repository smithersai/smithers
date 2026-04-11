import { AsyncLocalStorage } from "node:async_hooks";
import type * as Tracer from "effect/Tracer";

export const smithersTraceSpanStorage = new AsyncLocalStorage<Tracer.AnySpan>();
