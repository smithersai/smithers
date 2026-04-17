export type RunStatusSchema =
	| "running"
	| "waiting-approval"
	| "waiting-event"
	| "waiting-timer"
	| "finished"
	| "continued"
	| "failed"
	| "cancelled";
