/**
 * Polling as a durable lineage: one attempt per round, a durable wait between
 * attempts, and a bound the lineage settles on.
 *
 * Smithers 0.x had a `Poller` component — a check, an interval, a backoff, an
 * attempt bound, and what to do at that bound. The pieces it was built from
 * already exist here: {@link module:Sleep.action} is the durable wait, and
 * `Flow.to` opens the next round. What was missing is the shape that puts them
 * together, and that is this module.
 *
 * A poll is a flow whose body is ONE attempt. It runs the check, and branches:
 * a satisfied check settles the lineage with the check's own output, an
 * unsatisfied one sleeps for this attempt's delay and hands off to the next
 * round with the attempt counter raised. The last attempt has no sleep and no
 * handoff — it either answers with the output it just read (`return-last`) or
 * fails {@link PollExhausted} (`fail`).
 *
 * Everything durable about it is durable for the ordinary reason. Each attempt
 * is a round with its own keyed plan nodes, so a check that already ran replays
 * from its recorded outcome instead of running again; the wait between attempts
 * is a durable timer, so a process that dies during it resumes on the round it
 * left rather than starting the poll over; and the attempt counter travels in
 * the payload, so nothing about "which attempt is this" lives in memory.
 *
 * The bound is stated twice on purpose. The body ends the lineage on the last
 * attempt, and `maxAttempts` is also the flow's `maxRounds` budget, so a
 * lineage that somehow opened another round is refused by the engine rather
 * than polling forever.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import * as Node from "@smthrs/plan/Node";
import type * as Repetition from "@smthrs/plan/Repetition";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Action from "../../../src/Action/index.ts";
import * as Flow from "../../../src/Flow/index.ts";
import type { FlowRuntime } from "./FlowRuntime/FlowRuntime.vibe";
import * as Sleep from "./Sleep.vibe";
/**
 * How the wait between attempts grows.
 *
 * `fixed` waits the interval every time, `linear` waits the interval times the
 * attempt, and `exponential` doubles the interval on every attempt.
 *
 * @category models
 * @since 0.1.0
 */
export type Backoff = "fixed" | "linear" | "exponential";
/**
 * What a check reports: whether the poll is over, and the value this attempt
 * read.
 *
 * The output travels on every attempt, satisfied or not, because it is also
 * the answer a `return-last` poll settles with when it runs out of attempts.
 *
 * @category models
 * @since 0.1.0
 */
export interface Check<out Result> {
    readonly satisfied: boolean;
    readonly output: Result;
}
/**
 * The success schema a check action declares.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const CheckResult: <Result extends Schema.Top>(result: Result) => Schema.Struct<{
    readonly satisfied: typeof Schema.Boolean;
    readonly output: Result;
}>;
declare const PollExhausted_base: Schema.Class<PollExhausted, Schema.TaggedStruct<"@smthrs/flow/PollExhausted", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"poll_exhausted">>;
    readonly poll: Schema.String;
    readonly attempts: Schema.Number;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A poll that used its last attempt without a satisfied check.
 *
 * It is a typed failure rather than a defect: running out of attempts is an
 * expected outcome of polling something that may never become ready, so a
 * caller recovers from it through `Node.catch` like any other declared failure.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class PollExhausted extends PollExhausted_base {
}
/**
 * The tag the exhaustion step is catalogued and resolved under.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const exhaustedTag = "system/poll-exhausted";
/**
 * The declared step a poll takes when its last attempt was not satisfied.
 *
 * Running out of attempts is a step rather than a bare `Effect.fail` so the
 * exhaustion is in the plan and in the journal: the round that gave up shows
 * which poll gave up and after how many attempts, exactly like every other node
 * a body drove.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const exhausted: Action.Declared<typeof exhaustedTag, Schema.Struct<{
    readonly poll: typeof Schema.String;
    readonly attempts: typeof Schema.Number;
}>, typeof Schema.Never, typeof PollExhausted, never>;
/**
 * The wait before the attempt after this one, in milliseconds.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const delayMillis: (options: {
    readonly intervalMs: number;
    readonly backoff: Backoff;
    readonly attempt: number;
}) => number;
/**
 * What a poll round can fail with.
 *
 * {@link PollExhausted} is the poll's own failure. `SleepRequestInvalid` is the
 * wait node's, declared because the wait between attempts is an ordinary
 * {@link module:Sleep.action} node and its typed refusal is part of the
 * topology a poll carries. Its codes cover a payload that names no deadline,
 * names two deadlines, or names a value that is not a deadline. {@link make}
 * refuses invalid author schedules at construction. A caller-visible round
 * payload can still carry an invalid attempt that produces an invalid derived
 * wait, so `Sleep` refuses that wait before the round parks.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Failure: Schema.Union<readonly [typeof PollExhausted, typeof Sleep.SleepRequestInvalid]>;
/**
 * The payload schema {@link make} derives from an author's input fields: the
 * author's own fields, plus the attempt this round is.
 *
 * `attempt` is optional so a caller starts a poll with its own fields alone;
 * the first round reads it as one.
 *
 * @category models
 * @since 0.1.0
 */
