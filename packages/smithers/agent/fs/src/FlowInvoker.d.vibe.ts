/**
 * The seam between a resolved route and whatever actually runs a flow.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect";
import type * as Flow from "@smthrs/core/Flow";
import { FsError } from "./FsError.vibe";
/**
 * One materialized invocation.
 *
 * @category models
 * @since 0.1.0
 */
export interface Invocation {
    name: string;
    flow: Pick<Flow.Any, "name" | "input" | "output"> & Partial<Pick<Flow.Any, "description">>;
    input: unknown;
}
type FlowInvoker_shape = {
    invoke(invocation: Invocation): Effect.Effect<unknown, FsError>;
};
declare const FlowInvoker_base: Context.ServiceClass<FlowInvoker, "@smthrs/fs/src/FlowInvoker#FlowInvoker", FlowInvoker_shape>;
/**
 * Executes a materialized flow.
 *
 * The projections in this package never execute a flow themselves: the harness
 * owns the run loop, permissions, and durability, so it supplies this service.
 *
 * @category services
 * @since 0.1.0
 */
export declare class FlowInvoker extends FlowInvoker_base {
}
export declare namespace FlowInvoker {
    type Shape = FlowInvoker_shape;
}
/**
 * Constructs a flow invoker from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export declare const make: (implementation: FlowInvoker.Shape) => FlowInvoker.Shape;
/**
 * Constructs an invoker that fails every invocation.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export declare const makeNoop: (overrides?: Partial<FlowInvoker.Shape>) => FlowInvoker.Shape;
/**
 * Provides an invoker that fails every invocation.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: (overrides?: Partial<FlowInvoker.Shape>) => Layer.Layer<FlowInvoker>;
export {};
