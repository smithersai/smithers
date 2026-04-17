export type SmithersIdeResolvedConfig = {
	readonly command: string;
	readonly cwd: string;
	readonly env: Record<string, string | undefined>;
	readonly idleTimeoutMs: number;
	readonly maxOutputBytes: number;
	readonly timeoutMs: number;
};
