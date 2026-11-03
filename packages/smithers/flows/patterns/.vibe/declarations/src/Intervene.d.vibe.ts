/**
 * Intervene pattern: read a target, propose a change, apply it behind an
 * optional approval, and report what happened.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Member } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
/**
 * Configuration for {@link make}.
 *
 * `dryRun` removes the apply call from the declaration itself, so a dry-run
 * plan cannot reach a writing step. The optional `approval` flow must produce
 * the literal `"approved"` before apply runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly read: Member<R>;
    readonly propose: Member<R>;
    /**
     * The writing stage, called after the optional approval flow settles.
     */
    readonly apply: Flow.Any;
    readonly report: Member<R>;
    readonly dryRun: boolean;
    /**
     * Called with `{ input, reason, scope }`; its declared input must be that
     * struct or `Schema.Unknown`; `scope` is currently the string `"run"`.
     */
    readonly approval?: Flow.Any | undefined;
    readonly reason?: string | undefined;
}
/**
 * Operational callbacks for {@link run}.
 *
 * Each stage receives the same `phase` envelope as its declared flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5, R5> {
    readonly read: (args: {
        readonly phase: "read";
        readonly input: I;
    }) => Effect.Effect<Context, E, R>;
    readonly propose: (args: {
        readonly phase: "propose";
        readonly input: I;
        readonly context: Context;
    }) => Effect.Effect<Proposal, E2, R2>;
    readonly apply: (args: {
        readonly phase: "apply";
        readonly input: I;
        readonly proposal: Proposal;
    }) => Effect.Effect<Applied, E3, R3>;
    readonly report: (args: {
        readonly phase: "report";
        readonly input: I;
        readonly proposal: Proposal;
        readonly applied: Applied | undefined;
        readonly dryRun: boolean;
    }) => Effect.Effect<Report, E4, R4>;
    readonly dryRun: boolean;
    readonly approval?: ((args: {
        readonly input: I;
        readonly proposal: Proposal;
    }) => Effect.Effect<unknown, E5, R5>) | undefined;
}
/**
 * The declared form of an intervention.
 *
 * @category models
 * @since 0.1.0
 */
export type InterveneFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Builds the intervention topology: read, propose, then either report the
 * proposal alone (dry run) or apply it and report what was written.
 *
 * When `approval` is supplied, the built graph calls it ahead of apply and
 * runs apply only when it answers the literal `"approved"`. Any other answer
 * fails the flow with a `PatternError` (`invalid_input`) carrying the answer,
 * and apply never starts.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => InterveneFlow<R>;
/**
 * Runs an intervention.
 *
 * A dry run reports the proposal and never calls `apply`. Otherwise the
 * approval decision, when one is configured, must decode as the literal
 * `"approved"`; a denial fails on the typed schema-error channel and `apply`
 * never runs.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5 = never, R5 = never>(input: I, options: RuntimeOptions<I, Context, Proposal, Applied, Report, E, R, E2, R2, E3, R3, E4, R4, E5, R5>) => Effect.Effect<Report, E | E2 | E3 | E4 | E5 | Schema.SchemaError, R | R2 | R3 | R4 | R5>;
