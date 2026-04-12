import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import type { RunResult } from "@smithers/driver/RunResult";
export type ChildWorkflowDefinition = SmithersWorkflow<any> | (() => SmithersWorkflow<any> | unknown);
export type ChildWorkflowExecuteOptions = {
    workflow: ChildWorkflowDefinition;
    input?: unknown;
    runId?: string;
    parentRunId?: string;
    rootDir?: string;
    allowNetwork?: boolean;
    maxOutputBytes?: number;
    toolTimeoutMs?: number;
    workflowPath?: string;
    signal?: AbortSignal;
};
export declare function executeChildWorkflow(parentWorkflow: SmithersWorkflow<any> | undefined, options: ChildWorkflowExecuteOptions): Promise<{
    runId: string;
    status: RunResult["status"];
    output: unknown;
}>;
