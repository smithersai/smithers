/**
 * Runtime accumulator for tracked metrics within an Aspects scope.
 */
export type AspectAccumulator = {
	totalTokens: number;
	totalLatencyMs: number;
	totalCostUsd: number;
	taskCount: number;
};
