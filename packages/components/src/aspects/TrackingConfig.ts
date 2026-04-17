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
