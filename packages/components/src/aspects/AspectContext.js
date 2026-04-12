// @smithers-type-exports-begin
/** @typedef {import("./AspectContext.ts").AspectAccumulator} AspectAccumulator */
/** @typedef {import("./AspectContext.ts").AspectContextValue} AspectContextValue */
/** @typedef {import("./AspectContext.ts").CostBudgetConfig} CostBudgetConfig */
/** @typedef {import("./AspectContext.ts").LatencySloConfig} LatencySloConfig */
/** @typedef {import("./AspectContext.ts").TokenBudgetConfig} TokenBudgetConfig */
/** @typedef {import("./AspectContext.ts").TrackingConfig} TrackingConfig */
// @smithers-type-exports-end

import React from "react";
/**
 * React context that propagates Aspects configuration down the component tree.
 * Tasks read from this context to enforce budgets and track metrics.
 */
export const AspectContext = React.createContext(null);
AspectContext.displayName = "AspectContext";
/**
 * Create a fresh accumulator with zeroed counters.
 */
export function createAccumulator() {
    return {
        totalTokens: 0,
        totalLatencyMs: 0,
        totalCostUsd: 0,
        taskCount: 0,
    };
}
