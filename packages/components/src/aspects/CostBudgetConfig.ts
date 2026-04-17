/**
 * Cost budget configuration for Aspects.
 */
export type CostBudgetConfig = {
	/** Maximum total cost in USD across all tasks within the Aspects scope. */
	maxUsd: number;
	/** Behavior when the budget is exceeded. Default: "fail". */
	onExceeded?: "fail" | "warn" | "skip-remaining";
};
