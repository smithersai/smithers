/**
 * The provider-neutral failure vocabulary, and the refinements that recognize
 * a context overflow and an exhausted account in a provider's own wording.
 *
 * A consumer branches on `ModelError.code`. Provider message text is not a
 * contract, and reading it is the mistake these codes exist to prevent.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import type { Timing } from "./ModelEvent.js";
/**
 * The provider-neutral failure vocabulary. A consumer branches on these
 * codes; provider message text is not a contract.
 *
 * All but one describe something the provider did. `call_timeout` describes
 * what the caller did: it exceeded a wall-clock budget it declared for the
 * call and interrupted the request itself, so the request never settled and
 * nothing about it is known. It is a distinct code rather than `transport`
 * because the two are repaired differently — a transport failure is waited
 * out unchanged, and an overrun is re-issued with the model told to be
 * shorter.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ModelErrorCode: Schema.Literals<readonly ["invalid_request", "context_overflow", "no_route", "authentication", "rate_limited", "quota_exceeded", "out_of_credit", "content_policy", "provider_internal", "transport", "call_timeout", "invalid_provider_output", "unknown"]>;
/**
 * The decoded form of {@link ModelErrorCode}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ModelErrorCode = typeof ModelErrorCode.Type;
/**
 * Whether a provider's own error code and message describe a context overflow.
 *
 * Protocol adapters call this while classifying a wire failure, ahead of the
 * generic `invalid_request` branch, so overflow reaches consumers as a typed
 * code rather than as text they would have to re-parse.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export declare const isContextOverflow: (providerCode: string | undefined, message: string) => boolean;
/**
 * Whether a provider's own error code and message describe an exhausted
 * account balance or quota rather than a transient rate limit.
 *
 * Protocol adapters call this before their generic bad-request and rate-limit
 * branches so a durable consumer can park the run until the account is funded
 * instead of retrying or terminating it as malformed.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export declare const isQuotaExhausted: (providerCode: string | undefined, message: string) => boolean;
declare const ModelError_base: Schema.Class<ModelError, Schema.TaggedStruct<"flows/model/ModelError", {
    readonly code: Schema.Literals<readonly ["invalid_request", "context_overflow", "no_route", "authentication", "rate_limited", "quota_exceeded", "out_of_credit", "content_policy", "provider_internal", "transport", "call_timeout", "invalid_provider_output", "unknown"]>;
    readonly message: Schema.String;
    readonly path: Schema.optional<Schema.String>;
    readonly retryAfterMillis: Schema.optional<Schema.Number>;
    readonly resetAtEpochMillis: Schema.optional<Schema.Number>;
    readonly resetSource: Schema.optional<Schema.String>;
    readonly quotaScope: Schema.optional<Schema.Literals<readonly ["model", "account"]>>;
    readonly providerCode: Schema.optional<Schema.String>;
    readonly requestId: Schema.optional<Schema.String>;
    readonly httpStatus: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/**
 * Normalized provider failure. Its fields intentionally exclude credentials,
 * headers, request bodies, and client objects.
 *
 * `code` is the stable serialized field and the public error contract; the
 * table of codes and their meanings is in `packages/smithers/agent/model/docs/api.md`. There
 * is no separate `reason` field: this package deliberately flattens opencode's
 * tagged reason union into one literal code set plus typed optional detail
 * fields, so a consumer branches on one value instead of destructuring a union.
 * Kernel permission and journal failures are separate typed error classes,
 * never `ModelError` codes.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class ModelError extends ModelError_base {
    /**
     * The failed provider response body, redacted and capped at 16 KiB, present
     * only on an error the shared request executor raised from an HTTP response.
     *
     * It is deliberately outside the schema above and defined non-enumerably, so
     * a journal, a `JSON.stringify`, and a structural comparison all see the same
     * value they saw before it existed: a provider body is diagnostic text, not
     * durable state, and copying it into a run's history is how a long body
     * becomes a permanent one.
     */
    readonly body: string | undefined;
    /**
     * Whether {@link body} is a prefix of what the provider sent, either because
     * the read stopped at 64 KiB or because the redacted text exceeded the 16 KiB
     * kept here.
     */
    readonly bodyTruncated: boolean | undefined;
    /**
     * Where the failed call's time went on the wire, present only on an error a
     * route raised: the tries it made, when each was sent and failed, and how
     * far the response got. Outside the schema and non-enumerable, like
     * {@link body}: a reading is a diagnostic of one failure, not part of what
     * the failure is.
     */
    readonly timing: Timing | undefined;
    /** @category getters @since 0.1.0 */
    get retryable(): boolean;
}
/**
 * Whether a refusal requires intervention rather than a quota cooldown.
 * A model-scoped quota or a named reset can recover; terminal HTTP statuses
 * and exhausted credit cannot be waited out.
 * @category classification
 * @since 1.0.0-rc.1
 */
export declare const isTerminalRefusal: (error: Pick<ModelError, "code" | "httpStatus" | "quotaScope" | "resetAtEpochMillis" | "retryAfterMillis">) => boolean;
/**
 * Whose problem each model failure is. The request is our agent's own
 * construction, so a rejected or overflowing one is the factory's, never the
 * person's; a limit is a wait, and a call that ran past its own deadline is a
 * dependency another seat or a retry may answer.
 *
 * @category constants
 * @since 1.0.0-rc.16
 */
export declare const faults: {
    readonly invalid_request: "factory";
    readonly context_overflow: "factory";
    readonly no_route: "dependency";
    readonly authentication: "user";
    readonly rate_limited: "wait";
    readonly quota_exceeded: "wait";
    readonly out_of_credit: "user";
    readonly content_policy: "user";
    readonly provider_internal: "dependency";
    readonly transport: "dependency";
    readonly call_timeout: "dependency";
    readonly invalid_provider_output: "dependency";
    readonly unknown: "dependency";
};
export {};
