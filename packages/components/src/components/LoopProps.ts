import type React from "react";

export type LoopProps = {
	id?: string;
	until?: boolean;
	maxIterations?: number;
	onMaxReached?: "fail" | "return-last";
	continueAsNewEvery?: number;
	skipIf?: boolean;
	children?: React.ReactNode;
};
