import type { WorkflowSourceType } from "./WorkflowSourceType.ts";

export type DiscoveredWorkflow = {
    id: string;
    displayName: string;
    sourceType: WorkflowSourceType;
    entryFile: string;
    path: string;
};
