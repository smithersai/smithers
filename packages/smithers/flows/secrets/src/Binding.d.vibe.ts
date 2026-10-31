/**
 * What a secret is bound to: its name, the hosts that may receive its value,
 * and optionally the methods.
 *
 * A binding is the whole of a secret's reach. The egress substitutes a value
 * only into a request for one of its hosts, by one of its methods, so a host
 * is an exact DNS name: no wildcard, no IP address, no port and no single
 * label such as `localhost`.
 *
 * A value is bounded control-free text, checked by {@link checkValue} before
 * it is stored and again before the egress puts it in a header: no control
 * character can split a header, and no value is so short that scrubbing its
 * echoes would rewrite ordinary text.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
/**
 * A secret's name, as an environment variable would hold it: an uppercase
 * letter or underscore, then up to 63 uppercase letters, digits or
 * underscores.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Name: Schema.String;
/**
 * Whether `text` is a host a secret may be bound to: a lowercase DNS name of
 * at least two labels, at most 253 characters, whose last label is not all
 * digits, so an IPv4 address is not one.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const isHost: (text: string) => boolean;
/**
 * A host a secret may be bound to (see {@link isHost}).
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Host: Schema.String;
/**
 * A method a secret may be used with.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Method: Schema.Literals<readonly ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]>;
/**
 * The most hosts one secret may be bound to.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumHosts = 16;
/**
 * A secret's binding: its name, between one and {@link maximumHosts} hosts,
 * and the methods it may be used with, every method when absent.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Binding: Schema.Struct<{
    readonly name: Schema.String;
    readonly hosts: Schema.$Array<Schema.String>;
    readonly methods: Schema.optional<Schema.$Array<Schema.Literals<readonly ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]>>>;
}>;
/**
 * A secret's binding (see {@link Binding}).
 *
 * @category models
 * @since 0.1.0
 */
export type Binding = typeof Binding.Type;
/**
 * The shortest value, in UTF-8 bytes: 8.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const minimumValueBytes = 8;
/**
 * The longest value, in UTF-8 bytes: 16 KiB.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumValueBytes: number;
/**
 * Why a value can't be a secret's: shorter than {@link minimumValueBytes},
 * longer than {@link maximumValueBytes}, holding a control character
 * (U+0000 to U+001F, U+007F), or holding an unpaired surrogate.
 *
 * @category models
 * @since 0.1.0
 */
export type ValueProblem = "too_short" | "too_long" | "control_character" | "malformed_text";
/**
 * What is wrong with `value` as a secret's value, or `undefined` when nothing
 * is. The answer names the rule, never the value.
 *
 * @category validation
 * @since 0.1.0
 */
export declare const valueProblem: (value: string) => ValueProblem | undefined;
declare const ValueInvalid_base: Schema.Class<ValueInvalid, Schema.TaggedStruct<"@smthrs/secrets/Binding/ValueInvalid", {
    readonly reason: Schema.Literals<readonly ["too_short", "too_long", "control_character", "malformed_text"]>;
}>, import("effect/Cause").YieldableError>;
/**
 * A value that can't be a secret's, and why. It never carries the value.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class ValueInvalid extends ValueInvalid_base {
}
/**
 * Succeeds when `value` can be a secret's value, else fails with
 * {@link ValueInvalid}.
 *
 * @category validation
 * @since 0.1.0
 */
export declare const checkValue: (value: Redacted.Redacted<string>) => Effect.Effect<void, ValueInvalid>;
export {};
