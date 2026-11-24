/**
 * Verified webhook ingestion through the authoritative Control boundary.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 * @since 0.1.0
 */

import * as ControlChannels from "@smthrs/control/Channels"
import type { ControlError } from "@smthrs/control/ControlError"
import { InvalidInput, Unauthorized } from "@smthrs/control/ControlError"
import type { Receipt, RunSummary } from "@smthrs/control/ControlSchema"
import type { CredentialRef } from "@smthrs/control/Credential"
import * as ControlWebhook from "@smthrs/control/WebhookChannel"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type * as Channel from "./Channel.ts"
import { TriggerError } from "./TriggerError.ts"

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
export const constantTimeEqual = (expected: Uint8Array, supplied: Uint8Array): boolean => {
  let difference = expected.length ^ supplied.length
  for (const [index, byte] of expected.entries()) {
    difference |= byte ^ (supplied[index] ?? 0)
  }
  return difference === 0
}

/**
 * The signed timestamp a request must carry, and how old it may be.
 *
 * A signature over the body alone verifies forever, so a captured request
 * replays for as long as the secret lives. A sender that signs
 * `timestamp.body` closes that: name the header carrying the timestamp here,
 * sign it inside `SignatureConfig.expected` (which receives the headers), and
 * the verifier refuses a request whose timestamp is absent, unreadable, or
 * further than `tolerance` from the `Clock`, in either direction.
 *
 * `parse` reads the header's value as epoch milliseconds and answers
 * `undefined` for a value it cannot read. It defaults to
 * {@link epochSeconds}, the whole decimal seconds most senders use. A sender
 * that folds the timestamp into the signature header itself (`t=...,v1=...`)
 * names that header and supplies its own `parse`.
 *
 * The check proves freshness only when `expected` binds the same header into
 * the signature. A timestamp the signature does not cover is the sender's to
 * rewrite.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface TimestampConfig {
  readonly header: string
  readonly tolerance: Duration.Duration
  readonly parse?: ((value: string) => number | undefined) | undefined
}

/**
 * Reads a header value of whole decimal epoch seconds as epoch milliseconds,
 * and answers `undefined` for anything else.
 *
 * @category verification
 * @since 1.0.0-rc.18
 */
export const epochSeconds = (value: string): number | undefined =>
  /^\d{1,12}$/.test(value) ? Number(value) * 1_000 : undefined

/**
 * Configuration for a raw-byte signature verifier.
 *
 * `expected` receives a private copy of the request bytes, the redacted
 * credential reference the channel was declared with, and a private copy of
 * the request headers, and answers with the signature bytes the request must
 * carry in `header`. It returns an Effect so the secret is resolved through
 * the host's resolver per request rather than captured in a closure at
 * declaration time, and so a resolution or HMAC failure arrives as a typed
 * `verification_failed` instead of a defect that kills the fiber.
 *
 * The headers let `expected` sign more than the body: a `v0:{timestamp}:{body}`
 * scheme reads the timestamp header and folds it into the signed bytes. Pair
 * it with `timestamp`, which refuses a request older than a tolerance.
 *
 * @category models
 * @since 0.1.0
 */
export interface SignatureConfig {
  readonly header: string
  readonly expected: (
    body: Uint8Array,
    credential: Redacted.Redacted<CredentialRef>,
    headers: Channel.RawInbound["headers"]
  ) => Effect.Effect<Uint8Array, TriggerError>
  readonly timestamp?: TimestampConfig | undefined
}

/**
 * Copies request bytes into memory nobody else holds.
 *
 * `body.slice()` is not enough: a Node `Buffer` is a `Uint8Array` whose
 * `slice` is an alias of `subarray` and answers with a view over the same
 * memory, so a caller that reused its `Buffer` after handing it over changed
 * what got verified, and a verifier that edited the bytes it was handed edited
 * the caller's. `Uint8Array.from` always allocates, and it copies only the
 * viewed range of an offset view and only a snapshot of a `SharedArrayBuffer`.
 */
const ownedCopy = (body: Uint8Array): Uint8Array => Uint8Array.from(body)

/**
 * Reads a header whose name may be spelled in any case.
 *
 * The lowercase form and the declared spelling are tried first, then every
 * other key whose lowercase form matches. HTTP header names are
 * case-insensitive, and a host that keeps the sender's capitalisation used to
 * fail a lowercase declaration.
 */
