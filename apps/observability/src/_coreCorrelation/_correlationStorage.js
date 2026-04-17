import { AsyncLocalStorage } from "node:async_hooks";
/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/** @type {AsyncLocalStorage<CorrelationContext>} */
export const correlationStorage = new AsyncLocalStorage();
