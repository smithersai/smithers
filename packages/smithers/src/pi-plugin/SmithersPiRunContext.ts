export type SmithersPiRunContext = {
	runId: string;
	workflowName: string;
	status: string;
	nodeStates: Array<{ nodeId: string; state: string }>;
	errors: string[];
};
