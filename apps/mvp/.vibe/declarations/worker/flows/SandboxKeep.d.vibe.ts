import { Action, Flow } from "@smthrs/flow";
import { Cause, Config, Effect, Layer, Metric, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Machines } from "../branch/Machines.vibe";
declare const MachineBusy_base: Schema.Class<MachineBusy, Schema.TaggedStruct<"@smthrs/mvp/sandbox/MachineBusy", {}>, Cause.YieldableError>;
/** The machine is in use: something happened in it within the idle time. The step asks again later. */
export declare class MachineBusy extends MachineBusy_base {
}
declare const SleptUnrecorded_base: Schema.Class<SleptUnrecorded, Schema.TaggedStruct<"@smthrs/mvp/sandbox/SleptUnrecorded", {}>, Cause.YieldableError>;
/** Postgres couldn't record the sleep. Retried. */
export declare class SleptUnrecorded extends SleptUnrecorded_base {
}
/** Machines `sandbox/Keep` asked about, by `outcome`: `slept`, `busy`, `gone`, or `unavailable`. */
export declare const keeps: Metric.Counter<number>;
/** Asking again while the machine is busy or can't answer: every `KEEP_EVERY_SECONDS`, for at most a week. */
export declare const KEEP_RETRY: {
    readonly initialMs: number;
    readonly factor: number;
    readonly maxMs: number;
    readonly maxAttempts?: number | undefined;
    readonly expirationMs?: number | undefined;
    readonly jitterRatio?: number | undefined;
    readonly nonRetryable?: readonly string[] | undefined;
    readonly retryable?: readonly {
        readonly tag: string;
        readonly code?: string | undefined;
    }[] | undefined;
};
/** Recording: 1 s doubling to a minute, for at most 30 minutes. */
export declare const RECORD_RETRY: {
    readonly initialMs: number;
    readonly factor: number;
    readonly maxMs: number;
    readonly maxAttempts?: number | undefined;
    readonly expirationMs?: number | undefined;
    readonly jitterRatio?: number | undefined;
    readonly nonRetryable?: readonly string[] | undefined;
    readonly retryable?: readonly {
        readonly tag: string;
        readonly code?: string | undefined;
    }[] | undefined;
};
/** Puts the generation to sleep if nothing happened in it for the idle time; `MachineBusy` while something did. */
export declare const SleepIfIdle: Action.Declared<"sandbox/SleepIfIdle", Schema.Struct<{
    branchId: Schema.String;
    generation: Schema.Number;
    machine: Schema.optional<Schema.String>;
}>, Schema.Literals<readonly ["slept", "gone"]>, typeof MachineBusy, Action.Requirement<"sandbox/SleepIfIdle">>;
/** Ends the generation's open terminals `slept` (their shells ended with the machine) and closes its ledger slot. */
export declare const Slept: Action.Declared<"sandbox/Slept", Schema.Struct<{
    branchId: Schema.String;
    generation: Schema.Number;
    ended: Schema.Literals<readonly ["slept", "gone"]>;
}>, Schema.Struct<{
    readonly ended: Schema.Literals<readonly ["slept", "gone"]>;
    readonly terminals: Schema.Number;
}>, typeof SleptUnrecorded, Action.Requirement<"sandbox/Slept">>;
/** `sandbox/Keep`: keeps a generation of a branch's machine awake while it is used, then puts it to sleep. */
export declare const Keep: Flow.Flow<"sandbox/Keep", Schema.Struct<{
    branchId: Schema.String;
    generation: Schema.Number;
    machine: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly ended: Schema.Literals<readonly ["slept", "gone"]>;
    readonly terminals: Schema.Number;
}>, Schema.Union<readonly [typeof MachineBusy, typeof SleptUnrecorded]>, Action.Requirement<"sandbox/SleepIfIdle"> | Action.Requirement<"sandbox/Slept">>;
/** How long a machine may be idle before it sleeps: `SANDBOX_IDLE_SECONDS`, `DEFAULT_IDLE_SECONDS` unless set. */
export declare const idleSeconds: Config.Config<number>;
/** The steps over the host's `Machines` and `database`, the machine idle for `idleMs` before it sleeps. */
export declare const steps: <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, idleMs: number) => {
    sleepIfIdle: ({ branchId, generation, machine }: typeof SleepIfIdle.payloadSchema.Type) => Effect.Effect<"gone" | "slept", MachineBusy, Machines | Exclude<R, import("effect/Tracer").ParentSpan>>;
    slept: ({ branchId, generation, ended }: typeof Slept.payloadSchema.Type) => Effect.Effect<{
        ended: "gone" | "slept";
        terminals: number;
    }, SleptUnrecorded, Exclude<R, import("effect/Tracer").ParentSpan>>;
};
/** Registers `sandbox/Keep` with the program's captured idle time and the host's `Machines`. */
export declare const registration: <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, idleMs?: number) => Layer.Layer<Action.Implementations | Action.Requirement<"sandbox/SleepIfIdle"> | Action.Requirement<"sandbox/Slept">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | Machines | Exclude<Exclude<Exclude<Exclude<R, import("effect/Tracer").ParentSpan>, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, Action.Implementations>, Action.Implementations>>;
export {};
