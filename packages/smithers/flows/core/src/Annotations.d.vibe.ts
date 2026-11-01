/**
 * Typed immutable annotations attached to flow graph values.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */
import * as PlanEffects from "@smthrs/plan/Effects";
import { Context, type Option } from "effect";
/**
 * The empty annotation bag.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export declare const empty: Context.Context<never>;
/**
 * Adds or replaces one annotation without changing the original context.
 *
 * @category adders
 * @since 0.0.0
 * @slop
 */
export declare const add: {
    <I, S>(key: Context.Key<I, S>, service: import("effect/Types").NoInfer<S>): <Services>(self: Context.Context<Services>) => Context.Context<Services | I>;
    <Services, I, S>(self: Context.Context<Services>, key: Context.Key<I, S>, service: import("effect/Types").NoInfer<S>): Context.Context<Services | I>;
};
/**
 * Merges parent and child annotation bags. Child values override parent values
 * for matching keys.
 *
 * @category combining
 * @since 0.0.0
 * @slop
 */
export declare const merge: (parent: Context.Context<never>, child: Context.Context<never>) => Context.Context<never>;
/**
 * Safely retrieves an annotation. An absent service key returns `Option.none()`;
 * a `Context.Reference` key supplies its declared default.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export declare const getOption: <I, S>(context: Context.Context<never>, key: Context.Key<I, S>) => Option.Option<S>;
/**
 * Annotation key for a node's placement directive.
 *
 * This is `@smthrs/plan`'s `Placement.Annotation`, the ONE key, which
 * `@smthrs/flow` also publishes as `Flow.Placement`. While the two packages
 * each declared a key with its own value type, crossing between them cost a
 * cast in `@smthrs/registry`.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export declare const Placement: Context.Service<{
    readonly _tag: "flows/core/Placement/Client";
} | {
    readonly _tag: "flows/core/Placement/Local";
} | {
    readonly _tag: "flows/core/Placement/Remote";
    readonly image?: string | undefined;
    readonly profile?: string | undefined;
    readonly target?: string | undefined;
} | {
    readonly _tag: "flows/core/Placement/Sandbox";
    readonly image?: string | undefined;
    readonly profile?: string | undefined;
    readonly target?: string | undefined;
}, {
    readonly _tag: "flows/core/Placement/Client";
} | {
    readonly _tag: "flows/core/Placement/Local";
} | {
    readonly _tag: "flows/core/Placement/Remote";
    readonly image?: string | undefined;
    readonly profile?: string | undefined;
    readonly target?: string | undefined;
} | {
    readonly _tag: "flows/core/Placement/Sandbox";
    readonly image?: string | undefined;
    readonly profile?: string | undefined;
    readonly target?: string | undefined;
}>;
/**
 * Annotation key for a flow or node effect declaration.
 *
 * This is `@smthrs/plan`'s `Effects.Envelope`, the ONE key, which
 * `@smthrs/flow` also publishes as `Flow.EffectEnvelope`. While the two
 * packages each declared their own key a flow annotated for one graph builder
 * was invisible to the other.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export declare const Effects: Context.Service<PlanEffects.Declaration, PlanEffects.Declaration>;
/**
 * Annotation key for a node's scheduling priority.
 *
 * The value is a signed integer that orders ready work: a scheduler runs a
 * higher number before a lower one. Priority is a scheduling hint, never part
 * of step identity, so raising it never invalidates a cached step.
 *
 * @category annotations
 * @since 0.1.0
 * @slop
 */
export declare const Priority: Context.Service<number, number>;
