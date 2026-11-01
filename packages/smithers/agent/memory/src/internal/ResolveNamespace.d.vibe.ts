/**
 * Shared validating bank and namespace resolution.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import { MemoryError } from "../MemoryError.ts";
import * as Namespace from "../Namespace.vibe";
/**
 * Maps a structured namespace to the public bank name recall accepts.
 * {@link namespaceForBank} is its inverse for every prefixed bank.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const bankForNamespace: (namespace: Namespace.Namespace) => string;
/**
 * Performs the unvalidated syntactic inverse of {@link bankForNamespace}.
 * Prefixes preserve explicit lifetimes; an unprefixed bank is flow-local.
 * The returned `id` is intentionally typed as `string`, not
 * `Namespace.NonEmptyString`. Use {@link resolveNamespace} at every I/O
 * boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const namespaceForBank: (bank: string) => {
    readonly kind: Namespace.Kind;
    readonly id: string;
};
/**
 * Resolves a structured namespace or public bank name.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const resolveNamespace: (input: Namespace.Namespace | string) => Effect.Effect<{
    readonly namespace: Namespace.Namespace;
    readonly bank: string;
}, MemoryError>;
/**
 * Resolves and de-duplicates bank names by structured namespace, preserving
 * the first public spelling for result attribution.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const resolveBanks: (banks: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<{
    readonly namespace: Namespace.Namespace;
    readonly bank: string;
}>, MemoryError>;
