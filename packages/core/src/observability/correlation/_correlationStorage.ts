import { AsyncLocalStorage } from "node:async_hooks";
import type { CorrelationContext } from "./CorrelationContext.ts";

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();
