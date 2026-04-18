import type { SmithersWorkflow } from "@smithers-orchestrator/components/SmithersWorkflow";

export type ChildWorkflowDefinition =
	| SmithersWorkflow<unknown>
	| (() => SmithersWorkflow<unknown> | unknown);
