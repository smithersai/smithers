import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";

export type ChildWorkflowDefinition =
	| SmithersWorkflow<any>
	| (() => SmithersWorkflow<any> | unknown);
