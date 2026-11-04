/**
 * Verified webhook ingestion through the authoritative Control boundary.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 * @since 0.1.0
 */
import * as ControlChannels from "@smthrs/control/Channels";
import type { ControlError } from "@smthrs/control/ControlError";
import type { Receipt, RunSummary } from "@smthrs/control/ControlSchema";
import type { CredentialRef } from "@smthrs/control/Credential";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Channel from "./Channel.vibe";
import { TriggerError } from "./TriggerError.vibe";
/**
 * Compares a supplied byte string against the expected one without returning
 * early on a mismatch.
 *
 * The loop runs exactly `expected.length` times, so its iteration count is
 * fixed by the secret side of the comparison and never by the caller's. Reading
 * the longer of the two instead let a caller lengthen its input until the work
 * stopped growing, which reports the expected signature's length. The length
 * difference is folded into the result, so inputs of unequal length always
 * disagree.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const constantTimeEqual: (expected: Uint8Array, supplied: Uint8Array) => boolean;
/**
 * Configuration for a raw-byte signature verifier.
 *
 * `expected` receives a private copy of the request bytes and the redacted
 * credential reference the channel was declared with, and answers with the
 * signature bytes the request must carry in `header`. It returns an Effect so
 * the secret is resolved through the host's resolver per request rather than
 * captured in a closure at declaration time, and so a resolution or HMAC
 * failure arrives as a typed `verification_failed` instead of a defect that
 * kills the fiber.
 *
 * @category models
 * @since 0.1.0
 */
export interface SignatureConfig {
    readonly header: string;
    readonly expected: (body: Uint8Array, credential: Redacted.Redacted<CredentialRef>) => Effect.Effect<Uint8Array, TriggerError>;
}
/**
 * Builds a verifier that compares a signature header in constant time.
 *
 * An absent or empty header is refused before `expected` runs, and an
 * `expected` that answers with zero bytes is refused after it. Neither is a
 * comparison the constant-time equality can decide: it agrees on two empty
 * byte strings, so a request carrying no signature at all would have
 * authenticated against a secret that resolved to the empty string. A
 * zero-length expected signature is a misconfigured credential, never a valid
 * one, so the door stays closed instead of opening for everyone.
 *
 * Every refusal carries the same message, `webhook signature in <header> did
 * not verify`, whatever the reason. A failure raised by `expected` is kept in
 * `cause` only: its message names the credential reference or the resolver
 * that could not produce a secret, which is a host detail, and the refusal
 * that answers a bad signature answers a broken resolver the same way.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeSignatureVerifier: (config: SignatureConfig) => Channel.Verify;
/**
 * Webhook declaration configuration.
 *
 * `credential` is required. It used to default to a reference named after the
 * channel, so a webhook declared without one verified against whatever
 * credential happened to share its name instead of being refused, and two
 * declarations differing only in credential verified identically.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config<Payload, Outbound = never> extends Channel.Config<Payload, RunSummary, Outbound> {
    readonly credential: Redacted.Redacted<CredentialRef>;
}
/**
 * A webhook door that can only ingest through `Channels` and `Control`.
 *
 * @category services
 * @since 0.1.0
 */
export interface Webhook {
    readonly name: string;
    readonly register: Effect.Effect<void, never, ControlChannels.Channels>;
    readonly ingest: (raw: Channel.RawInbound) => Effect.Effect<Receipt, ControlError | TriggerError, ControlChannels.Channels>;
}
/**
 * Builds a webhook door whose only dispatch path is the Control channel
 * coordinator.
 *
 * Verification occurs inside `Channels.ingest` before the adapter's JSON or
 * schema decoder and before any Control operation.
 *
 * `ingest` does not register: a channel is registered once, deliberately,
 * through {@link Webhook.register}, so traffic to an unregistered channel is
 * reported as unavailable rather than silently self-registering the door it
 * arrived at.
 *
 * `ingest` also copies `body`, `headers`, and `idempotencyKey` before anything
 * reads them. Verification, delivery fingerprinting, and decoding then all see
 * one private snapshot, so a verifier that edits the bytes it was handed, or a
 * caller that mutates its own object between building this Effect and running
 * it, cannot authenticate one payload and have another decoded. A
 * `SharedArrayBuffer`-backed view is copied out of shared memory by the same
 * step.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <Payload, Outbound = never>(config: Config<Payload, Outbound>) => Webhook;
