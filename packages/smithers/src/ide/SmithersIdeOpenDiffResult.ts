import type { SmithersIdeCommandBaseResult } from "./SmithersIdeCommandBaseResult.ts";

export type SmithersIdeOpenDiffResult = SmithersIdeCommandBaseResult & {
	readonly opened: boolean;
};
