import * as DurableDeferred from "@effect/workflow/DurableDeferred";
import * as Workflow from "@effect/workflow/Workflow";
import { Exit, Schema } from "effect";
export declare const DeferredBridgeWorkflow: Workflow.Workflow<"SmithersDeferredBridge", Schema.Struct<{
    executionId: typeof Schema.String;
}>, typeof Schema.Unknown, typeof Schema.Never>;
declare const approvalDeferredSuccessSchema: Schema.Struct<{
    approved: typeof Schema.Boolean;
    note: Schema.NullOr<typeof Schema.String>;
    decidedBy: Schema.NullOr<typeof Schema.String>;
}>;
export type ApprovalDeferredResolution = Schema.Schema.Type<typeof approvalDeferredSuccessSchema>;
export type DeferredResolution = Exit.Exit<ApprovalDeferredResolution | void, never>;
export declare const makeApprovalDeferred: (nodeId: string) => DurableDeferred.DurableDeferred<Schema.Struct<{
    approved: typeof Schema.Boolean;
    note: Schema.NullOr<typeof Schema.String>;
    decidedBy: Schema.NullOr<typeof Schema.String>;
}>, typeof Schema.Never>;
export declare const makeTimerDeferred: (nodeId: string) => DurableDeferred.DurableDeferred<typeof Schema.Void, typeof Schema.Never>;
export declare const makeDeferredBridgeKey: (runId: string, nodeId: string, iteration: number) => string;
export declare const bridgeApprovalResolve: (runId: string, nodeId: string, iteration: number, decision: {
    approved: boolean;
}) => void;
export declare const bridgeTimerResolve: (runId: string, nodeId: string, iteration: number) => void;
export declare const getDeferredResolution: (runId: string, nodeId: string, iteration: number) => DeferredResolution | undefined;
export {};
