import React from "react";
import {
  AspectContext,
  createAccumulator,
  type TokenBudgetConfig,
  type LatencySloConfig,
  type CostBudgetConfig,
  type TrackingConfig,
  type AspectContextValue,
} from "../aspects/AspectContext";

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
export function Aspects(props: AspectsProps) {
  const { tokenBudget, latencySlo, costBudget, tracking, children } = props;

  // Merge with parent context if nested
  const parentCtx = React.useContext(AspectContext);

  const resolvedTracking: TrackingConfig = {
    tokens: tracking?.tokens ?? parentCtx?.tracking?.tokens ?? true,
    latency: tracking?.latency ?? parentCtx?.tracking?.latency ?? true,
    cost: tracking?.cost ?? parentCtx?.tracking?.cost ?? true,
  };

  const value: AspectContextValue = {
    tokenBudget: tokenBudget ?? parentCtx?.tokenBudget,
    latencySlo: latencySlo ?? parentCtx?.latencySlo,
    costBudget: costBudget ?? parentCtx?.costBudget,
    tracking: resolvedTracking,
    accumulator: parentCtx?.accumulator ?? createAccumulator(),
  };

  return React.createElement(
    AspectContext.Provider,
    { value },
    children,
  );
}
