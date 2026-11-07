/**
 * Credential storage boundary.
 *
 * Credentials are capabilities. They must never enter flow input, plan
 * digests, journal payloads, or model context, so only a {@link CredentialRef}
 * — an id and a human-readable connection name — crosses the browser-safe
 * contract. Plaintext exists in exactly two places: inside a `Redacted` handed
 * to `create`/`rotate`, and inside the `Redacted` returned by `resolve`.
 *
 * The implementation composes two ports:
 *
 * - {@link CredentialStore} persists an opaque sealed record and enforces
 *   compare-and-set on writes, so concurrent rotations cannot interleave.
 *   `rotate` with `expected` extends that compare to the secret itself: the
 *   secret it checks and the version it writes over come from one read, so a
 *   writer that commits in between, in any process, is refused.
 * - {@link CredentialCipher} seals and opens the secret under host-managed
 *   keys. `WebCryptoCipher` is the browser and Node adapter; a host with no
 *   secure key material fails with the typed `Unavailable`.
 *
 * Authorization is a host decision, injected as {@link Options.authorize}. A
 * reference is also authenticated on every operation: caller-owned fields are
 * snapshotted before policy effects run, and a caller cannot present a forged
 * or stale `CredentialRef` because the snapshotted name must still match the
 * stored record.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { CredentialConflict, InvalidInput, type PersistenceError, Unauthorized, Unavailable } from "./ControlError.vibe";
import * as CredentialCipher from "./CredentialCipher.vibe";
import * as CredentialStore from "./CredentialStore.vibe";
/**
 * A journal-safe name for a stored connection credential.
 *
 * @category models
 * @since 0.1.0
 */
export interface CredentialRef {
    readonly id: string;
    readonly name: string;
}
/**
 * One credential operation, as seen by a host authorization policy.
 *
 * @category models
 * @since 0.1.0
 */
export type Operation = "list" | "get" | "create" | "resolve" | "rotate" | "revoke";
/**
 * How {@link Credential.rotate} compares before it writes.
 *
 * @category models
 * @since 1.0.0
 */
export interface RotateOptions {
    /** The secret the caller last saw; the rotation commits only over it. */
    readonly expected?: Redacted.Redacted<string> | undefined;
}
/**
 * Adapter-bound credential resolution. References are safe to list and
 * persist; only `resolve` crosses into a secret-bearing adapter boundary.
 *
 * @category services
 * @since 0.1.0
 */
export interface Credential {
    readonly list: () => Effect.Effect<ReadonlyArray<CredentialRef>, Unavailable | Unauthorized>;
    readonly get: (id: string) => Effect.Effect<CredentialRef, Unavailable | Unauthorized>;
    readonly create: (options: {
        readonly id: string;
        readonly name: string;
        readonly secret: Redacted.Redacted<string>;
    }) => Effect.Effect<CredentialRef, Unavailable | Unauthorized | CredentialConflict | InvalidInput>;
    readonly resolve: (reference: CredentialRef) => Effect.Effect<Redacted.Redacted<string>, Unavailable | Unauthorized | PersistenceError>;
    /**
     * Replaces the secret. With `expected`, replaces it only while the stored
     * secret still equals `expected`, and otherwise fails `CredentialConflict`
     * at the stored version without writing.
     */
    readonly rotate: (reference: CredentialRef, secret: Redacted.Redacted<string>, options?: RotateOptions | undefined) => Effect.Effect<CredentialRef, Unavailable | Unauthorized | CredentialConflict | InvalidInput | PersistenceError>;
    readonly revoke: (reference: CredentialRef) => Effect.Effect<void, Unavailable | Unauthorized>;
}
/**
 * Service tag for credential resolution.
 *
 * @category services
 * @since 0.1.0
 */
export declare const Credential: Context.Service<Credential, Credential>;
/**
 * A credential implementation that explicitly reports unavailable storage.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeNoop: () => Credential;
/**
 * Layer for the unavailable credential-storage boundary.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: Layer.Layer<Credential, never, never>;
/**
 * The collaborators a working credential boundary needs.
 *
 * `authorize` is the host's policy hook. It defaults to allowing every
 * operation, which is correct for a single-principal local process; a server
 * composition supplies its own and gets typed `Unauthorized` failures for free.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    readonly store: CredentialStore.Service;
    readonly cipher: CredentialCipher.Service;
    readonly authorize?: ((operation: Operation, reference: Option.Option<CredentialRef>) => Effect.Effect<void, Unauthorized>) | undefined;
}
/**
 * Constructs a working credential boundary over a store and a cipher.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (options: Options) => Credential;
/**
 * Provides a working credential boundary over the ambient store and cipher.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: (options?: {
    readonly authorize?: Options["authorize"];
}) => Layer.Layer<Credential, never, CredentialStore.CredentialStore | CredentialCipher.CredentialCipher>;
