import * as WorkflowEngine from "@effect/workflow/WorkflowEngine";
import { Scope } from "effect";
import type { RunOptions } from "@smithers/driver/RunOptions";
import type { RunResult } from "@smithers/driver/RunResult";
import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
type RunBodyResult = RunResult | (RunResult & {
    status: "continued";
    nextRunId: string;
});
type RunBodyExecutor = <Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions) => Promise<RunBodyResult>;
type WorkflowMakeBridgeRuntime = {
    readonly engineContext: any;
    readonly scope: Scope.CloseableScope;
    readonly parentInstance: WorkflowEngine.WorkflowInstance["Type"];
    readonly executeBody: RunBodyExecutor;
    executeChildWorkflow: <Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions & {
        runId: string;
    }) => Promise<RunResult>;
};
type SchedulerWakeQueue = {
    notify(): void;
    wait(): Promise<void>;
};
export declare function withWorkflowMakeBridgeRuntime<T>(runtime: WorkflowMakeBridgeRuntime, execute: () => T): T;
export declare function getWorkflowMakeBridgeRuntime(): WorkflowMakeBridgeRuntime | undefined;
export declare function createSchedulerWakeQueue(): SchedulerWakeQueue;
export declare function runWorkflowWithMakeBridge<Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions & {
    runId: string;
}, executeBody: RunBodyExecutor): Promise<RunResult>;
export {};
