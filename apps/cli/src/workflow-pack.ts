type InitOptions = {
    force?: boolean;
    rootDir?: string;
};
type InitResult = {
    rootDir: string;
    writtenFiles: string[];
    skippedFiles: string[];
    preservedPaths: string[];
};
export declare function initWorkflowPack(options?: InitOptions): InitResult;
type WorkflowCta = {
    command: string;
    description: string;
};
export declare function getWorkflowFollowUpCtas(workflowPath: string): WorkflowCta[];
export {};
