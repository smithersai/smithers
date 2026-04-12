import React from "react";
/**
 * Token budget configuration for Aspects.
 */
export type TokenBudgetConfig = {
    /** Maximum total tokens across all tasks within the Aspects scope. */
    max: number;
    /** Optional per-task token limit. */
    perTask?: number;
    /** Behavior when the budget is exceeded. Default: "fail". */
    onExceeded?: "fail" | "warn" | "skip-remaining";
};
/**
 * Latency SLO configuration for Aspects.
 */
export type LatencySloConfig = {
    /** Maximum total latency in milliseconds across all tasks. */
    maxMs: number;
    /** Optional per-task latency limit in milliseconds. */
    perTask?: number;
    /** Behavior when the SLO is exceeded. Default: "fail". */
    onExceeded?: "fail" | "warn";
};
/**
 * Cost budget configuration for Aspects.
 */
export type CostBudgetConfig = {
    /** Maximum total cost in USD across all tasks within the Aspects scope. */
    maxUsd: number;
    /** Behavior when the budget is exceeded. Default: "fail". */
    onExceeded?: "fail" | "warn" | "skip-remaining";
};
/**
 * Tracking configuration — which metrics to track.
 */
export type TrackingConfig = {
    /** Track token usage. Default: true. */
    tokens?: boolean;
    /** Track latency. Default: true. */
    latency?: boolean;
    /** Track cost. Default: true. */
    cost?: boolean;
};
/**
 * Runtime accumulator for tracked metrics within an Aspects scope.
 */
export type AspectAccumulator = {
    totalTokens: number;
    totalLatencyMs: number;
    totalCostUsd: number;
    taskCount: number;
};
/**
 * The value provided by AspectContext to descendant components.
 */
export type AspectContextValue = {
    tokenBudget?: TokenBudgetConfig;
    latencySlo?: LatencySloConfig;
    costBudget?: CostBudgetConfig;
    tracking: TrackingConfig;
    accumulator: AspectAccumulator;
};
/**
 * React context that propagates Aspects configuration down the component tree.
 * Tasks read from this context to enforce budgets and track metrics.
 */
export declare const AspectContext: React.Context<AspectContextValue | null>;
/**
 * Create a fresh accumulator with zeroed counters.
 */
export declare function createAccumulator(): AspectAccumulator;
