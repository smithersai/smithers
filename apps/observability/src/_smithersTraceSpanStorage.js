import { AsyncLocalStorage } from "node:async_hooks";
/** @type {AsyncLocalStorage<import("effect/Tracer").AnySpan>} */
export const smithersTraceSpanStorage = new AsyncLocalStorage();
