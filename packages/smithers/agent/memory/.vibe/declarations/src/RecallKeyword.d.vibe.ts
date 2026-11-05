/**
 * Keyword recall with no host dependencies.
 *
 * Scores every authoritative row in each selected bank by the number of
 * normalized query terms occurring in its key and text, breaks ties by newest
 * update, then applies the shared Smithers-compatible byte cap. There is no
 * recency window: an old match ranks the same as a new one.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as MemoryError from "./MemoryError.vibe";
import * as MemoryStore from "../../../src/MemoryStore.ts";
import * as Recall from "./Recall.vibe";
/**
 * A row accepted from the store retrieval seam.
 *
 * @category models
 * @since 0.1.0
 */
export type Row = Pick<MemoryStore.SearchRow, "key" | "text" | "tags" | "status" | "updatedAtMs">;
/**
 * Splits a query into the normalized terms scoring compares against.
 *
 * @category models
 * @since 0.1.0
 */
export declare const normalizeQueryTerms: (value: string) => ReadonlyArray<string>;
/**
 * Scores one row by the number of normalized query terms occurring in its key
 * and text.
 *
 * @category models
 * @since 0.1.0
 */
export declare const scoreRow: (query: ReadonlyArray<string>, row: Row) => number;
/**
 * Runs keyword recall against the supplied MemoryStore.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const recall: (input: Recall.Input) => Effect.Effect<Recall.Output, MemoryError.MemoryError, MemoryStore.MemoryStore>;
/**
 * Provides keyword recall as the default replaceable recall slot.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<Recall.Recall, never, MemoryStore.MemoryStore>;
