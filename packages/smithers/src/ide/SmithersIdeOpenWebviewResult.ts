import type { SmithersIdeCommandBaseResult } from "./SmithersIdeCommandBaseResult.ts";

export type SmithersIdeOpenWebviewResult = SmithersIdeCommandBaseResult & {
	readonly opened: boolean;
	readonly tabId: string | null;
	readonly url: string;
};
