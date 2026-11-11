/**
 * Webhook ingress as library code, bound to the control plane.
 *
 * Smithers 1.0 has no `listeners` verb and no gateway-level webhook
 * configuration. A webhook door is a `@smthrs/control` `Channel` an
 * application registers with `Channels`, and `Channels.ingest` runs the fixed
 * order that matters: verify the raw bytes, then decode, then map, then reach
 * `Control`. Signature verification is the amplification guard, so nothing in
 * this module lets a provider decoder run before it.
 *
 * `Channels.ingest` drops a replayed `idempotencyKey`, which is what makes a
 * provider redelivery safe to accept. The key is the caller's to supply on the
 * `RawInbound` it hands `ingest`, and an ingress that does not pass one has no
 * redelivery protection. A webhook ingress derives it with
 * {@link signedBodyKey} from the bytes the signature covers: a delivery header
 * is not signed, so a key read from one lets a captured delivery replay under a
 * new header.
 *
 * The decoder's output is validated against `ExternalEvent` before it leaves
 * this module, so a decoder bug fails on the delivery that triggered it.
 *
 * A polling source has no request to verify: it fetched its events itself.
 * {@link fromSource} gives it the same door, so a polled event starts a flow or
 * signals a run through `Channels.ingest` with the same idempotency, and
 * nothing but that source can use it.
 *
 * @since 1.0.0
 */

import { type Channel, Channels, type InboundResult, type RawInbound } from "@smthrs/control/Channels"
import { type ControlError, InvalidInput, Unauthorized } from "@smthrs/control/ControlError"
import type { FlowId, Receipt, RunId, RunSummary } from "@smthrs/control/ControlSchema"
import type { Credential, CredentialRef } from "@smthrs/control/Credential"
import * as WebhookChannel from "@smthrs/control/WebhookChannel"
import { Cause, Effect, Redacted, Schema } from "effect"
import { decode as decodeExternalEvent, type ExternalEvent } from "./ExternalEvent.ts"
import { IntegrationError, isIntegrationError, toInvalidInput, toUnauthorized } from "./IntegrationError.ts"
import * as SignalName from "./SignalName.ts"
import { constantTimeEqual } from "./Signature.ts"

/**
 * The idempotency key for a signed webhook delivery: the SHA-256 of the exact
 * body bytes its signature covers.
 *
 * A delivery id header is not signed, so anyone holding one signed delivery
 * could resend it under a new id and start a second run. This key changes only
 * when the signed bytes change. A provider retry carries the same bytes and is
 * dropped; distinct provider events carry their own ids and timestamps in the
 * body, so they stay distinct.
 *
 * @category constructors
 * @since 1.0.0
 */
