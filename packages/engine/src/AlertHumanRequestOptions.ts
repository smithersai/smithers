export type AlertHumanRequestOptions = {
	runId: string;
	nodeId: string;
	iteration: number;
	kind: "ask" | "confirm" | "select" | "json";
	prompt: string;
	linkedAlertId?: string;
};
