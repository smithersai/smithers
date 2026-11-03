/**
 * Serializable completion and suspension states returned by flow executions.
 *
 * @since 0.1.0
 */
import { CapabilityPattern } from "@smthrs/capability/Capability";
import type * as Exit from "effect/Exit";
import type { ExitEncoded } from "effect/rpc/RpcMessage";
import * as Schema from "effect/Schema";
import { InterpreterError } from "../internal/InterpreterError.vibe";
declare const ResultTypeId = "@smthrs/flow/Flow/Result";
/**
 * Returns `true` when a value is a flow `Result`.
 *
 * @category results
 * @since 0.1.0
 */
export declare const isResult: <A = unknown, E = unknown>(u: unknown) => u is Result<A, E>;
/**
 * Result of a flow execution: a completed exit, a suspended flow state, or a
 * handoff to the next round of a trampoline lineage.
 *
 * @category results
 * @since 0.1.0
 */
export type Result<A, E> = Complete<A, E> | Suspended | Handoff;
/**
 * Encoded representation of a flow `Result`.
 *
 * @category results
 * @since 0.1.0
 */
export type ResultEncoded<A, E> = CompleteEncoded<A, E> | typeof Suspended.Encoded | typeof Handoff.Encoded;
/**
 * Encoded representation of a completed flow result containing an encoded
 * `Exit`.
 *
 * @category results
 * @since 0.1.0
 */
export interface CompleteEncoded<A, E> {
    readonly _tag: "Complete";
    readonly exit: ExitEncoded<A, E>;
}
/**
 * Schema constructor for `Complete` flow results using the supplied
 * success and error schemas.
 *
 * @category schemas
 * @since 0.1.0
 */
export interface CompleteSchema<Success extends Schema.Constraint, Error extends Schema.Constraint> extends Schema.declareConstructor<Complete<Success["Type"], Error["Type"]>, Complete<Success["Encoded"], Error["Encoded"]>, readonly [Schema.Exit<Success, Error, Schema.Union<readonly [typeof InterpreterError, Schema.Defect]>>]> {
    readonly success: Success;
    readonly error: Error;
}
declare const Complete_base: new <A_1 extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A_1 as P extends "_tag" ? never : P]: A_1[P]; }>) => Readonly<A_1> & {
    readonly _tag: "Complete";
} & import("effect/Pipeable").Pipeable;
/**
 * Represents a completed flow execution with its success or failure `Exit`.
 *
 * Its schema keeps an `InterpreterError` defect whole, `code` included, so a
 * refused run reads the same from a stored result as from a live one.
 *
 * @category results
 * @since 0.1.0
 */
export declare class Complete<A, E> extends Complete_base<{
    readonly exit: Exit.Exit<A, E>;
}> {
    /**
     * Marks this value as a flow result for runtime guards.
     *
     * @since 0.1.0
     */
    readonly [ResultTypeId] = "@smthrs/flow/Flow/Result";
    /**
     * Builds the schema for completed flow results from success and error schemas.
     *
     * @since 0.1.0
     */
    static Schema<Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly success: Success;
        readonly error: Error;
    }): CompleteSchema<Success, Error>;
}
declare const Suspended_base: Schema.Class<Suspended, Schema.Struct<{
    readonly _tag: Schema.tag<"Suspended">;
    readonly cause: Schema.optional<Schema.Cause<Schema.Never, Schema.Defect>>;
}>, {}>;
/**
 * Represents a suspended flow execution, optionally carrying the cause that
 * triggered suspension.
 *
 * @category results
 * @since 0.1.0
 */
export declare class Suspended extends Suspended_base {
    /**
     * Marks this value as a flow result for runtime guards.
     *
     * @since 0.1.0
     */
    readonly [ResultTypeId] = "@smthrs/flow/Flow/Result";
}
/**
 * The deadline a trampoline lineage's rounds share: the journaled first start
 * of its originating round and the bound in milliseconds, so every round
 * expires at `startedAtMs + deadlineMs`.
 *
 * @category results
 * @since 1.0.0
 */
export declare const LineageDeadline: Schema.Struct<{
    readonly startedAtMs: Schema.Number;
    readonly deadlineMs: Schema.Number;
}>;
/**
 * The deadline a trampoline lineage's rounds share.
 *
 * @category results
 * @since 1.0.0
 */
export type LineageDeadline = typeof LineageDeadline.Type;
declare const Handoff_base: Schema.Class<Handoff, Schema.Struct<{
    readonly _tag: Schema.tag<"Handoff">;
    readonly flow: Schema.NonEmptyString;
    readonly capabilityCeilings: Schema.optionalKey<Schema.$Array<Schema.$Array<typeof CapabilityPattern>>>;
    readonly payload: Schema.Unknown;
    /**
     * The lineage deadline the next round runs under, stamped by the round
     * that handed off when its lineage is bounded (`Deadline.bound`).
     */
    readonly deadline: Schema.optionalKey<Schema.Struct<{
        readonly startedAtMs: Schema.Number;
        readonly deadlineMs: Schema.Number;
    }>>;
}>, {}>;
/**
 * Represents a flow round that ended by handing off to the next round of its
 * trampoline lineage.
 *
 * A round settles this way when its body's root value is a `to` invocation
 * (`docs/concepts/trampoline-rounds.md`): the round produced no answer of
 * its own, it produced the NEXT flow to run. `flow` is the target's tag, so the
 * value survives the journal and the run row unchanged.
 *
 * DECIDED: `payload` is the target's payload in
 * ENCODED form. The target's `to` method accepts its ordinary constructor
 * shape so authoring stays aligned with `call` and `execute`; the body
 * interpreter resolves planned references and encodes the invocation through
 * the target declaration before constructing `Handoff`. The receiving round
 * decodes those bytes through the same schema.
 *
 * It is a third settlement rather than a `Complete` carrying a magic value
 * because the engine has to tell "this run answered" from "this run continues
 * elsewhere" without decoding against a success schema the handoff never
 * satisfies.
 *
 * @category results
 * @since 0.1.0
 */
export declare class Handoff extends Handoff_base {
    /**
     * Marks this value as a flow result for runtime guards.
     *
     * @since 0.1.0
     */
    readonly [ResultTypeId] = "@smthrs/flow/Flow/Result";
}
/**
 * Creates a schema for flow results using the supplied success and error
 * schemas.
 *
 * @category results
 * @since 0.1.0
 */
export declare const Result: <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
    readonly success: Success;
    readonly error: Error;
}) => Schema.Union<readonly [CompleteSchema<Success, Error>, typeof Suspended, typeof Handoff]>;
/**
 * Schema for encoded flow results with generic success and error payloads.
 *
 * @category results
 * @since 0.1.0
 */
export declare const ResultEncoded: Schema.Codec<Schema.Json>;
export {};
