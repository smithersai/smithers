import type { SmithersIdeCommandBaseResult } from "./SmithersIdeCommandBaseResult.ts";

export type SmithersIdeRunTerminalResult = SmithersIdeCommandBaseResult & {
	readonly cwd: string | null;
	readonly launched: boolean;
	readonly status: string;
	readonly terminalCommand: string;
};
