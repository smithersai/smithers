// @smithers-type-exports-begin
/** @typedef {import("./AspectAccumulator.ts").AspectAccumulator} AspectAccumulator */
/** @typedef {import("./AspectContextValue.ts").AspectContextValue} AspectContextValue */
/** @typedef {import("./CostBudgetConfig.ts").CostBudgetConfig} CostBudgetConfig */
/** @typedef {import("./LatencySloConfig.ts").LatencySloConfig} LatencySloConfig */
/** @typedef {import("./TokenBudgetConfig.ts").TokenBudgetConfig} TokenBudgetConfig */
/** @typedef {import("./TrackingConfig.ts").TrackingConfig} TrackingConfig */
// @smithers-type-exports-end

import React from "react";
/**
 * React context that propagates Aspects configuration down the component tree.
 * Tasks read from this context to enforce budgets and track metrics.
 * @type {React.Context<AspectContextValue | null>}
 */
export const AspectContext = React.createContext(/** @type {AspectContextValue | null} */ (null));
AspectContext.displayName = "AspectContext";
/**
 * Create a fresh accumulator with zeroed counters.
 * @returns {AspectAccumulator}
 */
export function createAccumulator() {
    return {
        totalTokens: 0,
        totalLatencyMs: 0,
        totalCostUsd: 0,
        taskCount: 0,
    };
}
