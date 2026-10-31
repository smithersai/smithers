/**
 * The egress: where a guest's outbound HTTP request gets a secret's value in
 * place of its placeholder, only for that secret's own hosts, and where the
 * answer loses every echo of a value before the guest reads it.
 *
 * A guest (a sandbox, or a flow step) holds placeholders and never a value.
 * Each request it sends reaches {@link execute} (a flow step's
 * `HttpClientRequest`) or {@link forward} (a sandbox's intercepted request),
 * which, against the guest's {@link Policy}:
 *
 * 1. refuses a URL with credentials in it, a port other than the scheme's
 *    own, or a host neither the policy's `allow` list nor any secret's
 *    binding names;
 * 2. finds placeholders in the request's header values, a Basic credential
 *    decoded first, and refuses a placeholder the policy doesn't know, one
 *    whose secret isn't bound to the host or the method, more than
 *    {@link maximumPlaceholders}, and any placeholder over plain HTTP;
 * 3. reveals the values of every secret in the policy through the host's
 *    {@link Vault}: the ones it found, to substitute, and the rest, to scrub;
 * 4. puts each value in place of its placeholder in the header values only.
 *    A placeholder in the URL or the body reaches the host as the
 *    placeholder. The request's headers may total at most
 *    {@link maximumHeaderBytes} after substitution;
 * 5. records the decision through the host's {@link Audit}: the host, the
 *    method, the outcome and the secrets' names, never a value. A request it
 *    can't record is not sent;
 * 6. sends it with the host's `HttpClient`, never following a redirect: a
 *    3xx goes back to the guest, whose next request is checked again, so a
 *    redirect to another host never gets a value. With a Fetch client the
 *    egress sets `redirect: "manual"` itself; another client must not follow
 *    redirects. The client's own span is off, so no header reaches a trace;
 * 7. scrubs the answer's headers and body of every form of every value in
 *    the policy ({@link Scrub}), whichever host it comes from, since a host
 *    may read what another host was sent. To keep echoes findable it asks for
 *    an uncompressed answer and drops the guest's `Range` and `If-Range`, so
 *    a host can't return a value in slices too short to match. A Fetch client
 *    decodes a compressed answer anyway, so the egress drops
 *    `Content-Encoding` and `Content-Length`.
 *
 * Telemetry carries the host, the method, the outcome, the status and the
 * number of secrets; failures carry a code and nothing of the request. Each
 * request is one `Egress.execute` span and one count on
 * `secret_egress_requests` by `outcome`, recorded when the answer's body has
 * ended.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
/**
 * A secret as one guest holds it: its name, the placeholder this guest has
 * for it, and its binding.
 *
 * @category models
 * @since 0.1.0
 */
export interface Secret {
    readonly name: string;
    readonly placeholder: string;
    readonly hosts: ReadonlyArray<string>;
    /** The methods it may be used with; every method when absent. */
    readonly methods?: ReadonlyArray<string> | undefined;
}
/**
 * What one guest may reach: its secrets, and the hosts it may reach with no
 * secret. Every other host is refused.
 *
 * @category models
 * @since 0.1.0
 */
export interface Policy {
    readonly secrets: ReadonlyArray<Secret>;
    readonly allow: ReadonlyArray<string>;
}
/**
 * The most distinct placeholders one request may carry: 16.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumPlaceholders = 16;
/**
 * The most bytes a request's headers may total after substitution, counting
 * each name, value and separator: 64 KiB.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumHeaderBytes: number;
/**
 * Why the egress refused a request, with the status a guest gets for it.
 *
 * - `invalid_url`: not an absolute `http:` or `https:` URL, or one with a
 *   user or password in it.
 * - `port_not_allowed`: a port other than the scheme's own.
 * - `host_not_allowed`: a host neither `allow` nor any secret names.
 * - `unknown_placeholder`: a placeholder the policy doesn't know, such as an
 *   earlier generation's.
 * - `secret_not_allowed`: a secret not bound to this host or method.
 * - `insecure_scheme`: a placeholder over plain HTTP.
 * - `too_many_placeholders`: more than {@link maximumPlaceholders}.
 * - `headers_too_large`: headers over {@link maximumHeaderBytes} once
 *   substituted.
 *
 * @category models
 * @since 0.1.0
 */
export declare const refusals: {
    readonly invalid_url: 400;
    readonly port_not_allowed: 403;
    readonly host_not_allowed: 403;
    readonly unknown_placeholder: 403;
    readonly secret_not_allowed: 403;
    readonly insecure_scheme: 403;
    readonly too_many_placeholders: 403;
    readonly headers_too_large: 431;
};
/**
 * A refusal's code (see {@link refusals}).
 *
 * @category models
 * @since 0.1.0
 */
