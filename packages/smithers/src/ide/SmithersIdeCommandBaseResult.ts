export type SmithersIdeCommandBaseResult = {
	readonly args: readonly string[];
	readonly command: string;
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;
};
