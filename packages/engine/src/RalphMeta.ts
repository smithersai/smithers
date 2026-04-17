export type RalphMeta = {
	id: string;
	until: boolean;
	maxIterations: number;
	onMaxReached: "fail" | "return-last";
	continueAsNewEvery?: number;
};
