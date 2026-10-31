/**
 * The `Crypto` service Effect 4.0 shipped as `effect/Crypto`.
 *
 * Effect 4.1 removed `effect/Crypto` in favor of the `effect/crypto` modules
 * (`Digest`, `SecureRandom` and the rest). Smithers keeps the 4.0 service,
 * with the same members and the same results, so a program that needs
 * randomness or a digest still requires one `Crypto` service. A host provides
 * it with {@link make}, with {@link layerFromDigest} over its own Effect 4.1
 * `Digest` layer, or with `WebCrypto.layer` over the global WebCrypto object.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
declare const TypeId = "~effect/Crypto";
/**
 * A digest algorithm that {@link Crypto.digest} accepts.
 *
 * @category models
 * @since 1.0.0
 */
export type DigestAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
/**
 * Cryptographically secure randomness and digests.
 *
 * @category models
 * @since 1.0.0
 */
export interface Crypto {
    readonly [TypeId]: typeof TypeId;
    /** A uniformly distributed safe integer, read now. */
    nextIntUnsafe(): number;
    /** A uniformly distributed number in `[0, 1)`, read now. */
    nextDoubleUnsafe(): number;
    /** `size` random bytes; a size that is not a non-negative safe integer fails with `BadArgument`. */
    randomBytes(size: number): Effect.Effect<Uint8Array, PlatformError.PlatformError>;
    /** The digest of `data` under `algorithm`. */
    digest(algorithm: DigestAlgorithm, data: Uint8Array): Effect.Effect<Uint8Array, PlatformError.PlatformError>;
    /** A number in `[0, 1)`. */
    readonly random: Effect.Effect<number>;
    /** A random boolean. */
    readonly randomBoolean: Effect.Effect<boolean>;
    /** A safe integer. */
    readonly randomInt: Effect.Effect<number>;
    /** A number in `[min, max)`. */
    randomBetween(min: number, max: number): Effect.Effect<number>;
    /** An integer in `[min, max]`, or `[min, max)` when `halfOpen` is true. */
    randomIntBetween(min: number, max: number, options?: {
        readonly halfOpen?: boolean | undefined;
    }): Effect.Effect<number>;
    /** The elements in a random order. */
    randomShuffle<A>(elements: Iterable<A>): Effect.Effect<Array<A>>;
    /** A version 4 UUID, as text or as its 16 bytes. */
    randomUUIDv4(options?: {
        readonly format?: "hex" | undefined;
    }): Effect.Effect<string, PlatformError.PlatformError>;
    randomUUIDv4<Format extends "hex" | "bytes">(options: {
        readonly format: Format;
    }): Effect.Effect<(Format extends "bytes" ? Uint8Array : string), PlatformError.PlatformError>;
    randomUUIDv4(options?: {
        readonly format?: "hex" | "bytes" | undefined;
    }): Effect.Effect<string | Uint8Array, PlatformError.PlatformError>;
    /** A version 7 UUID stamped with the `Clock`'s time, as text or as its 16 bytes. */
    randomUUIDv7(options?: {
        readonly format?: "hex" | undefined;
    }): Effect.Effect<string, PlatformError.PlatformError>;
    randomUUIDv7<Format extends "hex" | "bytes">(options: {
        readonly format: Format;
    }): Effect.Effect<(Format extends "bytes" ? Uint8Array : string), PlatformError.PlatformError>;
    randomUUIDv7(options?: {
        readonly format?: "hex" | "bytes" | undefined;
    }): Effect.Effect<string | Uint8Array, PlatformError.PlatformError>;
    /** A ULID stamped with the `Clock`'s time. */
    readonly randomULID: Effect.Effect<string, PlatformError.PlatformError>;
}
/**
 * The `Crypto` service key, `"effect/Crypto"` as in Effect 4.0.
 *
 * @category services
 * @since 1.0.0
 */
export declare const Crypto: Context.Service<Crypto, Crypto>;
/**
 * Builds the `Crypto` service from a source of random bytes and a digest, as
 * Effect 4.0's `Crypto.make` did. Every random member reads `randomBytes`;
 * UUIDv7 and ULID read the time from the `Clock`.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (impl: {
    readonly randomBytes: (size: number) => Uint8Array;
    readonly digest: (algorithm: DigestAlgorithm, data: Uint8Array) => Effect.Effect<Uint8Array, PlatformError.PlatformError>;
}) => Crypto;
/**
 * Provides `Crypto` over a host's Effect 4.1 `Digest` layer: what Effect 4.0's
 * `NodeCrypto.layer` and `BunCrypto.layer` provided is
 * `layerFromDigest(NodeCrypto.layerDigest)`, whose digests run synchronously on
 * `node:crypto`. Randomness comes from the global WebCrypto object. An
 * algorithm outside {@link DigestAlgorithm} fails with `BadArgument`.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerFromDigest: <E, R>(digest: Layer.Layer<Digest.Digest, E, R>) => Layer.Layer<Crypto, E, R>;
export {};
