import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
/**
 * What every placeholder starts with.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const prefix = "smthrs-secret-";
/**
 * The shortest key {@link minter} accepts, in characters: 32, so a key
 * carries at least 128 bits even as hexadecimal.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const minimumKeyLength = 32;
declare const KeyTooShort_base: Schema.Class<KeyTooShort, Schema.TaggedStruct<"@smthrs/secrets/Placeholder/KeyTooShort", {}>, import("effect/Cause").YieldableError>;
/**
 * The key is shorter than {@link minimumKeyLength}.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class KeyTooShort extends KeyTooShort_base {
}
/**
 * Derives placeholders under one key.
 *
 * @category models
 * @since 0.1.0
 */
export interface Minter {
    /**
     * The placeholder for secret `name` in `scope`: the same for the same
     * scope and name, and unrelated for any other.
     */
    readonly derive: (scope: string, name: string) => Effect.Effect<string>;
}
/**
 * A {@link Minter} under `key`, imported once as a non-extractable HMAC key.
 * Fails with {@link KeyTooShort} for a key under 32 characters.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const minter: (key: Redacted.Redacted<string>) => Effect.Effect<Minter, KeyTooShort>;
export {};
