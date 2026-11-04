/**
 * Read port from the control plane into a trigger store.
 *
 * `Control.list` answers `{ _tag: "triggers" }` and `{ _tag: "fires" }` through
 * this port. The port lives here rather than in `@smthrs/triggers` because that
 * package already depends on this one (its scheduler launches runs through
 * `Control`), so the adapter over a real `TriggerStore` is composed by the host
 * and the plane only ever sees the interface.
 *
 * A composition that provides no reader, or provides {@link layerNone}, makes
 * `Control.list` refuse the two variants with a typed `InvalidInput` naming the
 * gap. It never answers an empty page: an empty page means "this host has no
 * triggers", and a host that cannot read its store has no grounds to say so.
 *
 * @since 1.0.0
 */
import { Context, Effect, Layer } from "effect";
import type { ControlError } from "../../../src/ControlError.ts";
import { InvalidInput } from "../../../src/ControlError.ts";
import type { FireSummary, ListRequest, TriggerSummary } from "../../../src/ControlSchema.ts";
/**
 * The `triggers` listing request as the port receives it.
 *
 * @category models
 * @since 1.0.0
 */
export type TriggersRequest = Extract<ListRequest, {
    readonly _tag: "triggers";
}>;
/**
 * The `fires` listing request as the port receives it.
 *
 * @category models
 * @since 1.0.0
 */
export type FiresRequest = Extract<ListRequest, {
    readonly _tag: "fires";
}>;
/**
 * The reader `Control.list` pages trigger and fire rows from.
 *
 * Each method receives the whole request and answers every row it has for it,
 * newest fire first. A reader may narrow by the request's `filters` (a SQL
 * adapter pushes them into the query); `Control.list` applies the same filters
 * again and pages the rows with `cursor` and `limit`, so a reader that returns
 * every row is still correct. Paging stays in the plane so both variants page
 * exactly as `flows` and `runs` do.
 *
 * @category services
 * @since 1.0.0
 */
export interface Service {
    readonly list: (request: TriggersRequest) => Effect.Effect<ReadonlyArray<TriggerSummary>, ControlError>;
    readonly fires: (request: FiresRequest) => Effect.Effect<ReadonlyArray<FireSummary>, ControlError>;
}
declare const DispatchReader_base: Context.ServiceClass<DispatchReader, "/control/DispatchReader", Service>;
/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 1.0.0
 */
export declare class DispatchReader extends DispatchReader_base {
}
/**
 * The refusal a host without a trigger store answers both variants with.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const noStoreIssue = "this host serves no trigger store";
/**
 * The typed refusal for a host without a trigger store: `InvalidInput` with
 * code `invalid_input` and {@link noStoreIssue} as the issue, the same shape
 * `Control.list` refuses an unsupported run filter with.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const refuse: () => InvalidInput;
/**
 * Builds a {@link Service} from an implementation of its methods.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (implementation: Service) => Service;
/**
 * A {@link Service} that serves no trigger store: both methods fail with
 * {@link refuse}.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeNone: () => Service;
/**
 * Provides {@link DispatchReader} from an implementation.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layer: (implementation: Service) => Layer.Layer<DispatchReader>;
/**
 * Provides {@link makeNone}: a reader that refuses both listings because this
 * host serves no trigger store.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerNone: Layer.Layer<DispatchReader>;
export {};
