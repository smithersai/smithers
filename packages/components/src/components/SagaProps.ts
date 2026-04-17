import type React from "react";
import type { SagaStepDef } from "./SagaStepDef.ts";

export type SagaProps = {
	id?: string;
	steps?: SagaStepDef[];
	onFailure?: "compensate" | "compensate-and-fail" | "fail";
	skipIf?: boolean;
	children?: React.ReactNode;
};
