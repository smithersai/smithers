export type SignalPayload = {
	runId: string;
	signalName: string;
	data?: unknown;
	correlationId?: string;
	sentBy?: string;
};
