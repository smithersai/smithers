import type { Flow } from "@smthrs/flow";
import { Cause, Context, Duration, Effect, Schema } from "effect";
declare const StartConflict_base: Schema.Class<StartConflict, Schema.TaggedStruct<"@smthrs/mvp/flows/StartConflict", {}>, Cause.YieldableError>;
/** The execution id already holds a start with another payload. */
export declare class StartConflict extends StartConflict_base {
}
declare const StartUnavailable_base: Schema.Class<StartUnavailable, Schema.TaggedStruct<"@smthrs/mvp/flows/StartUnavailable", {
    readonly errorCode: Schema.String;
}>, Cause.YieldableError>;
/** The remote host couldn't record the start. */
export declare class StartUnavailable extends StartUnavailable_base {
}
declare const FlowStarter_base: Context.ServiceClass<FlowStarter, "@smthrs/mvp/flows/FlowStarter", {
    readonly start: (flow: Flow.Any, options: {
        readonly executionId: string;
        readonly payload: unknown;
    }) => Effect.Effect<void, StartConflict | StartUnavailable>;
}>;
/**
 * Where a remote execution starts: records the start, and the execution runs from there. `payload` is the flow's
 * payload as its own schema types it; `Flow.Any` can't say so.
 */
export declare class FlowStarter extends FlowStarter_base {
}
/** A window of time in epoch milliseconds: from its start, up to its end. */
export interface Window {
    readonly from: number;
    readonly until: number;
}
/** The window `now` falls in: windows of `length` laid end to end from the epoch. */
export declare const windowAt: (now: number, length: Duration.Duration) => Window;
/** A window's execution: the flow, its execution id and its payload. */
export interface WindowStart {
    readonly flow: Flow.Any;
    readonly executionId: string;
    readonly payload: unknown;
}
/**
 * Returns an effect that starts the current window's execution (`start`, for windows of `length`) through
 * `FlowStarter`, at most once per window while the returned effect lives: it remembers the window it last started, a
 * cache of the starts, never their record, which is the execution. The window's one execution makes a start from
 * anywhere else a no-op, and a start that finds it started already (`StartConflict`) counts as started. A start that
 * fails or dies runs `notStarted` with its code (the host's, or the failure's own, never its message) and fails
 * nothing; the next run starts it again.
 */
export declare const startEachWindow: (length: Duration.Duration, start: (window: Window) => WindowStart, notStarted: (errorCode: string) => Effect.Effect<void>) => Effect.Effect<Effect.Effect<void, never, FlowStarter>, never, never>;
export {};
