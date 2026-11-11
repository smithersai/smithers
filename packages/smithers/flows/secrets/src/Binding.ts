/**
 * What a secret is bound to: its name, the hosts that may receive its value,
 * and optionally the methods.
 *
 * A binding is the whole of a secret's reach. The egress substitutes a value
 * only into a request for one of its hosts, by one of its methods, so a host
 * is an exact DNS name: no wildcard, no IP address, no port and no single
 * label such as `localhost`.
 *
 * A value is bounded printable ASCII text with no surrounding spaces,
 * checked by {@link checkValue} before
 * it is stored and again before the egress puts it in a header: no control
 * character can split a header, and no value is so short that scrubbing its
 * echoes would rewrite ordinary text.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { utf8 } from "./internal/bytes.ts"

/**
 * A secret's name, as an environment variable would hold it: an uppercase
 * letter or underscore, then up to 63 uppercase letters, digits or
 * underscores.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Name = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]{0,63}$/))

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Whether `text` is a host a secret may be bound to: a lowercase DNS name of
 * at least two labels, at most 253 characters, whose last label is not all
 * digits, so an IPv4 address is not one.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isHost = (text: string): boolean => {
  if (text.length > 253) return false
  const labels = text.split(".")
  return labels.length >= 2 && labels.every((part) => label.test(part)) && !/^[0-9]+$/.test(labels.at(-1)!)
}

/**
 * A host a secret may be bound to (see {@link isHost}).
 *
 * @category schemas
 * @since 0.1.0
 */
export const Host = Schema.String.check(Schema.makeFilter((text: string) => isHost(text) || "a lowercase DNS name"))

/**
 * A method a secret may be used with.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Method = Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])

/**
 * The most hosts one secret may be bound to.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumHosts = 16

/**
 * A secret's binding: its name, between one and {@link maximumHosts} hosts,
 * and the methods it may be used with, every method when absent.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Binding = Schema.Struct({
  name: Name,
  hosts: Schema.Array(Host).check(Schema.isMinLength(1), Schema.isMaxLength(maximumHosts)),
  methods: Schema.optional(Schema.Array(Method).check(Schema.isMinLength(1)))
})

/**
 * A secret's binding (see {@link Binding}).
 *
 * @category models
 * @since 0.1.0
 */
export type Binding = typeof Binding.Type

/**
 * The shortest value, in UTF-8 bytes: 8.
 *
 * @category constants
 * @since 0.1.0
 */
export const minimumValueBytes = 8

/**
 * The longest value, in UTF-8 bytes: 16 KiB.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumValueBytes = 16 * 1024

/**
 * Why a value can't be a secret's: shorter than {@link minimumValueBytes},
 * longer than {@link maximumValueBytes}, holding a control character
 * (U+0000 to U+001F, U+007F), holding an unpaired surrogate, holding a
 * non-ASCII character, or starting or ending with a space.
 *
 * @category models
 * @since 0.1.0
 */
export type ValueProblem =
  | "too_short"
  | "too_long"
  | "control_character"
  | "malformed_text"
  | "non_ascii"
  | "surrounding_space"

/**
 * What is wrong with `value` as a secret's value, or `undefined` when nothing
 * is. The answer names the rule, never the value.
 *
 * @category validation
 * @since 0.1.0
 */
export const valueProblem = (value: string): ValueProblem | undefined => {
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) return "malformed_text"
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return "control_character"
  if (/[^\u0020-\u007e]/.test(value)) return "non_ascii"
  if (value.startsWith(" ") || value.endsWith(" ")) return "surrounding_space"
  const bytes = utf8(value).length
  if (bytes < minimumValueBytes) return "too_short"
  if (bytes > maximumValueBytes) return "too_long"
  return undefined
}

/**
 * A value that can't be a secret's, and why. It never carries the value.
 *
 * @category errors
 * @since 0.1.0
 */
export class ValueInvalid extends Schema.TaggedError<ValueInvalid>()("@smthrs/secrets/Binding/ValueInvalid", {
  reason: Schema.Literals([
    "too_short",
    "too_long",
    "control_character",
    "malformed_text",
    "non_ascii",
    "surrounding_space"
  ])
}) {}

/**
 * Succeeds when `value` can be a secret's value, else fails with
 * {@link ValueInvalid}.
 *
 * @category validation
 * @since 0.1.0
 */
export const checkValue = (value: Redacted.Redacted<string>): Effect.Effect<void, ValueInvalid> => {
  const reason = valueProblem(Redacted.value(value))
  return reason === undefined ? Effect.void : Effect.fail(new ValueInvalid({ reason }))
}
