import * as Activity from "@effect/workflow/Activity";
import { Schema } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
export type TaskActivityContext = {
    attempt: number;
    idempotencyKey: string;
};
export type TaskActivityRetryOptions = {
    times: number;
    while?: (error: unknown) => boolean;
};
export type ExecuteTaskActivityOptions = {
    initialAttempt?: number;
    retry?: false | TaskActivityRetryOptions;
    includeAttemptInIdempotencyKey?: boolean;
};
export declare class RetriableTaskFailure extends Error {
    readonly nodeId: string;
    readonly attempt: number;
    constructor(nodeId: string, attempt: number);
}
export declare const makeTaskBridgeKey: (adapter: SmithersDb, workflowName: string, runId: string, desc: TaskDescriptor) => string;
export declare const makeTaskActivity: <A>(desc: TaskDescriptor, executeFn: (context: TaskActivityContext) => Promise<A> | A, options?: Pick<ExecuteTaskActivityOptions, "includeAttemptInIdempotencyKey">) => Activity.Activity<typeof Schema.Unknown, typeof Schema.Unknown, never>;
export declare const executeTaskActivity: <A>(adapter: SmithersDb, workflowName: string, runId: string, desc: TaskDescriptor, executeFn: (context: TaskActivityContext) => Promise<A> | A, options?: ExecuteTaskActivityOptions) => Promise<A>;
