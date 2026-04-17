import type { AlertHumanRequestOptions } from "./AlertHumanRequestOptions.ts";

export type AlertRuntimeServices = {
	runId: string;
	adapter: unknown;
	eventBus: unknown;
	requestCancel: () => void;
	createHumanRequest: (options: AlertHumanRequestOptions) => Promise<void>;
	pauseScheduler: (reason: string) => void;
};
