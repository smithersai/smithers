import type { SmithersAlertPolicy } from "@smithers-orchestrator/scheduler/SmithersWorkflowOptions";

export type CreateSmithersOptions = {
	readableName?: string;
	description?: string;
	alertPolicy?: SmithersAlertPolicy;
	dbPath?: string;
	journalMode?: string;
};
