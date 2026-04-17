import type { SmithersIdeCommandBaseResult } from "./SmithersIdeCommandBaseResult.ts";

export type SmithersIdeOpenFileResult = SmithersIdeCommandBaseResult & {
	readonly column: number | null;
	readonly line: number | null;
	readonly opened: boolean;
	readonly path: string;
};
