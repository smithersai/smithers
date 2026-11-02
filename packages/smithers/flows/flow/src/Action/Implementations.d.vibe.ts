/**
 * The table a driver resolves a declared action's implementation through.
 *
 * `docs/concepts/flows-and-actions.md` splits an Action in two: a
 * declaration that is pure data and travels everywhere, and an implementation
 * attached separately as a layer, on the hosts that can run it. A body names
 * the declaration — `Increment.call({ path })` records a node and executes
 * nothing — so whatever later drives that node has to find the implementation
 * by name, from context, at execution time. That is this service: `toLayer`
 * files the implementation here when the table is present, and a driver asks
 * for it by the tag the node carries.
 *
 * "When the table is present" means present while the implementation layer
 * ITSELF is built, so ONE table goes under the implementations AND under
 * whatever drives them:
 *
 * ```ts
 * Layer.mergeAll(Read.toLayer(read), Write.toLayer(write), Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * Filing is a build-time effect, not a declared output, so the type checker
 * cannot catch a composition that builds one table for the implementations and
 * a second for the driver. That composition files into the first and reads the
 * second, and the driver refuses the call at run time naming the action.
 *
 * The table is deliberately not part of `FlowRuntime`. The runtime port is what
 * a flow, an action, or a durable wait is EXECUTED against, and an
 * implementation table is not an execution capability: it is authoring data,
 * assembled by the same layers that assemble the declarations, and every
 * runtime implementation can serve one identically.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import type { FlowInstance } from "../FlowRuntime/FlowInstance.ts";
import type { FlowRuntime } from "../FlowRuntime/FlowRuntime.ts";
/**
 * One declared action's implementation, as a driver consumes it: a name to
 * resolve it by, and the durable action a payload produces.
 *
 * `action` returns the same `Action.make` value `toLayer` registers with
 * the runtime, so a node driven through it takes the ordinary action path —
 * invocation key, attempt journal, tier, retry policy — rather than a second
 * execution mechanism that would have to keep up with the first.
 *
 * @category models
 * @since 0.1.0
 */
export interface Implementation {
    readonly name: string;
    /** Semantic version attested by the implementation registration. */
    readonly implementationVersion?: string | undefined;
    readonly action: (payload: unknown) => Effect.Effect<unknown, unknown, Crypto.Crypto | FlowRuntime | FlowInstance>;
}
declare const Implementations_base: Context.ServiceClass<Implementations, "@smthrs/flow/Action/Implementations", {
    /**
     * Files an implementation under its action tag for the lifetime of the
     * registering scope. A conflicting registration dies unless `override: true` explicitly replaces the
     * earlier one, and closing the registering scope exposes the newest
     * registration whose scope is still open. Which of two merged layers is later is not a guarantee Effect
     * makes, so a substitution replaces the implementation layer in the
     * composition rather than stacking a second one on top of it — and a
     * NESTED provision that reaches this same table through layer
     * memoization shadows the enclosing entry only while it lives, instead
     * of leaking its replacement into the enclosing composition.
     */
    readonly add: (implementation: Implementation, options?: {
        readonly override?: boolean;
    }) => Effect.Effect<void, never, Scope>;
    /**
     * The implementation registered for an action tag, if a layer supplied
     * one.
     */
    readonly get: (name: string) => Effect.Effect<Option.Option<Implementation>>;
}>;
/**
 * Service holding the declared action implementations a composition wired
 * up, keyed by action tag.
 *
 * **When to use**
 *
 * Use when driving a flow body, whose action calls name declarations rather
 * than carry code. A composition that only drives behavior registered directly
 * with the runtime never needs it, which is why `Action.toLayer` files an
 * implementation here when the service is present and skips it otherwise.
 *
 * @category services
 * @since 0.1.0
 */
export declare class Implementations extends Implementations_base {
}
/**
 * Layer providing an implementation table scoped to the composition that
 * builds it.
 *
 * The table is mutable and lives for the layer's lifetime, exactly like the
 * flow registry a runtime keeps: registration happens while layers are built,
 * and every lookup happens later, when a run drives a node. Because filing is
 * a build-time effect, provide this UNDER the implementation layers — see the
 * wiring at the top of this module — rather than merging it beside them.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerImplementations: Layer.Layer<Implementations>;
export {};