export type PayloadSchema<Input extends Schema.Struct.Fields> = Schema.Struct<Input & {
    readonly attempt: Schema.optional<typeof Schema.Number>;
}>;
/**
 * Declares a durable poller.
 *
 * **When to use**
 *
 * Use it wherever a run has to keep asking until something is ready — a build
 * that finishes, a deployment that goes live, a review that lands — and the
 * waiting has to survive a restart. `check` is the one thing an author writes:
 * a body fragment that reads whatever it polls and reports a {@link Check}.
 * Everything else is schedule. Under stable callback admission (the default of
 * `Interpreter.layerWithImplementations`), wrap `check` in `Node.capture` with
 * every semantic capture, including a version for imported behavior. An
 * uncaptured check keeps the poll process-local. The helper captures its own
 * callbacks using the schedule and the check's identity.
 *
 * ```ts
 * const Deployment = Poll.make("deploy/wait", {
 *   input: { id: Schema.String },
 *   result: Schema.String,
 *   intervalMs: 5_000,
 *   backoff: "exponential",
 *   maxAttempts: 8,
 *   onTimeout: "fail",
 *   check: Node.capture(
 *     { action: Status.name, implementationVersion: "deploy/status-check/v1" },
 *     ({ attempt, id }) => Status.call({ attempt, id })
 *   )
 * })
 * ```
 *
 * The check may not fail. A check that can fail states what a failure means for
 * the poll — give up, or treat it as "not ready yet" — with `Node.catch` inside
 * the fragment, rather than leaving the poll to guess.
 *
 * A per-attempt time limit on the check itself is NOT a poll option. A plan
 * node's duration is not something the body around it can bound; that bound
 * belongs in the check's own implementation, where `DurableDeferred.raceAll`
 * races the work against a durable clock and stays replayable.
 *
 * A schedule no clock can be armed with is refused here, with a `RangeError`
 * naming the option that is wrong. `intervalMs` becomes the `millis` of a
 * {@link module:Sleep.action} node, and a wait of `Infinity`, `NaN`, or a
 * negative length arms a timer that never fires — a poll that hangs forever
 * with a plan that looks correct. The check is on the schedule, not only on the
 * interval: `{ intervalMs: 1000, maxAttempts: 2000, backoff: "exponential" }`
 * states three finite options and asks for an infinite wait, so the LAST wait
 * the poll can arm has to be a length too, and no longer than
 * `Number.MAX_SAFE_INTEGER` milliseconds, the latest deadline a durable timer
 * records. `maxAttempts` is the lineage's round
 * budget, and a budget below one attempt reaches `Flow.make` as a `maxRounds`
 * complaint about an option the author never wrote.
 *
 * @throws A `RangeError` when `intervalMs` is not a duration a clock accepts,
 * when `maxAttempts` is not a whole number of attempts of at least one, or when
 * the interval under the declared backoff reaches a wait no clock can be armed
 * with before the budget is spent.
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <const Tag extends string, Input extends Schema.Struct.Fields, Result extends Schema.Top, R = never>(tag: Tag, options: {
    readonly input: Input;
    readonly result: Result;
    readonly check: (payload: Schema.Struct.Type<Input> & {
        readonly attempt: number;
    }) => Node.Node<Check<Result["Type"]>, never, R>;
    readonly intervalMs: number;
    readonly maxAttempts: number;
    readonly backoff?: Backoff | undefined;
    readonly onTimeout?: Repetition.AtCeiling | undefined;
}) => Flow.Flow<Tag, PayloadSchema<Input>, Result, typeof Failure, R>;
/**
 * The exhaustion implementation, provided beside the other action layers a
 * poll's rounds call.
 *
 * ```ts
 * Layer.mergeAll(Poll.layer, Sleep.layer, Interpreter.layer(Deployment)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<never, never, Crypto.Crypto | FlowRuntime>;
export {};
