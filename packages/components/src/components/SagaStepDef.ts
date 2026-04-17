import type React from "react";

export type SagaStepDef = {
	id: string;
	action: React.ReactElement;
	compensation: React.ReactElement;
	label?: string;
};
