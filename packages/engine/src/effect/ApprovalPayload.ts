export type ApprovalPayload = {
	runId: string;
	nodeId: string;
	iteration?: number;
	note?: string;
	decidedBy?: string;
};
