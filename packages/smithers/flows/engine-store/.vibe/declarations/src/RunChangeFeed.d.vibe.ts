/**
 * Coalesced execution catch-up with permanent deletion evidence.
 *
 * @since 1.0.0
 */
import { RunStoreError } from "@smthrs/run-store/RunStore";
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Position } from "../../../src/ExecutionSnapshot.ts";
/**
 * A live-row change or retained tombstone.
 *
 * @category models
 * @since 1.0.0
 */
export interface Change extends Position {
    readonly runId: string;
    readonly deleted: boolean;
}
/**
 * One catch-up page at an engine watermark.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page extends Position {
    readonly changes: ReadonlyArray<Change>;
    /** Resume here, including across gaps from coalesced changes. */
    readonly nextRevision: number;
    readonly hasMore: boolean;
}
/**
 * Bounded state-feed operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
    readonly current: Effect.Effect<Position, RunStoreError>;
    readonly changesSince: (options: Position & {
        readonly limit: number;
    }) => Effect.Effect<Page, RunStoreError>;
}
declare const RunChangeFeed_base: Context.ServiceClass<RunChangeFeed, "@smthrs/engine-store/RunChangeFeed", Service>;
/**
 * Durable change-feed service.
 *
 * @category services
 * @since 1.0.0
 */
export declare class RunChangeFeed extends RunChangeFeed_base {
}
/**
 * Maximum change-feed page size.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumPageSize = 1000;
/**
 * Constructs the feed without polling or retention timers.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: () => Effect.Effect<Service, never, SqlClient.SqlClient>;
/**
 * Provides the SQL feed.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layer: Layer.Layer<RunChangeFeed, never, SqlClient.SqlClient>;
export {};
