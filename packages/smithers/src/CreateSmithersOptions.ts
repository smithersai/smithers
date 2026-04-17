import type { SmithersAlertPolicy } from "@smithers/scheduler/SmithersWorkflowOptions";

export type CreateSmithersOptions = {
	readableName?: string;
	description?: string;
	alertPolicy?: SmithersAlertPolicy;
	dbPath?: string;
	journalMode?: string;
};