export const signedBodyKey = (body: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body)))
    return `signed-body:sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  })

/**
 * How a channel obtains the signing secret behind a credential reference.
 *
 * Resolution is a host concern: the reference is journal-safe, the secret is
 * not, and only the host knows where it lives.
 *
 * @category models
 * @since 1.0.0
 */
export type SecretResolver = (
  credential: Redacted.Redacted<CredentialRef>
) => Effect.Effect<Redacted.Redacted<string>, Unauthorized>

/**
 * A resolver that always answers with one secret. For a single-tenant
 * deployment that reads its webhook secret from the environment.
 *
 * @category constructors
 * @since 1.0.0
 */
export const constantSecret = (secret: Redacted.Redacted<string>): SecretResolver => () => Effect.succeed(secret)

/**
 * A resolver backed by the control plane's credential store.
 *
 * Takes the resolved service rather than requiring it, because a channel's
 * verifier runs with no environment of its own.
 *
 * @category constructors
 * @since 1.0.0
 */
export const credentialSecret = (credentials: Credential): SecretResolver => (credential) =>
  credentials.resolve(Redacted.value(credential)).pipe(
    Effect.mapError((error) =>
      error._tag === "/control/Unauthorized"
        ? error
        : new Unauthorized({ message: `credential ${Redacted.value(credential).name} is unavailable` })
    )
  )

/**
 * What a provider supplies to get a control-plane channel.
 *
 * @category models
 * @since 1.0.0
 */
export interface Config {
  /** The name `Channels.register` and `Channels.ingest` address it by. */
  readonly name: string
  /** The journal-safe reference to the signing secret. */
  readonly credential: Redacted.Redacted<CredentialRef>
  readonly secret: SecretResolver
  /** Non-secret headers whose values affect the decoded event. */
  readonly fingerprintHeaders?: ReadonlyArray<string> | undefined
  /**
   * The provider's signature check over the exact delivered bytes, as a
   * boolean or as an Effect such as `Signature.verifySignature` returns.
   *
   * A verifier that throws, or whose Effect fails or dies, is treated as a
   * failed verification: the delivery is refused with `Unauthorized`, not
   * turned into a defect that kills the ingress fiber. Only `true` verifies.
   */
  readonly verify: (raw: RawInbound, secret: string) => boolean | Effect.Effect<boolean, unknown>
  /**
   * The provider's decoder. Runs only after verification, and may throw an
   * `IntegrationError` for a delivery whose headers or body it cannot read.
   */
  readonly decode: (raw: RawInbound, payload: unknown) => ExternalEvent
  /** What the event does: start a flow, or signal a run. */
  readonly route: (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>
  /** The outbound projection. Defaults to `noop`, which posts nothing. */
  readonly project?: ((run: RunSummary, delivery: unknown) => ReturnType<Channel["project"]>) | undefined
}

const noProjection: Channel["project"] = (run) => ({
  cursor: String(run.updatedAt),
  operation: "noop",
  message: null
})

const invalidSignature = (name: string): IntegrationError =>
  new IntegrationError("invalid-signature", `${name} webhook signature did not verify.`, { channel: name })

/**
 * Builds the control-plane channel for one provider webhook.
 *
 * The verifier is a `WebhookChannel` signature verifier: it sees the raw bytes
 * and the credential reference, and nothing else. A delivery whose signature
 * does not match fails with `Unauthorized` before the provider decoder or
 * `Control` is reached.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (config: Config): Channel => {
  const unauthorized = () => toUnauthorized(invalidSignature(config.name))
  const verifier: WebhookChannel.SignatureVerifier = (raw, credential) =>
    config.secret(credential).pipe(
      Effect.flatMap((secret) =>
        // An application-supplied verifier is ordinary code that can throw,
        // fail or die. Each is a refusal, not a defect: the delivery did not
        // verify. An interruption stays one. An Effect verdict is run, never
        // read for truthiness: an unrun Effect is a truthy object that would
        // pass every delivery.
        Effect.suspend(() => {
          const verdict = config.verify(raw, Redacted.value(secret))
          return Effect.isEffect(verdict) ? verdict : Effect.succeed(verdict)
        }).pipe(
          Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(unauthorized())),
          Effect.flatMap((verified) => verified === true ? Effect.void : Effect.fail(unauthorized()))
        )
      )
    )
  // An `IntegrationError` is provider-safe by construction, so its summary
  // crosses to the control plane. Anything else is internal text, a
  // `TypeError` message or a foreign error's docs-URL suffix, and only the
  // channel name crosses. Raw errors and schema issues can contain payloads
  // or credentials, so they never reach logs either.
  const decodeFailed = (cause: unknown): Effect.Effect<never, InvalidInput> =>
    isIntegrationError(cause)
      ? Effect.fail(toInvalidInput(cause))
      : Effect.logWarning(`${config.name} webhook decoder failed`).pipe(
        Effect.andThen(
          Effect.fail(new InvalidInput({ issue: `${config.name} webhook payload could not be decoded.` }))
        )
      )

  const map: Channel["map"] = (event) => config.route(event as ExternalEvent)
  const json = WebhookChannel.make({
    name: config.name,
    schema: Schema.Json,
    credential: config.credential,
    ...(config.fingerprintHeaders === undefined ? {} : { fingerprintHeaders: config.fingerprintHeaders }),
    verify: verifier,
    map,
    project: config.project ?? noProjection
  })
  return {
    name: config.name,
    schema: Schema.Unknown,
    ...(json.fingerprintHeaders === undefined ? {} : { fingerprintHeaders: json.fingerprintHeaders }),
    verify: json.verify,
    decode: (raw) =>
      json.decode(raw).pipe(
        Effect.flatMap((payload) =>
          Effect.try({ try: () => config.decode(raw, payload), catch: (cause) => cause }).pipe(
            Effect.catch(decodeFailed),
            // The decoder's own output is validated here, at the ingress
            // boundary, so a decoder bug fails loudly on the delivery that
            // triggered it rather than as a malformed signal three hops later.
            Effect.flatMap((event) =>
              decodeExternalEvent(event).pipe(
                Effect.catch(() =>
                  Effect.logWarning(`${config.name} webhook decoder produced a malformed event`).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new InvalidInput({ issue: `${config.name} webhook decoder produced a malformed event.` })
                      )
                    )
                  )
                )
              )
            )
          )
        )
      ),
    map,
    project: json.project
  }
}

/**
 * A route that starts `flowId` with the event as its input.
 *
 * @category constructors
 * @since 1.0.0
 */
export const startFlow = (flowId: FlowId) => (event: ExternalEvent): Effect.Effect<InboundResult, InvalidInput> =>
  Effect.succeed({ _tag: "Start", flowId, input: event })

/**
 * A route that signals `runId` with the event's signal name and payload.
 *
 * @category constructors
 * @since 1.0.0
 */
export const signalRun = (runId: RunId) => (event: ExternalEvent): Effect.Effect<InboundResult, InvalidInput> =>
  Effect.succeed({ _tag: "Signal", runId, signal: SignalName.toSignalPayload(event) })

/**
 * What a polling source supplies to get a control-plane door.
 *
 * @category models
 * @since 1.0.0
 */
export interface SourceConfig {
  /** The name `Channels.register` and `Channels.ingest` address it by. */
  readonly name: string
  /** What the event does: start a flow, or signal a run. */
  readonly route: (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>
  /** The outbound projection. Defaults to `noop`, which posts nothing. */
  readonly project?: ((run: RunSummary, delivery: unknown) => ReturnType<Channel["project"]>) | undefined
}

/**
 * The control-plane door of one polling source.
 *
 * @category models
 * @since 1.0.0
 */
export interface SourceDoor {
  /** The channel to hand `Channels.register` once, at host startup. */
  readonly channel: Channel
  /**
   * Routes one polled event through `Channels.ingest`, keyed by its dedupe
   * key, and answers with the control plane's receipt.
   */
  readonly ingest: (event: ExternalEvent) => Effect.Effect<Receipt, IntegrationError, Channels>
  /**
   * Routes a batch in order and fails at the first event that was not
   * delivered, so it is the `onBatch` of `Source.runWithCursor`: the cursor
   * advances only past events the control plane took.
   */
  readonly handle: (events: ReadonlyArray<ExternalEvent>) => Effect.Effect<void, IntegrationError, Channels>
}

const SOURCE_PASS_HEADER = "x-smithers-source-pass"
const SOURCE_RECEIVED_HEADER = "x-smithers-source-received-at-ms"
const RETRYABLE_CONTROL_ERRORS: ReadonlyArray<string> = [
  "/control/Unavailable",
  "/control/TransportError",
  "/control/PersistenceError"
]
const sourceEncoder = new TextEncoder()

const sourcePass = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Builds the control-plane door for one polling source.
 *
 * A polled event carries no signature, because nobody sent it: the source
 * fetched it over its own authenticated request. So the door verifies where
 * the event came from instead. Each door holds a random pass that never leaves
 * the process, `ingest` presents it, and the channel refuses every delivery
 * without it with `Unauthorized`. A host that mounts the channel's name on an
 * HTTP route by mistake therefore opens nothing.
 *
 * The idempotency key is the event's dedupe key, and the delivered bytes leave
 * out `receivedAtMs`. A batch polled again after a crash carries the same
 * events with a later receipt time; they answer `AlreadyApplied` instead of
 * starting a second run.
 *
 * `handle` treats two receipts as not delivered. `Parked` means the start
 * waits for a plan approval and has not launched, so the failure is marked
 * retryable and the cursor stays behind the event. `Conflict` means the dedupe
 * key was already used for different content, which another attempt never
 * clears. `Terminal` is delivered: the run a signal addressed has ended, and
 * nothing is left to receive it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fromSource = (config: SourceConfig): SourceDoor => {
  const pass = sourcePass()
  const passBytes = sourceEncoder.encode(pass)
  const refused = (reason: "decode-failed" | "delivery-failed", message: string, details: Record<string, unknown>) =>
    new IntegrationError(reason, message, { channel: config.name, ...details })
  const controlFailure = (error: ControlError): IntegrationError =>
    error._tag === "/control/InvalidInput"
      ? refused("decode-failed", `${config.name} source event is not a valid event.`, { retryable: false })
      : new IntegrationError(
        "delivery-failed",
        `${config.name} source event did not reach the control plane.`,
        { channel: config.name, control: error._tag, retryable: RETRYABLE_CONTROL_ERRORS.includes(error._tag) },
        { cause: error }
      )

  const channel: Channel = {
    name: config.name,
    schema: Schema.Unknown,
    verify: (raw) =>
      constantTimeEqual(passBytes, sourceEncoder.encode(raw.headers[SOURCE_PASS_HEADER] ?? ""))
        ? Effect.void
        : Effect.fail(new Unauthorized({ message: `${config.name} takes events from its polling source only.` })),
    decode: (raw) =>
      Effect.suspend(() =>
        decodeExternalEvent({
          ...JSON.parse(new TextDecoder().decode(raw.body)),
          receivedAtMs: Number(raw.headers[SOURCE_RECEIVED_HEADER])
        })
      ).pipe(
        Effect.mapError(() => new InvalidInput({ issue: `${config.name} source event is not a valid event.` }))
      ),
    map: (event) => config.route(event as ExternalEvent),
    project: config.project ?? noProjection
  }

  const ingest: SourceDoor["ingest"] = (event) =>
    Effect.try({
      // The key order is fixed here, not taken from the event, so a journaled
      // copy and a freshly polled copy of one event are the same bytes.
      try: () =>
        sourceEncoder.encode(JSON.stringify({
          source: event.source,
          eventName: event.eventName,
          correlationId: event.correlationId,
          payload: event.payload,
          dedupeKey: event.dedupeKey
        })),
      catch: () => refused("decode-failed", `${config.name} source event is not JSON.`, { retryable: false })
    }).pipe(
      Effect.flatMap((body) =>
        Effect.flatMap(Channels, (channels) =>
          channels.ingest({
            channel: config.name,
            raw: {
              body,
              headers: { [SOURCE_PASS_HEADER]: pass, [SOURCE_RECEIVED_HEADER]: String(event.receivedAtMs) },
              idempotencyKey: event.dedupeKey
            }
          })).pipe(Effect.mapError(controlFailure))
      ),
      Effect.withSpan("integrations.source.ingest", { attributes: { "smithers.channel": config.name } })
    )

  const handle: SourceDoor["handle"] = (events) =>
    Effect.forEach(events, (event) =>
      Effect.flatMap(ingest(event), (receipt) => {
        if (receipt._tag === "Parked") {
          return Effect.fail(refused(
            "delivery-failed",
            `${config.name} source event waits for a plan approval and has not started its flow.`,
            { retryable: true, planId: receipt.planId }
          ))
        }
        if (receipt._tag === "Conflict") {
          return Effect.fail(refused(
            "delivery-failed",
            `${config.name} source event reuses a dedupe key with different content.`,
            { retryable: false }
          ))
        }
        return Effect.void
      }), { discard: true })

  return { channel, ingest, handle }
}