export type Refusal = keyof typeof refusals;
declare const Refused_base: Schema.Class<Refused, Schema.TaggedStruct<"@smthrs/secrets/Egress/Refused", {
    readonly code: Schema.Literals<("headers_too_large" | "host_not_allowed" | "insecure_scheme" | "invalid_url" | "port_not_allowed" | "secret_not_allowed" | "too_many_placeholders" | "unknown_placeholder")[]>;
}>, Cause.YieldableError>;
/**
 * The egress refused the request before sending it.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class Refused extends Refused_base {
}
declare const Unavailable_base: Schema.Class<Unavailable, Schema.TaggedStruct<"@smthrs/secrets/Egress/Unavailable", {
    readonly code: Schema.Literals<readonly ["secret", "value", "audit", "upstream"]>;
}>, Cause.YieldableError>;
/**
 * The egress couldn't send the request, or got no answer: `secret` when the
 * vault couldn't reveal a value, `value` when a stored value can't go in a
 * header, `audit` when the decision couldn't be recorded, `upstream` when the
 * host didn't answer. It carries nothing of the request.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class Unavailable extends Unavailable_base {
}
declare const Broken_base: Schema.Class<Broken, Schema.TaggedStruct<"@smthrs/secrets/Egress/Broken", {}>, Cause.YieldableError>;
/**
 * The answer's body broke off. It carries nothing of the answer.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class Broken extends Broken_base {
}
declare const SecretUnavailable_base: Schema.Class<SecretUnavailable, Schema.TaggedStruct<"@smthrs/secrets/Egress/SecretUnavailable", {
    readonly name: Schema.String;
}>, Cause.YieldableError>;
/**
 * The vault couldn't reveal secret `name`'s value.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class SecretUnavailable extends SecretUnavailable_base {
}
declare const Vault_base: Context.ServiceClass<Vault, "@smthrs/secrets/Egress/Vault", {
    readonly reveal: (name: string) => Effect.Effect<Redacted.Redacted<string>, SecretUnavailable>;
}>;
/**
 * Where values come from: the host's store, which opens a sealed value by
 * name for the one request that needs it.
 *
 * @category services
 * @since 0.1.0
 */
export declare class Vault extends Vault_base {
}
/**
 * One decision, as the audit records it: never a value, a path or a header.
 *
 * @category models
 * @since 0.1.0
 */
export interface Entry {
    readonly host: string;
    readonly method: string;
    readonly outcome: "forwarded" | Refusal;
    /** The secrets the request used or, refused, carried, by name. */
    readonly secrets: ReadonlyArray<string>;
}
declare const AuditUnavailable_base: Schema.Class<AuditUnavailable, Schema.TaggedStruct<"@smthrs/secrets/Egress/AuditUnavailable", {}>, Cause.YieldableError>;
/**
 * The audit couldn't record a decision.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class AuditUnavailable extends AuditUnavailable_base {
}
declare const Audit_base: Context.ServiceClass<Audit, "@smthrs/secrets/Egress/Audit", {
    readonly record: (entry: Entry) => Effect.Effect<void, AuditUnavailable>;
}>;
/**
 * Where decisions are recorded. A forwarded request is recorded before it is
 * sent, and isn't sent when it can't be.
 *
 * @category services
 * @since 0.1.0
 */
export declare class Audit extends Audit_base {
}
/**
 * The host's answer, scrubbed: its status, its headers without hop-by-hop
 * ones, `Content-Encoding` or `Content-Length`, and its body.
 *
 * @category models
 * @since 0.1.0
 */
export interface Answer {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Stream.Stream<Uint8Array, Broken>;
}
/**
 * {@link execute} calls, by `outcome`: `forwarded` when the answer's body
 * ended, `broken` when it broke off, a {@link Refusal}, or `unavailable_`
 * and the {@link Unavailable} code.
 *
 * @category observability
 * @since 0.1.0
 */
export declare const requests: Metric.Counter<number>;
/**
 * What {@link decide} allows: the host, and the secrets the request uses.
 *
 * @category models
 * @since 0.1.0
 */
export interface Allowed {
    readonly _tag: "Allowed";
    readonly host: string;
    readonly used: ReadonlyArray<Secret>;
}
/**
 * What {@link decide} refuses, the host when the URL named one, and the
 * secrets whose placeholders the request carried, by name: the audit's
 * record of where a secret was sent.
 *
 * @category models
 * @since 0.1.0
 */
export interface Denied {
    readonly _tag: "Denied";
    readonly host: string;
    readonly code: Refusal;
    readonly secrets: ReadonlyArray<string>;
}
/**
 * Whether `policy` lets a request with this method, URL and headers go out,
 * before any value is revealed. Header names are lowercase.
 *
 * @category decisions
 * @since 0.1.0
 */
export declare const decide: (request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
}, policy: Policy) => Allowed | Denied;
/**
 * Sends `request` for a guest under `policy`, with its placeholders' values
 * in its headers, and answers the host's answer scrubbed. Fails with
 * {@link Refused} before anything is revealed or sent, or with
 * {@link Unavailable}. Requires the host's `HttpClient`, {@link Vault} and
 * {@link Audit}.
 *
 * @category egress
 * @since 0.1.0
 */
export declare const execute: (request: HttpClientRequest.HttpClientRequest, policy: Policy) => Effect.Effect<Answer, Refused | Unavailable, HttpClient.HttpClient | Vault | Audit>;
/**
 * Answers a guest's intercepted request through {@link execute}: the host's
 * answer, scrubbed, or the refusal's code as text with its status (see
 * {@link refusals}), 503 when a secret or the audit was unavailable, and 502
 * when the host didn't answer. The request's URL must be absolute, as an
 * intercepted request's is.
 *
 * @category egress
 * @since 0.1.0
 */
export declare const forward: (request: HttpServerRequest.HttpServerRequest, policy: Policy) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpClient.HttpClient | Vault | Audit>;
export {};
