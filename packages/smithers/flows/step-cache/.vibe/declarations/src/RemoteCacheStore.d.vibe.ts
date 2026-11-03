/**
 * The shared step-result tier: a {@link CacheStore.Service} spoken over HTTP.
 *
 * This is Bazel's *action cache* half of the dumb-HTTP remote cache protocol,
 * from `src/main/java/com/google/devtools/build/lib/remote/http/HttpCacheClient.java`
 * in {@link https://github.com/bazelbuild/bazel | bazelbuild/bazel}: "Action
 * cache blobs are stored under the path `/ac/base16-key`", written with `PUT`
 * and read with `GET`. The blob we carry is the JSON encoding of a
 * {@link CacheStore.CacheEntry} rather than a REAPI `ActionResult` proto,
 * because our recorded result and its journal provenance are the thing being
 * shared.
 *
 * The load-bearing protocol constraint lives with the *caller*, not here:
 * every artifact an entry references must be durable in the shared artifact
 * tier before the entry is `put`. Bazel states it in
 * `src/main/java/com/google/devtools/build/lib/remote/UploadManifest.java`:
 * "action results may fail to validate server-side if they are accessed before
 * all blobs they refer to are present". See the
 * {@link https://smithers.sh/docs/reference/api/step-cache | step-cache reference}.
 *
 * The endpoint and its credentials arrive as layer construction options. They
 * are a capability, never an input: they are not hashed into a step key and
 * never journaled; see the
 * {@link https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/docs/concepts/step-keys.md | step-key contract}.
 *
 * ## Server contract
 *
 * A conforming tier owes three answers under `/ac/{keyDigest}`, and this
 * client speaks two extensions plain Bazel HTTP does not define:
 *
 * - `GET` answers `200` with the {@link CacheStore.CacheEntry} JSON or `404`
 *   for a miss. When the request carries `recordedRunId` and
 *   `recordedEventSeq`, the tier answers the entry that provenance recorded if
 *   it still holds it, and its head otherwise, which is exactly the SQL tier's
 *   ledger-then-head rule.
 * - `PUT` answers `201` for a first write, any other 2xx when what it already
 *   holds does not disagree, and `409` when it does. Decide that in the two
 *   stages the SQL tier decides it in. A publication reusing a
 *   `(keyDigest, recordedRunId, recordedEventSeq)` the tier already recorded is
 *   `409` unless its `result`, `meta`, and `createdAtMs` all match, because
 *   that provenance record is immutable. Every other publication is arbitrated
 *   on the canonical `result` alone, as the head is: a second run recording the
 *   same result under its own provenance carries a different `meta`,
 *   `createdAtMs`, and run identity without being a conflict, and answering
 *   `409` there would report cross-host divergence that has not happened. That
 *   is what makes first-writer-wins decidable over dumb HTTP.
 * - `DELETE` answers 2xx when it removed the entry and `404` when it did not.
 *   With `recordedRunId` and `recordedEventSeq` the delete is a
 *   compare-and-swap: remove the entry only while it still carries that
 *   provenance, and answer `404` on a mismatch.
 *
 * **Against a tier that ignores query parameters both extensions degrade
 * silently.** A fenced eviction becomes an unconditional `DELETE`, which is
 * the poison-drop the fence exists to prevent (issue #119), and a fenced
 * lookup becomes a head read. The client cannot tell the two apart, because a
 * conforming tier answers a fenced lookup with its head whenever it holds no
 * row for that provenance: a returned entry recorded under different
 * provenance is therefore accepted as that documented fallback, the same value
 * the SQL tier serves. Provenance-fenced reads and evictions need a conforming
 * server; against any other tier, compose this store for its head semantics
 * alone.
 *
 * @since 0.1.0
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as CacheStore from "./CacheStore.vibe";
/**
 * How to reach the shared step-result tier.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    /**
     * The cache root, e.g. `https://cache.example.com`. `/ac/{keyDigest}` is
     * resolved beneath it. A trailing slash is ignored.
     */
    readonly endpoint: string;
    /**
     * Headers sent with every request. This is the credential seam, and it is
     * deliberately construction-time — see the module doc.
     * All configured names are redacted case-insensitively in Effect HTTP
     * tracing spans, preserving the caller's existing header redaction policy.
     * Redirects are never followed, so these headers reach only the endpoint.
     */
    readonly headers?: Readonly<Record<string, string>> | undefined;
    /**
     * Deadline for one whole cache operation: its request, its response body,
     * and the decoding between them, measured from the call. Defaults to 60
     * seconds. It is one budget rather than one per phase, so a tier that
     * answers headers promptly and then stalls the body cannot spend it twice.
     */
    readonly requestTimeout?: Duration.Input | undefined;
    /** Largest cache-entry response accepted. Defaults to four MiB. */
    readonly maxResponseBytes?: number | undefined;
}
/**
 * Default deadline for one whole remote cache operation, its request and its
 * response body together.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const defaultRequestTimeout: Duration.Duration;
/**
 * Default and absolute maximum encoded cache entry size.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumEntryBytes: number;
/**
 * Builds a remote cache store over Effect's `HttpClient`.
 *
 * Status mapping for `put`, which is the only operation with a three-way
 * outcome: `201 Created` is `Inserted`, any other 2xx is `ExistingSame` (the
 * server already held an entry this publication does not disagree with), and
 * `409 Conflict` is `Conflict` (it held one it does). What counts as
 * disagreement is the two-stage rule in the module doc's server contract. That
 * is the smallest vocabulary that preserves `CacheStore`'s first-writer-wins
 * contract over dumb HTTP.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (options: Options) => Effect.Effect<CacheStore.Service, CacheStore.CacheStoreError, HttpClient.HttpClient>;
/**
 * Provides a remote cache store as the `CacheStore` tag.
 *
 * Composing this alone makes every step-cache lookup a network round trip and
 * leaves this machine with no durable record. The intended production shape is
 * `CombinedCacheStore`, with this as its remote tier.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: (options: Options) => Layer.Layer<CacheStore.CacheStore, CacheStore.CacheStoreError, HttpClient.HttpClient>;
