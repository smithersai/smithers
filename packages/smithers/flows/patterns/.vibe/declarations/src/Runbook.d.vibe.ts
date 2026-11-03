/**
 * Runbook pattern: an ordered list of steps where a step's risk decides
 * whether it is gated by an approval, and a denial either stops the runbook or
 * skips the step.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OpaqueInput } from "./internal/Payload.vibe";
import { PatternError } from "./PatternError.vibe";
/**
 * How much authority a step needs before it runs.
 *
 * A `safe` step runs unasked. A `risky` step needs an approval. A `critical`
 * step needs an approval too, and its request carries `elevated: true`.
 *
 * @category models
 * @since 0.1.0
 */
export type Risk = "safe" | "risky" | "critical";
/**
 * What a denial does to the rest of the runbook.
 *
 * `"skip"` is a {@link run} option only. {@link make} refuses it, because a
 * declared plan cannot express it.
 *
 * @category models
 * @since 0.1.0
 */
export type OnDeny = "fail" | "skip";
/**
 * One declared step.
 *
 * @category models
 * @since 0.1.0
 */
export interface Step {
    readonly id: string;
    readonly flow: Flow.Any;
    readonly risk: Risk;
}
/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly steps: ReadonlyArray<Step>;
    /**
     * Called with `{ input, reason, scope }`; its declared input must be that
     * struct or `Schema.Unknown`; `scope` is currently the string `"run"`.
     */
    readonly approval: Flow.Any;
    readonly onDeny: OnDeny;
    readonly reason?: string | undefined;
}
/**
 * What an approval sees before a gated step runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request<I, Out> {
    readonly step: string;
    readonly risk: Risk;
    readonly elevated: boolean;
    readonly input: I;
    readonly previous: Out | undefined;
}
/**
 * One step at runtime.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeStep<I, Out, E, R> {
    readonly id: string;
    readonly risk: Risk;
    readonly run: (args: Request<I, Out>) => Effect.Effect<Out, E, R>;
}
/**
 * Operational callbacks for {@link run}.
 *
 * `approve` must produce the literal `"approved"`; anything else is a denial
 * and fails the typed schema decode.
 *
 * `run` snapshots `steps`, each step's `id`, `risk`, and `run`, `approve`, and
 * `onDeny` at the call, so a later edit to the array, a step record, or the
 * option object does not alter that run.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Out, E, R, E2, R2> {
    readonly steps: ReadonlyArray<RuntimeStep<I, Out, E, R>>;
    readonly approve: (request: Request<I, Out>) => Effect.Effect<unknown, E2, R2>;
    readonly onDeny: OnDeny;
}
/**
 * What a runbook did.
 *
 * `ran` and `skipped` are disjoint and together name every step. `outputs`
 * holds one entry per step in `ran`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<Out> {
    readonly outputs: Record<string, Out>;
    readonly ran: ReadonlyArray<string>;
    readonly skipped: ReadonlyArray<string>;
}
/**
 * Reports whether a step's risk requires an approval.
 *
 * @category introspection
 * @since 0.1.0
 */
export declare const gated: (risk: Risk) => boolean;
/**
 * Reports whether a step's risk raises the approval request to elevated.
 *
 * @category introspection
 * @since 0.1.0
 */
export declare const elevated: (risk: Risk) => boolean;
/**
 * The declared form of a runbook.
 *
 * @category models
 * @since 0.1.0
 */
export type RunbookFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Builds the runbook topology: the steps chained in declaration order, with
 * an approval call before every non-safe step.
 *
 * Each step is called with `{ step, risk, elevated, input, previous }`, and the
 * approval that gates a step sees that same envelope. A gated step runs only
 * when its approval answers the literal `"approved"`; any other answer fails
 * the runbook with a `PatternError` (`invalid_input`) carrying the answer. The
 * approval sees the envelope, so a built graph shows
 * which step an approval belongs to and whether it is elevated. The flow
 * settles to the same {@link Result} {@link run} returns, with every step in
 * `ran` and none in `skipped`.
 *
 * `onDeny: "skip"` is not declarable, and `make` refuses it rather than
 * accepting it and building a plan that halts. A skip is a decision about a
 * value the plan does not have: the gated node is one flow whose failure
 * channel carries the denial and the step's own failures together, so the
 * recovery arm that would express a skip also declares that the runbook
 * continues past a FAILED critical step, which no run does. Declaring the
 * runbook with `onDeny: "fail"` and calling {@link run} with `onDeny: "skip"`
 * is how a skipping runbook is expressed today.
 *
 * `make` throws a `PatternError` when there are no steps, when two steps share
 * an id, when the approval flow permits any value other than the literal
 * `"approved"`, or when `onDeny` is `"skip"`.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions) => RunbookFlow<R>;
/**
 * Runs a runbook.
 *
 * A safe step runs without asking. A non-safe step asks `approve` first, and
 * the answer must decode as the literal `"approved"`. Under `onDeny: "fail"` a
 * denial fails the runbook on the typed schema-error channel and no later step
 * runs. Under `onDeny: "skip"` the denied step is listed in `skipped`, the
 * runbook continues, and the next step sees the last step that actually ran as
 * its `previous`.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, Out, E = never, R = never, E2 = never, R2 = never>(input: I, options: RuntimeOptions<I, Out, E, R, E2, R2>) => Effect.Effect<Result<Out>, E | E2 | PatternError | Schema.SchemaError, R | R2>;
