import type { SmithersIdeCommandBaseResult } from "./SmithersIdeCommandBaseResult.ts";

export type SmithersIdeAskUserResult = SmithersIdeCommandBaseResult & {
	readonly overlayId: string | null;
	readonly prompt: string;
	readonly status: "prompted";
};
