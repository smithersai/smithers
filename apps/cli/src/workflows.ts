export type WorkflowSourceType = "user" | "seeded" | "generated" | string;
export type DiscoveredWorkflow = {
    id: string;
    displayName: string;
    sourceType: WorkflowSourceType;
    entryFile: string;
    path: string;
};
export declare function discoverWorkflows(root: string): DiscoveredWorkflow[];
export declare function validateWorkflowName(name: string): void;
export declare function resolveWorkflow(id: string, root: string): DiscoveredWorkflow;
export declare function createWorkflowFile(name: string, root: string): DiscoveredWorkflow;
