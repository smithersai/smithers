import { Action, Flow, Sleep } from "@smthrs/flow";
import { Effect, Layer, Schema } from "effect";
/** One step: the host decides what marking `label` does, and the step's result is the label. */
export declare const Mark: Action.Declared<"probe/Mark", Schema.Struct<{
    label: Schema.String;
}>, Schema.String, Schema.Never, Action.Requirement<"probe/Mark">>;
/**
 * Marks `<label>:before`, sleeps `pauseMs` on a durable timer, then marks `<label>:after` and succeeds with it. A
 * negative pause is the flow's own declared failure, `SleepRequestInvalid`.
 */
export declare const Pause: Flow.Flow<"probe/Pause", Schema.Struct<{
    label: Schema.String;
    pauseMs: Schema.Number;
}>, Schema.String, typeof Sleep.SleepRequestInvalid, Action.Requirement<"probe/Mark">>;
/**
 * Registers `Pause` with `mark` as its step, through the canonical composition, so a new incarnation on any host
 * rebuilds the plan the previous one recorded.
 */
export declare const registration: <R>(mark: (label: string) => Effect.Effect<string, never, R>) => Layer.Layer<Action.Implementations | Action.Requirement<"probe/Mark">, never, import("@smthrs/flow/FlowRuntime").FlowRuntime | Exclude<Exclude<Exclude<R, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, Action.Implementations>, Action.Implementations>>;
/** The step a deployed host runs: one `probe.mark` log line carrying the label, which names a step, never content. */
export declare const logged: (label: string) => Effect.Effect<string, never, never>;
