/**
 * Immutable registry for effect-specific compensation handlers.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Assessment, Classification, type Handler } from "../CompensationHandlers.vibe";
import { EffectRecord } from "../EffectBoundary.ts";
import { type TimeTravelError } from "../TimeTravelError.vibe";
export { 
/**
 * The public preflight schemas, re-exported for the machinery that consumes
 * them. `CompensationHandlers` owns them because a handler author writes
 * against them.
 *
 * @since 0.1.0
 * @category models
 */
Assessment, Classification, 
/**
 * The handler shape, re-exported for the same reason. There is ONE handler
 * type: the registry validates and resolves exactly what a contributor
 * wrote, so a second shape here could only drift from it.
 *
 * @since 0.1.0
 * @category models
 */
type Handler };
/**
 * Durable evidence produced after one handler reverses an effect.
 *
 * The receipt contains everything the same handler needs to reverse its
 * compensation during rewind rollback or startup recovery.
 *
 * @since 0.1.0
 * @category models
 */
export declare const RollbackReceipt: Schema.Struct<{
    readonly id: Schema.NonEmptyString;
    readonly effect: Schema.Struct<{
        readonly id: Schema.NonEmptyString;
        readonly kind: Schema.NonEmptyString;
        readonly tier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
        readonly runId: Schema.NonEmptyString;
        readonly lineageId: Schema.NonEmptyString;
        readonly input: Schema.optionalKey<Schema.Unknown>;
        readonly cacheKey: Schema.optionalKey<Schema.NonEmptyString>;
        readonly changeId: Schema.optionalKey<Schema.NonEmptyString>;
        readonly idempotencyKey: Schema.optionalKey<Schema.NonEmptyString>;
        readonly compensation: Schema.optionalKey<Schema.NonEmptyString>;
        readonly residue: Schema.optionalKey<Schema.String>;
        readonly attempt: Schema.optionalKey<Schema.Int>;
        readonly nonce: Schema.optionalKey<Schema.NonEmptyString>;
        readonly status: Schema.Literals<readonly ["intended", "succeeded", "unknown"]>;
        readonly seq: Schema.Int;
        readonly output: Schema.optionalKey<Schema.Unknown>;
        readonly durableBoundary: Schema.Boolean;
        readonly providerStream: Schema.Boolean;
    }>;
    readonly data: Schema.Unknown;
}>;
/**
 * The value form of {@link RollbackReceipt}.
 *
 * @since 0.1.0
 * @category models
 */
export type RollbackReceipt = typeof RollbackReceipt.Type;
/**
 * Immutable effect-handler lookup and execution operations.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
    readonly resolve: (kind: string) => Handler | undefined;
    readonly assess: (effect: EffectRecord) => Effect.Effect<Assessment, TimeTravelError>;
    readonly revert: (effect: EffectRecord) => Effect.Effect<RollbackReceipt, TimeTravelError>;
    readonly rollback: (receipt: RollbackReceipt) => Effect.Effect<void, TimeTravelError>;
}
declare const EffectHandlerRegistry_base: Context.ServiceClass<EffectHandlerRegistry, "@smthrs/time-travel/EffectHandlerRegistry", Service>;
/**
 * Layer-provided immutable effect-handler registry.
 *
 * @since 0.1.0
 * @category services
 */
export declare class EffectHandlerRegistry extends EffectHandlerRegistry_base {
}
/**
 * Constructs an immutable registry, validating every declaration and
 * rejecting duplicate effect kinds before exposing it.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const make: (handlers?: Iterable<Handler>) => Effect.Effect<Service, TimeTravelError>;
/**
 * Constructs an empty immutable registry.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const makeNoop: () => Service;
/**
 * Provides an immutable registry after validating all registrations.
 *
 * @since 0.1.0
 * @category layers
 */
export declare const layer: (handlers?: Iterable<Handler>) => Layer.Layer<EffectHandlerRegistry, TimeTravelError>;
/**
 * Provides an empty immutable registry.
 *
 * @since 0.1.0
 * @category layers
 */
export declare const layerNoop: Layer.Layer<EffectHandlerRegistry>;
