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
 * `RawInbound` it hands `ingest`; each provider module exports the
 * `idempotencyKey` that derives it from that provider's delivery identity, and
 * an ingress that does not pass one has no redelivery protection.
 *
 * The decoder's output is validated against `ExternalEvent` before it leaves
 * this module, so a decoder bug fails on the delivery that triggered it.
 *
 * @since 1.0.0
 */
import type { Channel, InboundResult, RawInbound } from "@smthrs/control/Channels";
import { InvalidInput, Unauthorized } from "@smthrs/control/ControlError";
import type { FlowId, RunId, RunSummary } from "@smthrs/control/ControlSchema";
import type { Credential, CredentialRef } from "@smthrs/control/Credential";
import { Effect, Redacted } from "effect";
import { type ExternalEvent } from "./ExternalEvent.vibe";
/**
 * How a channel obtains the signing secret behind a credential reference.
 *
 * Resolution is a host concern: the reference is journal-safe, the secret is
 * not, and only the host knows where it lives.
 *
 * @category models
 * @since 1.0.0
 */
export type SecretResolver = (credential: Redacted.Redacted<CredentialRef>) => Effect.Effect<Redacted.Redacted<string>, Unauthorized>;
/**
 * A resolver that always answers with one secret. For a single-tenant
 * deployment that reads its webhook secret from the environment.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const constantSecret: (secret: Redacted.Redacted<string>) => SecretResolver;
/**
 * A resolver backed by the control plane's credential store.
 *
 * Takes the resolved service rather than requiring it, because a channel's
 * verifier runs with no environment of its own.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const credentialSecret: (credentials: Credential) => SecretResolver;
/**
 * What a provider supplies to get a control-plane channel.
 *
 * @category models
 * @since 1.0.0
 */
export interface Config {
    /** The name `Channels.register` and `Channels.ingest` address it by. */
    readonly name: string;
    /** The journal-safe reference to the signing secret. */
    readonly credential: Redacted.Redacted<CredentialRef>;
    readonly secret: SecretResolver;
    /** Non-secret headers whose values affect the decoded event. */
    readonly fingerprintHeaders?: ReadonlyArray<string> | undefined;
    /**
     * The provider's signature check over the exact delivered bytes, as a
     * boolean or as an Effect such as `Signature.verifySignature` returns.
     *
     * A verifier that throws, or whose Effect fails or dies, is treated as a
     * failed verification: the delivery is refused with `Unauthorized`, not
     * turned into a defect that kills the ingress fiber. Only `true` verifies.
     */
    readonly verify: (raw: RawInbound, secret: string) => boolean | Effect.Effect<boolean, unknown>;
    /**
     * The provider's decoder. Runs only after verification, and may throw an
     * `IntegrationError` for a delivery whose headers or body it cannot read.
     */
    readonly decode: (raw: RawInbound, payload: unknown) => ExternalEvent;
    /** What the event does: start a flow, or signal a run. */
    readonly route: (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>;
    /** The outbound projection. Defaults to `noop`, which posts nothing. */
    readonly project?: ((run: RunSummary, delivery: unknown) => ReturnType<Channel["project"]>) | undefined;
}
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
export declare const make: (config: Config) => Channel;
/**
 * A route that starts `flowId` with the event as its input.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const startFlow: (flowId: FlowId) => (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>;
/**
 * A route that signals `runId` with the event's signal name and payload.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const signalRun: (runId: RunId) => (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>;
