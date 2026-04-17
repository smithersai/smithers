import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";

export type ChildWorkflowDefinition =
	| SmithersWorkflow<unknown>
	| (() => SmithersWorkflow<unknown> | unknown);
