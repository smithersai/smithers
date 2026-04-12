import React from "react";
import { type TokenBudgetConfig, type LatencySloConfig, type CostBudgetConfig, type TrackingConfig, type AspectContextValue } from "../aspects/AspectContext";
export type AspectsProps = {
    /** Token budget — max total tokens, optional per-task limit, and exceeded behavior. */
    tokenBudget?: TokenBudgetConfig;
    /** Latency SLO — max total latency, optional per-task limit, and exceeded behavior. */
    latencySlo?: LatencySloConfig;
    /** Cost budget — max total USD, and exceeded behavior. */
    costBudget?: CostBudgetConfig;
    /** Which metrics to track. Defaults to all enabled. */
    tracking?: TrackingConfig;
    /** Workflow content these aspects apply to. */
    children?: React.ReactNode;
};
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
 */
export declare function Aspects(props: AspectsProps): React.FunctionComponentElement<React.ProviderProps<AspectContextValue | null>>;
