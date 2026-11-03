/**
 * Flow-valued slots and authority-narrowing decorators.
 *
 * A slot is a schema-constrained hole a caller fills with a flow; a decorator
 * wraps one flow in another and re-declares the result under the wrapped
 * flow's schemas and authority ceiling. Both read a `@smthrs/flow` declaration
 * through `internal/Decorate.ts`, which is where the capability ceiling and the
 * effect envelope are read off the annotation bag `Graph.build` consults.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Schema from "effect/Schema";
/**
 * The sole value accepted from an approval step.
 *
 * A denial cannot decode as this schema and therefore fails on the typed
 * schema-error channel before the inner flow starts.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Approved: Schema.Literal<"approved">;
/**
 * An accepted approval decision.
 *
 * @category models
 * @since 0.1.0
 */
export type Approved = typeof Approved.Type;
/**
 * A schema-constrained hole which may provide a default flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface Slot<I extends Schema.Top, O extends Schema.Top> {
    readonly input: I;
    readonly output: O;
    readonly default?: Flow.Any | undefined;
}
/**
 * Declares a flow-valued slot.
 *
 * Defaults are checked immediately so an invalid declaration cannot enter a
 * plan. The returned slot is a frozen copy of the options, so a later edit to
 * the caller's object does not reach {@link bind}.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const slot: <I extends Schema.Top, O extends Schema.Top>(options: Slot<I, O>) => Slot<I, O>;
/**
 * Resolves a slot to a supplied flow or its default.
 *
 * The failure is raised during pure plan construction, so a declaration that
 * does not fit its slot never reaches a graph.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const bind: <I extends Schema.Top, O extends Schema.Top>(declaration: Slot<I, O>, supplied?: Flow.Any | undefined) => Flow.Any;
/**
 * A transformation which wraps one flow with another flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Decorator = (inner: Flow.Any) => Flow.Any;
/**
 * The portions of a supplied decorator declaration removed by its template
 * envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface Clipped {
    readonly capabilities: ReadonlyArray<string>;
    readonly reads: ReadonlyArray<string>;
    readonly writes: ReadonlyArray<string>;
    readonly mode: boolean;
    readonly tier: boolean;
}
/**
 * Reports authority declared by `supplied` but excluded by `template`.
 *
 * @category introspection
 * @since 0.1.0
 */
export declare const clipped: (template: Flow.Any, supplied: Flow.Any) => Clipped;
/**
 * Applies a decorator and re-declares the result under the wrapped flow's
 * schema and authority ceiling.
 * An incompatible payload, success, or error schema fails `invalid_decorator`.
 *
 * The returned name derives from the decorator result (or the decorator
 * function name), and the extra flow call makes the decorator chain part of
 * declaration identity.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const decorate: {
    (decorator: Decorator): (self: Flow.Any) => Flow.Any;
    (self: Flow.Any, decorator: Decorator): Flow.Any;
};
/**
 * Applies decorators from left to right, so the final decorator is outermost.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const decorateAll: (flow: Flow.Any, decorators: ReadonlyArray<Decorator>) => Flow.Any;
