import type { SmithersIdeCommandBaseResult } from "./SmithersIdeCommandBaseResult.ts";
import type { SmithersIdeOverlayType } from "./SmithersIdeOverlayType.ts";

export type SmithersIdeOverlayResult = SmithersIdeCommandBaseResult & {
	readonly overlayId: string | null;
	readonly shown: boolean;
	readonly type: SmithersIdeOverlayType;
};
