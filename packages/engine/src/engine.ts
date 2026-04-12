import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import type { SmithersCtx } from "@smithers/driver/SmithersCtx";
import type { RunOptions } from "@smithers/driver/RunOptions";
import type { RunResult } from "@smithers/driver/RunResult";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import type { GraphSnapshot } from "@smithers/graph/GraphSnapshot";
import { SmithersError } from "@smithers/errors/SmithersError";
import { type TaskStateMap } from "./scheduler";
import { Effect } from "effect";
type HijackCompletion = {
    requestedAtMs: number;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    mode: "native-cli" | "conversation";
    resume?: string;
    messages?: unknown[];
    cwd: string;
};
export type HijackState = {
    request: {
        requestedAtMs: number;
        target?: string | null;
    } | null;
    completion: HijackCompletion | null;
};
export declare function isRunHeartbeatFresh(run: {
    status?: string | null;
    heartbeatAtMs?: number | null;
} | null | undefined, now?: number): boolean;
export declare function resolveSchema(db: {
    _?: {
        fullSchema?: Record<string, unknown>;
        schema?: Record<string, unknown>;
    };
    schema?: Record<string, unknown>;
}): Record<string, unknown>;
/**
 * Apply only the global maxConcurrency cap.
 *
 * Per-group caps (Parallel/MergeQueue) are enforced upstream by the scheduler
 * when selecting runnable tasks. Keeping group logic in a single place avoids
 * double-enforcement and admission drift.
 */
export declare function applyConcurrencyLimits(runnable: TaskDescriptor[], stateMap: TaskStateMap, maxConcurrency: number, allTasks: TaskDescriptor[]): TaskDescriptor[];
export declare function renderFrame<Schema>(workflow: SmithersWorkflow<Schema>, ctx: SmithersCtx<Schema>, opts?: {
    baseRootDir?: string;
    workflowPath?: string | null;
}): Effect.Effect<GraphSnapshot, SmithersError>;
export declare function runWorkflow<Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions): Effect.Effect<RunResult, SmithersError>;
export {};
