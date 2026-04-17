type HijackCompletion = {
	requestedAtMs: number;
	nodeId: string;
	iteration: number;
	attempt: number;
	engine: string;
	mode: "native-cli" | "conversation";
	resume?: string;
	messages?: unknown[];
	cwd: string;
};

export type HijackState = {
	request: {
		requestedAtMs: number;
		target?: string | null;
	} | null;
	completion: HijackCompletion | null;
};
