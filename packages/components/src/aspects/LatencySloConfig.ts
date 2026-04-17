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
