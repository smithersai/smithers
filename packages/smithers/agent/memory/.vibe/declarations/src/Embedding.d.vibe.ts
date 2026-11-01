/**
 * Provider-neutral embeddings used by semantic memory recall.
 *
 * No embedding provider ships with Smithers, so a host injects one through
 * {@link layer}. The built-in {@link inProcessVector} hashes characters into
 * 64 buckets: it is deterministic and lexical, not semantic, and exists for
 * tests and offline runs.
 *
 * @see https://memory.smithers.sh/reference/api/
 * @since 0.1.0
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MemoryError from "./MemoryError.vibe";
/**
 * A vector returned by an embedding provider.
 *
 * @category models
 * @since 0.1.0
 */
export interface EmbedResponse {
    readonly vector: ReadonlyArray<number>;
}
/**
 * Ordered batch embedding response.
 *
 * @category models
 * @since 0.1.0
 */
export interface EmbedManyResponse {
    readonly embeddings: ReadonlyArray<EmbedResponse>;
}
/**
 * Injectable provider function.
 *
 * @category models
 * @since 0.1.0
 */
export type EmbedMany = (inputs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, MemoryError.MemoryError>;
/**
 * Embedding service shape, mirroring the unstable Effect EmbeddingModel
 * single-input and ordered batched operations.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
    readonly embed: (input: string) => Effect.Effect<EmbedResponse, MemoryError.MemoryError>;
    readonly embedMany: (inputs: ReadonlyArray<string>) => Effect.Effect<EmbedManyResponse, MemoryError.MemoryError>;
}
declare const Embedding_base: Context.ServiceClass<Embedding, "flows/memory/Embedding", Service>;
/**
 * Context tag for embeddings.
 *
 * @category services
 * @since 0.1.0
 */
export declare class Embedding extends Embedding_base {
}
/**
 * Builds the service from an injectable batch provider.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (embedMany: EmbedMany) => Service;
/**
 * Provides an injectable embedding provider.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: (embedMany: EmbedMany) => Layer.Layer<Embedding>;
/**
 * Constructs a provider that reports unavailable embeddings.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeNoop: () => Service;
/**
 * Provides the unavailable embedding implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: Layer.Layer<Embedding>;
/**
 * Provides a deterministic embedding implementation for tests and local
 * integrations.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerFake: (vectors: ReadonlyArray<ReadonlyArray<number>> | ((input: string, index: number) => ReadonlyArray<number>)) => Layer.Layer<Embedding>;
/**
 * Stable model identity for the built-in projection.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const inProcessModel = "flows-embedding/in-process-v1";
/**
 * Computes the deterministic local v1 vector: a character hash, so texts
 * rank close when they share characters, not meaning.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const inProcessVector: (input: string) => ReadonlyArray<number>;
/**
 * Constructs the deterministic, in-process v1 embedding implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeInProcess: () => Service;
/**
 * Provides deterministic in-process embeddings with no provider dependency.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerInProcess: Layer.Layer<Embedding>;
export {};
