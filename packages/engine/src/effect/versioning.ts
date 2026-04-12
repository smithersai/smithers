export type WorkflowPatchDecisions = Record<string, boolean>;
export type WorkflowVersioningRuntime = {
    resolve(patchId: string): boolean;
    flush(): Promise<void>;
    snapshot(): WorkflowPatchDecisions;
};
export type WorkflowPatchDecisionRecord = {
    patchId: string;
    decision: boolean;
};
type WorkflowVersioningRuntimeOptions = {
    baseConfig: Record<string, unknown>;
    initialDecisions?: WorkflowPatchDecisions;
    isNewRun: boolean;
    persist: (config: Record<string, unknown>) => Promise<void>;
    recordDecision?: (record: WorkflowPatchDecisionRecord) => Promise<void>;
};
export declare function createWorkflowVersioningRuntime(options: WorkflowVersioningRuntimeOptions): WorkflowVersioningRuntime;
export declare function withWorkflowVersioningRuntime<T>(runtime: WorkflowVersioningRuntime, execute: () => T): T;
export declare function getWorkflowVersioningRuntime(): WorkflowVersioningRuntime | undefined;
export declare function getWorkflowPatchDecisions(config: Record<string, unknown> | null | undefined): WorkflowPatchDecisions;
export declare function usePatched(patchId: string): boolean;
export {};
