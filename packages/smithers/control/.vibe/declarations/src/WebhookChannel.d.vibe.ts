/**
 * Webhook channel construction over Effect's transport-neutral HTTP request.
 *
 * @since 0.1.0
 */
import { Effect, type Redacted, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { type Channel, Channels, type InboundResult, type RawInbound } from "./Channels.vibe";
import { InvalidInput, type Unauthorized } from "../../../src/ControlError.ts";
import type { IdempotencyKey } from "../../../src/ControlSchema.ts";
import type { CredentialRef } from "./Credential.vibe";
/**
 * Signature verifier injected by a webhook transport.
 *
 * The credential is intentionally a redacted reference. Resolution belongs at
 * the host adapter boundary, never in webhook input or its persisted record.
 *
 * @category models
 * @since 0.1.0
 */
export type SignatureVerifier = (raw: RawInbound, credential: Redacted.Redacted<CredentialRef>) => Effect.Effect<void, Unauthorized>;
/**
 * Configuration for a schema-declared webhook channel.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config<A> {
    readonly name: string;
    readonly schema: Schema.Schema<A>;
    readonly credential: Redacted.Redacted<CredentialRef>;
    readonly fingerprintHeaders?: Channel<A>["fingerprintHeaders"];
    readonly verify: SignatureVerifier;
    readonly map: (payload: A) => Effect.Effect<InboundResult, InvalidInput>;
    readonly project: Channel<A>["project"];
}
/**
 * Largest webhook request body one mount reads by default, in bytes.
 *
 * A webhook is the one control-plane ingress a bearer holder reaches with an
 * arbitrary payload, and `handler` used to materialize whatever arrived before
 * anything looked at its size. The default is deliberately smaller than the
 * 4 MiB mutation-identity budget in `internal/mutationBoundary.ts`: a body that
 * cannot become a durable mutation is refused at the door rather than copied,
 * decoded, and refused later.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumBodyBytes: number;
/**
 * Per-mount overrides for the webhook request handler.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HandlerOptions {
    /**
     * Body ceiling for this mount, a non-negative finite byte count. Defaults
     * to `maximumBodyBytes`. Any other value is a mount defect: the handler
     * dies before reading the body.
     */
    readonly maximumBodyBytes?: number | undefined;
}
/**
 * Builds a webhook channel. Verification receives raw bytes and headers before
 * JSON parsing and schema decoding. A body that is not valid UTF-8 JSON is
 * refused as `InvalidInput` rather than decoded with replacement characters.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <A>(config: Config<A>) => Channel<A>;
/**
 * Reads an abstract Effect HTTP request and dispatches it through Channels.
 * This is mountable by any Effect HTTP host; it contains no Node transport
 * dependencies.
 *
 * The body is bounded twice. A `content-length` over the limit is refused
 * before the body is read at all, so a declared flood costs nothing; the
 * measured length is checked before retaining each streamed chunk. Reading
 * stops at the first chunk exceeding the limit, including when the caller
 * understates or omits the length. Both refusals are `InvalidInput` naming the
 * two byte counts and no body content. A `maximumBodyBytes` option that is
 * negative, `NaN`, or infinite is a defect and dies before the body is read.
 *
 * @category handlers
 * @since 0.1.0
 */
export declare const handler: (channel: string, idempotencyKey: IdempotencyKey, options?: HandlerOptions | undefined) => Effect.Effect<{
    readonly _tag: "Conflict";
    readonly message: string;
} | {
    readonly _tag: "Parked";
    readonly receiptId: string;
    readonly planId: string;
    readonly status: "waiting-approval";
} | {
    readonly _tag: "Terminal";
    readonly runId: string;
    readonly status: "accepted" | "cancelled" | "completed" | "failed" | "parked" | "running" | "waiting-approval";
} | {
    readonly _tag: "Accepted";
    readonly inputConsumed?: boolean | undefined;
    readonly inputBody?: string | undefined;
    readonly receiptId: string;
    readonly runId?: string | undefined;
    readonly handedTo?: {
        readonly hostId: string;
        readonly pid: number;
    } | undefined;
} | {
    readonly _tag: "AlreadyApplied";
    readonly receiptId: string;
    readonly runId?: string | undefined;
    readonly inputConsumed?: boolean | undefined;
    readonly inputBody?: string | undefined;
}, import("../../../src/ControlError.ts").AlreadyResolved | import("../../../src/ControlError.ts").ClaimLost | import("../../../src/ControlError.ts").CodeDrift | import("../../../src/ControlError.ts").CredentialConflict | import("../../../src/ControlError.ts").EnvelopeMismatch | import("../../../src/ControlError.ts").FlowNotFound | import("effect/http/HttpServerError").HttpServerError | InvalidInput | import("../../../src/ControlError.ts").LaunchFailed | import("../../../src/ControlError.ts").NoMatchingWait | import("@smthrs/notifications/NotificationQueue").NotificationError | import("../../../src/ControlError.ts").PersistenceError | import("../../../src/ControlError.ts").PlanDenied | import("../../../src/ControlError.ts").PlanDigestMismatch | import("../../../src/ControlError.ts").PlanNotFound | import("../../../src/ControlError.ts").RunNotFound | import("../../../src/ControlError.ts").TransportError | Unauthorized | import("../../../src/ControlError.ts").Unavailable, Channels | HttpServerRequest.HttpServerRequest>;
