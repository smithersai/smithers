/**
 * The steering port: messages from outside the chain, drained at link
 * boundaries into author-call context.
 *
 * The port is shaped so the notifications package's durable queue slots
 * in as the production binding when the engine mounts; the in-memory
 * layer is the stand-in. Chains that provide no steering service run
 * unchanged and journal identically — the chain looks the service up
 * optionally (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Schema } from "effect";
declare const SteeringError_base: Schema.Class<SteeringError, Schema.TaggedStruct<"/chain/SteeringError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"steering_unavailable">>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A steering queue that cannot be admitted to or drained.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class SteeringError extends SteeringError_base {
}
/**
 * The two operations the chain needs: admit a message from outside, and
 * drain the queue at a named link boundary.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
    readonly admit: (message: string) => Effect.Effect<void, SteeringError>;
    /**
     * Takes every queued message. The boundary names the journal position
     * the drain feeds (`link/ordinal`, or `chain/link/ordinal` for a named
     * root), so a durable binding can make the take exactly-once by deduping
     * on it; the in-memory binding ignores it
     * and accepts the volatile loss window that implies.
     */
    readonly drain: (boundary: string) => Effect.Effect<ReadonlyArray<string>, SteeringError>;
}
declare const Steering_base: Context.ServiceClass<Steering, "/chain/Steering", Service>;
/**
 * The steering service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export declare class Steering extends Steering_base {
}
/**
 * Builds a steering port from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (implementation: Service) => Service;
/**
 * A steering port whose every operation fails as unavailable, with
 * per-operation overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const makeNoop: (overrides?: Partial<Service>) => Service;
/**
 * The unavailable steering port as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<Steering>;
/**
 * An in-memory steering queue: `admit` appends, `drain` takes everything.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerMemory: (initial?: ReadonlyArray<string>) => Layer.Layer<Steering>;
export {};
