/**
 * Scrubbing: replace a secret's value, wherever an answer echoes it, with its
 * placeholder before the guest sees the answer.
 *
 * A host that received a value may send it back: an API that lists the
 * caller's tokens, an echo service, an error that quotes the request. The
 * scrubber looks for each value in the forms such an echo takes
 * ({@link forms}):
 *
 * - the value itself, as UTF-8;
 * - percent-encoded, with uppercase and lowercase hexadecimal, and with `+`
 *   for a space;
 * - inside a JSON string;
 * - inside base64 or base64url, at each of the three byte alignments, so the
 *   value is found inside a longer encoded string such as a Basic
 *   credential's `user:value`.
 *
 * {@link Scrubber.stream} scrubs a body as it streams. It holds back fewer
 * bytes than the longest form, so a value split across chunks is still
 * found, and it adds no other delay or bound on the body's size. A
 * transformation outside these forms, such as hexadecimal or a hash, is not
 * found: bind a secret only to hosts whose answers have been reviewed.
 *
 * @since 0.1.0
 */
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
/**
 * A value to scrub, and the text that replaces it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Target {
    readonly value: Redacted.Redacted<string>;
    readonly replacement: string;
}
/**
 * Scrubs every {@link Target} it was made with.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scrubber {
    /** Whether there is anything to scrub. A scrubber made with no targets changes nothing. */
    readonly active: boolean;
    /** `value` with every form of every target replaced. */
    readonly text: (value: string) => string;
    /** `body` with every form of every target replaced, as it streams. */
    readonly stream: <E, R>(body: Stream.Stream<Uint8Array, E, R>) => Stream.Stream<Uint8Array, E, R>;
}
/**
 * The forms of `value` an echo may take, without repeats. A base64 form is
 * the run of characters that depend only on the value's bytes at that
 * alignment, so it is found wherever the value sits in an encoded string.
 *
 * @category scrubbing
 * @since 0.1.0
 */
export declare const forms: (value: string) => ReadonlyArray<string>;
/**
 * A scrubber for `targets`. Where two forms match at one position, the
 * longer one is replaced.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (targets: ReadonlyArray<Target>) => Scrubber;
