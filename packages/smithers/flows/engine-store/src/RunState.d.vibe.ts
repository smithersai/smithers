/**
 * The envelope a durable run's state is persisted inside.
 *
 * The engine never stores a flow's payload bare — it wraps it in a versioned
 * struct, so a store row written by an older build decodes under a known
 * shape instead of being guessed at. `version` is a literal rather than a
 * number for exactly that reason: a future revision adds a new literal and
 * both remain decodable.
 *
 * Time travel reads these rows too, deriving the state AT a frame by
 * replaying run-decision records rather than trusting the row's latest value.
 *
 * @since 0.1.0
 */
import { CapabilityPattern } from "@smthrs/capability/Capability";
import * as Schema from "effect/Schema";
/**
 * What a linked child does when the run that spawned it ends.
 *
 * `cancel` is the default and the shape a `.child()` boundary takes: the
 * parent is waiting on this child, so a parent that stops waiting — because it
 * completed, failed, or was cancelled — leaves nothing behind. `detach` is the
 * shape a fire-and-forget spawn takes: the parent deliberately did not wait,
 * so the child outlives it and keeps its own claim and its own journal.
 *
 * The policy is recorded on the CHILD rather than on the edge because it is a
 * property of how the child was started, and because a child with two parents
 * (the diamond `flows_run_parents` permits) must answer the question once.
 *
 * @since 0.1.0
 * @category schemas
 */
export declare const OnParentExit: Schema.Literals<readonly ["cancel", "detach"]>;
/**
 * The value form of {@link OnParentExit}.
 *
 * @since 0.1.0
 * @category models
 */
export type OnParentExit = typeof OnParentExit.Type;
/**
 * The versioned state stored for a durable flow run: which flow it is, the
 * encoded `payload` it was started with, and — as they arrive — its
 * `result` and its cancellation timestamp.
 *
 * `parentExecutionId` is present only on a child run, and is what makes a
 * spawned subflow reachable from the run that spawned it. `onParentExit`
 * travels with it: it is what the parent's terminal transition reads to decide
 * whether this child ends with it.
 *
 * @since 0.1.0
 * @category schemas
 */
export declare const RunState: Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly flowName: Schema.NonEmptyString;
    readonly payload: Schema.Unknown;
    readonly capabilityCeilings: Schema.optionalKey<Schema.$Array<Schema.$Array<typeof CapabilityPattern>>>;
    readonly forkKeyRunIds: Schema.optionalKey<Schema.$Array<Schema.NonEmptyString>>;
    readonly retryFrom: Schema.optionalKey<Schema.Struct<{
        readonly source: Schema.NonEmptyString;
        readonly step: Schema.optionalKey<Schema.NonEmptyString>;
        readonly boundaries: Schema.$Array<Schema.NonEmptyString>;
    }>>;
    readonly parentExecutionId: Schema.optionalKey<Schema.NonEmptyString>;
    readonly onParentExit: Schema.optionalKey<Schema.Literals<readonly ["cancel", "detach"]>>;
    readonly maxRounds: Schema.optionalKey<Schema.Int>;
    readonly deadline: Schema.optionalKey<Schema.Struct<{
        readonly startedAtMs: Schema.Number;
        readonly deadlineMs: Schema.Number;
    }>>;
    readonly result: Schema.optionalKey<Schema.Unknown>;
    readonly cancellation: Schema.optionalKey<Schema.Struct<{
        readonly interruptedAtMs: Schema.Number;
        readonly run: Schema.optionalKey<Schema.NonEmptyString>;
    }>>;
    readonly origin: Schema.optionalKey<Schema.Struct<{
        readonly door: Schema.String;
        readonly actor: Schema.String;
        readonly admittedAtMs: Schema.Number;
    }>>;
    readonly parked: Schema.optionalKey<Schema.Struct<{
        readonly atMs: Schema.Number;
        readonly kind: Schema.String;
    }>>;
}>;
/**
 * The value form of {@link RunState}.
 *
 * @since 0.1.0
 * @category models
 */
export type RunState = typeof RunState.Type;
/**
 * Why a driver released a run it still owned, recorded on its
 * `interrupt-released` run decision.
 *
 * `lease-lapsed` means the host went `unconfirmedMs` without confirming its
 * run lease (a stalled or overloaded host), so the heartbeat loop stopped the
 * run's work before a peer could take it. `yielded` means a hosted drive
 * spent its budget (`EngineStore.drive`'s `budgetMs`) and released the run
 * at a step boundary for its host to drive again at once. `interrupted` is
 * any other interruption that was not a cancellation, usually a host
 * shutdown.
 *
 * Decisions written before this field existed carry no cause; read them with
 * {@link releaseCauseOf}, which answers `undefined` for them.
 *
 * @since 1.0.0
 * @category schemas
 */
export declare const ReleaseCause: Schema.Union<readonly [Schema.Struct<{
    readonly kind: Schema.Literal<"lease-lapsed">;
    readonly unconfirmedMs: Schema.Int;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"yielded">;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"interrupted">;
}>]>;
/**
 * The value form of {@link ReleaseCause}.
 *
 * @since 1.0.0
 * @category models
 */
export type ReleaseCause = typeof ReleaseCause.Type;
/**
 * The release cause a run decision payload records, or `undefined` for a
 * decision that is not `interrupt-released`, one written before causes were
 * recorded, or one whose cause does not decode.
 *
 * @since 1.0.0
 * @category decoding
 */
export declare const releaseCauseOf: (decision: unknown) => ReleaseCause | undefined;
