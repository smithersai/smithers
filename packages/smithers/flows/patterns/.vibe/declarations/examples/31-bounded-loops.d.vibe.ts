/**
 * Repair a configuration, refine a summary, and drain a queue on the engine.
 *
 * ScanFixVerify.make and Optimizer.make declare the bounded work. The queue
 * flow hands off to itself until it is empty, with maxRounds bounding the
 * lineage. The host supplies the engine and crypto services.
 */
import { Action, Flow } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
interface Setting {
    readonly key: string;
    readonly value: number;
}
/** Repairs a copy of the configuration with journaled action calls. */
export declare const repair: (initial?: ReadonlyMap<string, number>) => Effect.Effect<{
    iterations: number;
    remaining: readonly {
        readonly key: string;
        readonly value: number;
        readonly limit: number;
    }[];
    settled: {
        key: string;
        value: number;
    }[];
}, never, import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/flow/FlowRuntime").FlowRuntime>;
/**
 * Compares the repaired config to the baseline an operator recorded, and pages
 * only when it moved: a changed value, a missing setting, or one the baseline
 * never approved.
 * The baseline is the config as last recorded, so the repair is exactly what
 * the detector reports: two settings moved away from what the operator
 * approved, and the alert names them.
 *
 * The detector runs once. For polling, declare a flow that hands off to itself
 * with `.to(...)` and bounds the lineage with `maxRounds`.
 */
export declare const audit: (settled: ReadonlyArray<Setting>) => Effect.Effect<{
    readonly drifted: boolean;
    readonly paged: ReadonlyArray<string>;
}>;
/**
 * The candidates the search produces, in order. The second is the shortest, so
 * the last attempt is not the best one.
 */
export declare const wordy: ReadonlyArray<string>;
/** Runs the search and returns the best summary. */
export declare const tune: Effect.Effect<{
    best: string;
    score: number;
    iterations: number;
    converged: boolean;
}, never, import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/flow/FlowRuntime").FlowRuntime>;
/**
 * Runs a cheap shadow beside the expensive summary to see whether the cheap
 * seat would have been good enough.
 *
 * The shadow here fails. A sidecar quarantines that, because the shadow is an
 * experiment and the primary result is the answer. `delta` stays absent, since
 * there is nothing to compare against.
 */
export declare const shadow: Effect.Effect<{
    readonly primary: string;
    readonly quarantined: boolean;
    readonly delta: number | undefined;
}>;
declare const QueuePayload: Schema.Struct<{
    readonly pending: Schema.Number;
    readonly turns: Schema.Number;
}>;
type QueuePayload = typeof QueuePayload.Type;
declare const QueueResult: Schema.Struct<{
    readonly turns: Schema.Number;
    readonly exhausted: Schema.Boolean;
}>;
type QueueResult = typeof QueueResult.Type;
type QueueFlow = Flow.Flow<"bounded-loops/queue", typeof QueuePayload, typeof QueueResult, typeof Schema.Never, Action.Requirement<"bounded-loops/drain">>;
/** Each round journals one drain step, then settles or opens the next round. */
export declare const Queue: QueueFlow;
/** Runs a queue lineage with a caller-owned execution identity. */
export declare const drain: (pending: number, executionId: string) => Effect.Effect<{
    readonly turns: number;
    readonly exhausted: boolean;
}, import("@smthrs/flow/FlowRuntime").ExecutionIdentityConflict | import("@smthrs/flow/FlowRuntime").FlowCycleDetected | Schema.SchemaError, import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/flow/FlowRuntime").FlowRuntime>;
/** Drains three items through three engine rounds. */
export declare const settle: Effect.Effect<{
    readonly turns: number;
    readonly exhausted: boolean;
}, import("@smthrs/flow/FlowRuntime").ExecutionIdentityConflict | import("@smthrs/flow/FlowRuntime").FlowCycleDetected | Schema.SchemaError, import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/flow/FlowRuntime").FlowRuntime>;
/**
 * Runs the whole story: repair, audit, tune, shadow, settle.
 */
export declare const main: Effect.Effect<{
    repair: {
        iterations: number;
        remaining: readonly {
            readonly key: string;
            readonly value: number;
            readonly limit: number;
        }[];
    };
    audit: {
        readonly drifted: boolean;
        readonly paged: ReadonlyArray<string>;
    };
    tune: {
        best: string;
        converged: boolean;
    };
    shadow: {
        quarantined: boolean;
    };
    settle: {
        turns: number;
    };
}, import("@smthrs/flow/FlowRuntime").ExecutionIdentityConflict | import("@smthrs/flow/FlowRuntime").FlowCycleDetected | Schema.SchemaError, import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/flow/FlowRuntime").FlowRuntime>;
export {};
