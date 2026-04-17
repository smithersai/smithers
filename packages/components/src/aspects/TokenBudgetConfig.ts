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
