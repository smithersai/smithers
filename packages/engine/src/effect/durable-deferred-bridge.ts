import * as DurableDeferred from "@effect/workflow/DurableDeferred";
import * as Workflow from "@effect/workflow/Workflow";
import { Exit, Schema } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
export declare const DurableDeferredBridgeWorkflow: Workflow.Workflow<"SmithersDurableDeferredBridge", Schema.Struct<{
    executionId: typeof Schema.String;
}>, typeof Schema.Unknown, typeof Schema.Never>;
export declare const approvalDurableDeferredSuccessSchema: Schema.Struct<{
    approved: typeof Schema.Boolean;
    note: Schema.NullOr<typeof Schema.String>;
    decidedBy: Schema.NullOr<typeof Schema.String>;
    decisionJson: Schema.NullOr<typeof Schema.String>;
    autoApproved: typeof Schema.Boolean;
}>;
export type ApprovalDurableDeferredResolution = Schema.Schema.Type<typeof approvalDurableDeferredSuccessSchema>;
export declare const waitForEventDurableDeferredSuccessSchema: Schema.Struct<{
    signalName: typeof Schema.String;
    correlationId: Schema.NullOr<typeof Schema.String>;
    payloadJson: typeof Schema.String;
    seq: typeof Schema.Number;
    receivedAtMs: typeof Schema.Number;
}>;
export type WaitForEventDurableDeferredResolution = Schema.Schema.Type<typeof waitForEventDurableDeferredSuccessSchema>;
type WaitForEventSignalInput = {
    signalName: string;
    correlationId: string | null;
    payloadJson: string;
    seq: number;
    receivedAtMs: number;
};
type BridgeDeferredResult = {
    _tag: "Complete";
    exit: Exit.Exit<any, any>;
} | {
    _tag: "Pending";
};
export declare const makeDurableDeferredBridgeExecutionId: (adapter: SmithersDb, runId: string, nodeId: string, iteration: number) => string;
export declare const makeApprovalDurableDeferred: (nodeId: string) => DurableDeferred.DurableDeferred<Schema.Struct<{
    approved: typeof Schema.Boolean;
    note: Schema.NullOr<typeof Schema.String>;
    decidedBy: Schema.NullOr<typeof Schema.String>;
    decisionJson: Schema.NullOr<typeof Schema.String>;
    autoApproved: typeof Schema.Boolean;
}>, typeof Schema.Never>;
export declare const makeWaitForEventDurableDeferred: (nodeId: string) => DurableDeferred.DurableDeferred<Schema.Struct<{
    signalName: typeof Schema.String;
    correlationId: Schema.NullOr<typeof Schema.String>;
    payloadJson: typeof Schema.String;
    seq: typeof Schema.Number;
    receivedAtMs: typeof Schema.Number;
}>, typeof Schema.Never>;
export declare const awaitApprovalDurableDeferred: (adapter: SmithersDb, runId: string, nodeId: string, iteration: number) => Promise<BridgeDeferredResult>;
export declare const awaitWaitForEventDurableDeferred: (adapter: SmithersDb, runId: string, nodeId: string, iteration: number) => Promise<BridgeDeferredResult>;
export declare const bridgeApprovalResolve: (adapter: SmithersDb, runId: string, nodeId: string, iteration: number, resolution: {
    approved: boolean;
    note?: string | null;
    decidedBy?: string | null;
    decisionJson?: string | null;
    autoApproved?: boolean;
}) => Promise<void>;
export declare const bridgeWaitForEventResolve: (adapter: SmithersDb, runId: string, nodeId: string, iteration: number, signal: WaitForEventSignalInput) => Promise<void>;
export declare const bridgeSignalResolve: (adapter: SmithersDb, runId: string, signal: WaitForEventSignalInput) => Promise<void>;
export {};