const headerValue = (
  headers: Channel.RawInbound["headers"],
  name: string
): string | undefined => {
  const lower = name.toLowerCase()
  const direct = headers[lower] ?? headers[name]
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && key.toLowerCase() === lower) return value
  }
  return undefined
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
 * With `timestamp` configured, a request whose timestamp header is absent,
 * unreadable, or further than the tolerance from the `Clock` is refused before
 * `expected` runs.
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
export const makeSignatureVerifier = (config: SignatureConfig): Channel.Verify => (raw, credential) => {
  const refuse = (cause?: TriggerError) =>
    Effect.fail(
      new TriggerError({
        code: "verification_failed",
        message: `webhook signature in ${config.header} did not verify`,
        ...(cause === undefined ? {} : { cause })
      })
    )
  const timestamp = config.timestamp
  // Whether the request's timestamp is within the tolerance of the clock. A
  // timestamp from the future is as unverifiable as a stale one: a sender
  // that may post-date a request chooses how long its capture stays valid.
  const fresh: (headers: Channel.RawInbound["headers"]) => Effect.Effect<boolean> = timestamp === undefined
    ? () => Effect.succeed(true)
    : (headers) => {
      const stated = headerValue(headers, timestamp.header)
      const at = stated === undefined ? undefined : (timestamp.parse ?? epochSeconds)(stated)
      if (at === undefined || !Number.isFinite(at)) return Effect.succeed(false)
      return Effect.map(
        Clock.currentTimeMillis,
        (now) => Math.abs(now - at) <= Duration.toMillis(timestamp.tolerance)
      )
    }
  return Effect.suspend(() => {
    const supplied = headerValue(raw.headers, config.header)
    if (supplied === undefined || supplied.length === 0) {
      return refuse()
    }
    const actual = new TextEncoder().encode(supplied)
    return Effect.flatMap(fresh(raw.headers), (isFresh) =>
      isFresh
        // The verifier gets its own copies: nothing it does to these bytes or
        // headers can reach what is about to be fingerprinted and decoded.
        ? config.expected(ownedCopy(raw.body), credential, { ...raw.headers }).pipe(
          Effect.matchEffect({
            onFailure: (error) => refuse(error),
            onSuccess: (expected) =>
              expected.length > 0 && constantTimeEqual(expected, actual)
                ? Effect.void
                : refuse()
          })
        )
        : refuse())
  })
}

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
  readonly credential: Redacted.Redacted<CredentialRef>
}

/**
 * A webhook door that can only ingest through `Channels` and `Control`.
 *
 * @category services
 * @since 0.1.0
 */
export interface Webhook {
  readonly name: string
  readonly register: Effect.Effect<void, never, ControlChannels.Channels>
  readonly ingest: (
    raw: Channel.RawInbound
  ) => Effect.Effect<Receipt, ControlError | TriggerError, ControlChannels.Channels>
}

const invalidInput = (issue: string): InvalidInput => new InvalidInput({ issue })

const toControlChannel = <Payload, Outbound>(
  config: Config<Payload, Outbound>
): ControlChannels.Channel<Payload> => {
  const channel = ControlWebhook.make({
    name: config.name,
    schema: config.schema,
    credential: config.credential,
    // The message is fixed here rather than forwarded from the verifier: a
    // custom `verify` may say why it refused, and that reason travels toward
    // the unauthenticated sender on the same error that answers a bad
    // signature. `Unauthorized` carries no cause, so nothing else survives
    // the crossing.
    verify: (raw, credential) =>
      config.verify(raw, credential).pipe(
        Effect.mapError(() => new Unauthorized({ message: `webhook ${config.name} did not verify the request` }))
      ),
    map: (payload) => {
      const inbound = config.inbound(payload)
      if ("start" in inbound) {
        return Effect.succeed({
          _tag: "Start" as const,
          flowId: inbound.start.flowId,
          input: inbound.start.input
        })
      }
      return Schema.decodeUnknownEffect(Schema.Json)(inbound.signal.value).pipe(
        Effect.map(
          (value) => ({
            _tag: "Signal" as const,
            runId: inbound.signal.runId,
            signal: {
              name: inbound.signal.stepId,
              payload: value
            }
          })
        ),
        Effect.mapError((error) => invalidInput(String(error)))
      )
    },
    project: (run) => {
      if (config.outbound === undefined) {
        return {
          cursor: String(run.updatedAt),
          operation: "noop" as const,
          message: null
        }
      }
      return {
        cursor: String(run.updatedAt),
        operation: "post" as const,
        message: config.outbound(run)
      }
    }
  })
  return channel
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
export const make = <Payload, Outbound = never>(
  config: Config<Payload, Outbound>
): Webhook => {
  const channel = toControlChannel(config)
  const register = Effect.flatMap(ControlChannels.Channels, (channels) => channels.register(channel))
  return {
    name: config.name,
    register,
    ingest: (raw) => {
      // Copied here rather than inside the Effect: the copy has to happen when
      // the caller hands the request over, not when the returned Effect
      // eventually runs, or a caller that reuses its own buffer in between
      // changes what gets authenticated.
      const snapshot: Channel.RawInbound = {
        body: ownedCopy(raw.body),
        headers: { ...raw.headers },
        idempotencyKey: raw.idempotencyKey
      }
      return Effect.gen(function*() {
        const channels = yield* ControlChannels.Channels
        return yield* channels.ingest({ channel: config.name, raw: snapshot })
      }).pipe(
        Effect.mapError((error) =>
          error instanceof Unauthorized
            ? new TriggerError({
              code: "verification_failed",
              message: `webhook ${config.name} did not verify the request`,
              cause: error
            })
            : error
        )
      )
    }
  }
}
