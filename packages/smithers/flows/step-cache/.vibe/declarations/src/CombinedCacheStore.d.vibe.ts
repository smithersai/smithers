/**
 * Two step-result tiers composed into one: local first, remote second, with
 * write-back into the local SQL store.
 *
 * The shape is Bazel's `CombinedCache.downloadActionResult`, from
 * `src/main/java/com/google/devtools/build/lib/remote/CombinedCache.java` in
 * {@link https://github.com/bazelbuild/bazel | bazelbuild/bazel}: consult the
 * disk cache, fall back to the remote cache only on a miss, and write what the
 * remote returned back into the disk cache so the next lookup is local. An
 * exact local provenance record refused by age stops the lookup with a miss;
 * it never falls through to the shared head.
 *
 * **Publication order is the caller's job, not this store's.** A cache entry
 * must never be observable in the shared tier while an artifact it references
 * is missing from the shared artifact tier. That is Bazel's REAPI ordering
 * constraint, stated in that repository's `remote/UploadManifest.java` as
 * "action results may fail to validate server-side if they are accessed before
 * all blobs they refer to are present". `@smthrs/engine-store`'s
 * `ArtifactSync` enforces it around `put`. This module cannot: it does not
 * know what an entry references.
 *
 * *When* the shared copy is written is configurable for the same reason — see
 * {@link Options.publication}. A caller holding a write transaction takes
 * `"deferred"` and publishes afterwards.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CacheStore from "./CacheStore.vibe";
/**
 * The two tiers to compose.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    /** The machine-local, durable tier. Every lookup tries this one first. */
    readonly local: CacheStore.Service;
    /** The shared tier. Consulted on a local miss unless an exact record expired; written through on put. */
    readonly remote: CacheStore.Service;
    /**
     * When the shared tier's copy of an entry is written.
     *
     * - `"inline"` (the default): `put` writes both tiers before it returns.
     * - `"deferred"`: `put` writes the **local tier only**, and publishing to the
     *   shared tier belongs to the caller.
     *
     * `"deferred"` exists for one caller: `@smthrs/engine-store` commits the
     * cache row and the journal record that explains it inside a single
     * `DurableWriter` transaction, and a host call must never be held across a
     * write transaction — an inline `put` would hold a network round trip inside
     * it. That engine composes this store in `"deferred"` mode and publishes
     * through its own `CacheSync` seam once the transaction has committed.
     * Lookups stay read-through in both modes.
     */
    readonly publication?: "inline" | "deferred" | undefined;
}
/**
 * Composes a local and a remote cache store.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (options: Options) => CacheStore.Service;
/**
 * Provides a combined cache store as the `CacheStore` tag.
 *
 * Both tiers are supplied as *effects* rather than layers because they inhabit
 * the same tag: composing two `Layer<CacheStore>` would just shadow one with
 * the other.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: <EL, RL, ER, RR>(options: {
    readonly local: Effect.Effect<CacheStore.Service, EL, RL>;
    readonly remote: Effect.Effect<CacheStore.Service, ER, RR>;
    readonly publication?: Options["publication"];
}) => Layer.Layer<CacheStore.CacheStore, EL | ER, RL | RR>;
