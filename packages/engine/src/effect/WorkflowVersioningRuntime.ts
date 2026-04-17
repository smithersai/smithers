import type { WorkflowPatchDecisions } from "./WorkflowPatchDecisions.ts";

export type WorkflowVersioningRuntime = {
	resolve(patchId: string): boolean;
	flush(): Promise<void>;
	snapshot(): WorkflowPatchDecisions;
};
