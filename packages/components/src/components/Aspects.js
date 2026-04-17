// @smithers-type-exports-begin
/** @typedef {import("./AspectsProps.ts").AspectsProps} AspectsProps */
// @smithers-type-exports-end

import React from "react";
import { AspectContext, createAccumulator, } from "../aspects/AspectContext.js";
/**
 * Aspects — declarative cross-cutting concerns for workflow scopes.
 *
 * Wraps a section of the workflow tree and propagates token budgets,
 * latency SLOs, and cost budgets to all descendant Task components
 * without modifying individual tasks.
 *
 * ```tsx
 * <Aspects tokenBudget={{ max: 100_000, perTask: 20_000, onExceeded: "warn" }}>
 *   <Task id="step1" ...>...</Task>
 *   <Task id="step2" ...>...</Task>
 * </Aspects>
 * ```
 * @param {AspectsProps} props
 */
export function Aspects(props) {
    const { tokenBudget, latencySlo, costBudget, tracking, children } = props;
    // Merge with parent context if nested
    const parentCtx = React.useContext(AspectContext);
    const resolvedTracking = {
        tokens: tracking?.tokens ?? parentCtx?.tracking?.tokens ?? true,
        latency: tracking?.latency ?? parentCtx?.tracking?.latency ?? true,
        cost: tracking?.cost ?? parentCtx?.tracking?.cost ?? true,
    };
    const value = {
        tokenBudget: tokenBudget ?? parentCtx?.tokenBudget,
        latencySlo: latencySlo ?? parentCtx?.latencySlo,
        costBudget: costBudget ?? parentCtx?.costBudget,
        tracking: resolvedTracking,
        accumulator: parentCtx?.accumulator ?? createAccumulator(),
    };
    return React.createElement(AspectContext.Provider, { value }, children);
}
