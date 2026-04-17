export type SignalResult = {
	runId: string;
	signalName: string;
	delivered: boolean;
	status: "signalled" | "ignored";
};
