/**
 * Browser-safe persistence port for encrypted credential material.
 *
 * The store only ever sees a {@link SealedRecord}: an opaque connection name
 * plus ciphertext. Plaintext never reaches this boundary, so an adapter can be
 * backed by anything — SQL, Web Storage, a remote vault — without becoming a
 * place a secret can leak from.
 *
 * Writes are compare-and-set on `version`. A writer that read version *n*
 * commits version *n + 1*; a concurrent writer that read the same *n* is
 * refused with {@link ControlError.CredentialConflict} rather than silently
 * overwriting the winner.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option } from "effect";
import { CredentialConflict, Unavailable } from "../../../src/ControlError.ts";
/**
 * One credential at rest: opaque metadata plus the sealed secret.
 *
 * @category models
 * @since 0.1.0
 */
export interface SealedRecord {
    readonly id: string;
    readonly name: string;
    /** Base64 ciphertext produced by a `CredentialCipher`. */
    readonly ciphertext: string;
    /** Base64 per-record nonce. Never reused across versions. */
    readonly nonce: string;
    /** Monotonic write counter; 1 for a freshly created credential. */
    readonly version: number;
    readonly updatedAtMs: number;
}
/**
 * The persistence operations `Credential` needs.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
    readonly list: () => Effect.Effect<ReadonlyArray<SealedRecord>, Unavailable>;
    readonly read: (id: string) => Effect.Effect<Option.Option<SealedRecord>, Unavailable>;
    /** Commits `record` only if the stored version is `record.version - 1`. */
    readonly write: (record: SealedRecord) => Effect.Effect<void, Unavailable | CredentialConflict>;
    readonly remove: (id: string) => Effect.Effect<void, Unavailable>;
}
declare const CredentialStore_base: Context.ServiceClass<CredentialStore, "/control/CredentialStore", Service>;
/**
 * Service key for encrypted credential persistence.
 *
 * @category services
 * @since 0.1.0
 */
export declare class CredentialStore extends CredentialStore_base {
}
/**
 * Constructs a store from an implementation record.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (implementation: Service) => Service;
/**
 * A store that reports unavailable persistence for every operation.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeNoop: (overrides?: Partial<Service>) => Service;
/**
 * Provides a store that reports unavailable persistence.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<CredentialStore>;
/**
 * Constructs a process-local store.
 *
 * Browser-safe and durable for the lifetime of the process only; it exists so
 * the credential contract can be exercised without a host adapter, and as the
 * fallback a short-lived worker can use.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeMemory: () => Service;
/**
 * Provides a process-local store.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerMemory: Layer.Layer<CredentialStore>;
export {};
