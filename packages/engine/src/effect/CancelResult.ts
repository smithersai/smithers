export type CancelResult = {
	runId: string;
	status: "cancelling" | "cancelled";
};
