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

import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { constTrue } from "effect/Function"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Url from "effect/http/Url"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { valueProblem } from "./Binding.ts"
import { base64, fromBase64, utf8 } from "./internal/bytes.ts"
import * as Placeholder from "./Placeholder.ts"
import * as Scrub from "./Scrub.ts"

/**
 * A secret as one guest holds it: its name, the placeholder this guest has
 * for it, and its binding.
 *
 * @category models
 * @since 0.1.0
 */
export interface Secret {
  readonly name: string
  readonly placeholder: string
  readonly hosts: ReadonlyArray<string>
  /** The methods it may be used with; every method when absent. */
  readonly methods?: ReadonlyArray<string> | undefined
}

/**
 * What one guest may reach: its secrets, and the hosts it may reach with no
 * secret. Every other host is refused.
 *
 * @category models
 * @since 0.1.0
 */
export interface Policy {
  readonly secrets: ReadonlyArray<Secret>
  readonly allow: ReadonlyArray<string>
}

/**
 * The most distinct placeholders one request may carry: 16.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumPlaceholders = 16

/**
 * The most bytes a request's headers may total after substitution, counting
 * each name, value and separator: 64 KiB.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumHeaderBytes = 64 * 1024

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
export const refusals = {
  invalid_url: 400,
  port_not_allowed: 403,
  host_not_allowed: 403,
  unknown_placeholder: 403,
  secret_not_allowed: 403,
  insecure_scheme: 403,
  too_many_placeholders: 403,
  headers_too_large: 431
} as const

/**
 * A refusal's code (see {@link refusals}).
 *
 * @category models
 * @since 0.1.0
 */
export type Refusal = keyof typeof refusals

const RefusalCode = Schema.Literals(Object.keys(refusals) as Array<Refusal>)

/**
 * The egress refused the request before sending it.
 *
 * @category errors
 * @since 0.1.0
 */
export class Refused extends Schema.TaggedError<Refused>()("@smthrs/secrets/Egress/Refused", { code: RefusalCode }) {}

/**
 * The egress couldn't send the request, or got no answer: `secret` when the
 * vault couldn't reveal a value, `value` when a stored value can't go in a
 * header, `audit` when the decision couldn't be recorded, `upstream` when the
 * host didn't answer. It carries nothing of the request.
 *
 * @category errors
 * @since 0.1.0
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("@smthrs/secrets/Egress/Unavailable", {
  code: Schema.Literals(["secret", "value", "audit", "upstream"])
}) {}

/**
 * The answer's body broke off. It carries nothing of the answer.
 *
 * @category errors
 * @since 0.1.0
 */
export class Broken extends Schema.TaggedError<Broken>()("@smthrs/secrets/Egress/Broken", {}) {}

/**
 * The vault couldn't reveal secret `name`'s value.
 *
 * @category errors
 * @since 0.1.0
 */
export class SecretUnavailable extends Schema.TaggedError<SecretUnavailable>()(
  "@smthrs/secrets/Egress/SecretUnavailable",
  { name: Schema.String }
) {}

/**
 * Where values come from: the host's store, which opens a sealed value by
 * name for the one request that needs it.
 *
 * @category services
 * @since 0.1.0
 */
export class Vault extends Context.Service<
  Vault,
  { readonly reveal: (name: string) => Effect.Effect<Redacted.Redacted<string>, SecretUnavailable> }
>()("@smthrs/secrets/Egress/Vault") {}

/**
 * One decision, as the audit records it: never a value, a path or a header.
 *
 * @category models
 * @since 0.1.0
 */
export interface Entry {
  readonly host: string
  readonly method: string
  readonly outcome: "forwarded" | Refusal
  /** The secrets the request used or, refused, carried, by name. */
  readonly secrets: ReadonlyArray<string>
}

/**
 * The audit couldn't record a decision.
 *
 * @category errors
 * @since 0.1.0
 */
export class AuditUnavailable extends Schema.TaggedError<AuditUnavailable>()(
  "@smthrs/secrets/Egress/AuditUnavailable",
  {}
) {}

/**
 * Where decisions are recorded. A forwarded request is recorded before it is
 * sent, and isn't sent when it can't be.
 *
 * @category services
 * @since 0.1.0
 */
export class Audit extends Context.Service<
  Audit,
  { readonly record: (entry: Entry) => Effect.Effect<void, AuditUnavailable> }
>()("@smthrs/secrets/Egress/Audit") {}

/**
 * The host's answer, scrubbed: its status, its headers without hop-by-hop
 * ones, `Content-Encoding` or `Content-Length`, and its body.
 *
 * @category models
 * @since 0.1.0
 */
export interface Answer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Stream.Stream<Uint8Array, Broken>
}

/**
 * {@link execute} calls, by `outcome`: `forwarded` when the answer's body
 * ended, `broken` when it broke off, a {@link Refusal}, or `unavailable_`
 * and the {@link Unavailable} code.
 *
 * @category observability
 * @since 0.1.0
 */
export const requests: Metric.Counter<number> = Metric.counter("secret_egress_requests", {
  description: "Requests through the secrets egress, by outcome",
  incremental: true
})

/** Never forwarded: hop-by-hop headers (RFC 9110 §7.6.1), the host, and the length, which the client sets. */
const dropped: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
])

/** Never answered: hop-by-hop headers, and the encoding and length the client's decoding and scrubbing changed. */
const droppedAnswer: ReadonlySet<string> = new Set([...dropped, "content-encoding"])

const forwardable = (headers: Readonly<Record<string, string>>): Record<string, string> => {
  const named = new Set((headers["connection"] ?? "").toLowerCase().split(",").map((name) => name.trim()))
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!dropped.has(name) && !named.has(name)) kept[name] = value
  }
  return kept
}

const basic = /^basic\s+/i

/** The text a header value holds placeholders in: a Basic credential decoded, any other value as is. */
const readable = (name: string, value: string): string => {
  if (name !== "authorization" || !basic.test(value)) return value
  return fromBase64(value.replace(basic, "").trim()) ?? value
}

/** `value` with each placeholder in `values` replaced, a Basic credential decoded and encoded again. */
const substituted = (name: string, value: string, values: ReadonlyMap<string, string>): string => {
  const swap = (text: string) => {
    let swapped = text
    for (const [placeholder, secret] of values) swapped = swapped.split(placeholder).join(secret)
    return swapped
  }
  if (name === "authorization" && basic.test(value)) {
    const decoded = fromBase64(value.replace(basic, "").trim())
    if (decoded !== undefined) return `Basic ${base64(utf8(swap(decoded)), "standard", true)}`
  }
  return swap(value)
}

/**
 * What {@link decide} allows: the host, and the secrets the request uses.
 *
 * @category models
 * @since 0.1.0
 */
export interface Allowed {
  readonly _tag: "Allowed"
  readonly host: string
  readonly used: ReadonlyArray<Secret>
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
  readonly _tag: "Denied"
  readonly host: string
  readonly code: Refusal
  readonly secrets: ReadonlyArray<string>
}

/**
 * Whether `policy` lets a request with this method, URL and headers go out,
 * before any value is revealed. Header names are lowercase.
 *
 * @category decisions
 * @since 0.1.0
 */
export const decide = (
  request: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> },
  policy: Policy
): Allowed | Denied => {
  // Placeholders first, so every refusal names the secrets the request carried.
  const found = new Set<string>()
  for (const [name, value] of Object.entries(forwardable(request.headers))) {
    for (const placeholder of Placeholder.find(readable(name, value))) found.add(placeholder)
  }
  const known = new Map(policy.secrets.map((secret) => [secret.placeholder, secret]))
  const carried = [...found].flatMap((placeholder) => known.get(placeholder)?.name ?? [])
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return { _tag: "Denied", host: "", code: "invalid_url", secrets: carried }
  }
  const host = url.protocol === "https:" || url.protocol === "http:" ? url.hostname : ""
  const denied = (code: Refusal): Denied => ({ _tag: "Denied", host, code, secrets: carried })
  if (host === "" || url.username !== "" || url.password !== "") return denied("invalid_url")
  if (url.port !== "") return denied("port_not_allowed")
  const bound = policy.secrets.some((secret) => secret.hosts.includes(host))
  if (!bound && !policy.allow.includes(host)) return denied("host_not_allowed")
  if (found.size > maximumPlaceholders) return denied("too_many_placeholders")
  const used: Array<Secret> = []
  for (const placeholder of found) {
    const secret = known.get(placeholder)
    if (secret === undefined) return denied("unknown_placeholder")
    const methods = secret.methods
    if (!secret.hosts.includes(host) || (methods !== undefined && !methods.includes(request.method))) {
      return denied("secret_not_allowed")
    }
    used.push(secret)
  }
  if (used.length > 0 && url.protocol !== "https:") return denied("insecure_scheme")
  return { _tag: "Allowed", host, used }
}

const headerBytes = (headers: Readonly<Record<string, string>>): number => {
  let total = 0
  for (const [name, value] of Object.entries(headers)) total += utf8(name).length + utf8(value).length + 4
  return total
}

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
export const execute = (
  request: HttpClientRequest.HttpClientRequest,
  policy: Policy
): Effect.Effect<Answer, Refused | Unavailable, HttpClient.HttpClient | Vault | Audit> =>
  Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    // The caller's services: its logger, metrics and span, for the outcome an answer's body settles once it has
    // streamed, which a host may do outside the request's services.
    const services = yield* Effect.context<never>()
    const method = request.method
    const url = Url.make(request.url, request.urlParams, undefined).pipe(Result.map((parsed) => parsed.href))
    const decision = decide({
      method,
      url: Result.getOrElse(url, () => ""),
      headers: request.headers
    }, policy)
    const audit = yield* Audit
    const settle = (outcome: string, status: number, secrets: number) =>
      Effect.gen(function*() {
        const durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(requests, { outcome }), 1)
        yield* Effect.logWithLevel(outcome === "forwarded" ? "Info" : "Warn")("secrets.egress").pipe(
          Effect.annotateLogs({ outcome, host: decision.host, method, status, secrets, durationMs })
        )
      })
    yield* Effect.annotateCurrentSpan({ "server.address": decision.host, "http.request.method": method })
    /** The span's outcome and status, while the span is open: a body ends after it closed. */
    const mark = (outcome: string, status: number) =>
      Effect.annotateCurrentSpan({ "smithers.egress.outcome": outcome, "http.response.status_code": status })
    const refuse = (code: Refusal, secrets: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        yield* mark(code, refusals[code])
        // A refusal stands whether or not it is recorded: nothing is sent either way.
        yield* audit.record({ host: decision.host, method, outcome: code, secrets }).pipe(Effect.ignore)
        yield* settle(code, refusals[code], secrets.length)
        return yield* new Refused({ code })
      })
    const unavailable = (code: Unavailable["code"], secrets: number) => {
      const status = code === "upstream" ? 502 : 503
      return mark(`unavailable_${code}`, status).pipe(
        Effect.andThen(settle(`unavailable_${code}`, status, secrets)),
        Effect.andThen(Effect.fail(new Unavailable({ code })))
      )
    }

    if (decision._tag === "Denied") return yield* refuse(decision.code, decision.secrets)
    const { used } = decision
    const vault = yield* Vault
    const revealed = yield* Effect.forEach(policy.secrets, (secret) =>
      Effect.map(vault.reveal(secret.name), (value) => ({ secret, value }))).pipe(
        // Any other failure, a defect included, is the vault's and fails closed.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined)
        )
      )
    if (revealed === undefined) return yield* unavailable("secret", used.length)
    const values = new Map<string, string>()
    for (const { secret, value } of revealed) {
      if (!used.includes(secret)) continue
      if (valueProblem(Redacted.value(value)) !== undefined) return yield* unavailable("value", used.length)
      values.set(secret.placeholder, Redacted.value(value))
    }
    const scrubber = Scrub.make(revealed.map(({ secret, value }) => ({ value, replacement: secret.placeholder })))

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(forwardable(request.headers))) {
      headers[name] = substituted(name, value, values)
    }
    if (scrubber.active) {
      headers["accept-encoding"] = "identity"
      delete headers["range"]
      delete headers["if-range"]
    }
    if (headerBytes(headers) > maximumHeaderBytes) {
      return yield* refuse("headers_too_large", used.map((secret) => secret.name))
    }

    const recorded = yield* audit.record({
      host: decision.host,
      method,
      outcome: "forwarded",
      secrets: used.map((secret) => secret.name)
    }).pipe(Effect.option)
    if (Option.isNone(recorded)) return yield* unavailable("audit", used.length)

    const client = yield* HttpClient.HttpClient
    const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit)
    const outgoing = requestWithMethod(method, Result.getOrThrow(url), headers, request.body)
    const sent = yield* client.execute(outgoing).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { ...Option.getOrUndefined(init), redirect: "manual" }),
      Effect.provideService(HttpClient.TracerDisabledWhen, constTrue),
      // The client's error holds the substituted request: dropped here, whole, so no value reaches a failure.
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined))
    )
    if (sent === undefined) return yield* unavailable("upstream", used.length)
    yield* mark("forwarded", sent.status)

    const answered: Record<string, string> = {}
    for (const [name, value] of Object.entries(sent.headers)) {
      if (!droppedAnswer.has(name)) answered[name] = scrubber.text(value)
    }
    const body = scrubber.stream(
      sent.stream.pipe(
        // The client's error holds the request: dropped here. Fetch answers a bodiless response, such as a
        // redirect's, with no body at all, which reaches the guest as an empty one.
        Stream.catch((error): Stream.Stream<never, Broken> =>
          error.reason._tag === "EmptyBodyError" ? Stream.empty : Stream.fail(new Broken())
        )
      )
    ).pipe(
      Stream.onExit((exit) =>
        settle(Exit.isSuccess(exit) ? "forwarded" : "broken", sent.status, used.length).pipe(
          Effect.provideContext(services)
        )
      )
    )
    return { status: sent.status, headers: answered, body }
  }).pipe(Effect.withSpan("Egress.execute", { kind: "client" }))

/** Statuses whose answer has no body (RFC 9110 §6.4.1). */
const bodiless: ReadonlySet<number> = new Set([204, 205, 304])

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
export const forward = (
  request: HttpServerRequest.HttpServerRequest,
  policy: Policy
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpClient.HttpClient | Vault | Audit> => {
  const method = request.method
  const body = method === "GET" || method === "HEAD"
    ? HttpBody.empty
    : HttpBody.stream(request.stream, request.headers["content-type"])
  const outgoing = requestWithMethod(method, request.originalUrl, request.headers, body)
  return execute(outgoing, policy).pipe(
    Effect.map((answer) =>
      method === "HEAD" || bodiless.has(answer.status)
        ? HttpServerResponse.empty({ status: answer.status, headers: answer.headers })
        : HttpServerResponse.stream(answer.body, { status: answer.status, headers: answer.headers })
    ),
    Effect.catchTags({
      "@smthrs/secrets/Egress/Refused": (refused) =>
        Effect.succeed(HttpServerResponse.text(refused.code, { status: refusals[refused.code] })),
      "@smthrs/secrets/Egress/Unavailable": (failed) =>
        Effect.succeed(HttpServerResponse.text(failed.code, { status: failed.code === "upstream" ? 502 : 503 }))
    })
  )
}

/** Preserves extension methods while normalizing request components through Effect. */
const requestWithMethod = (
  method: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: HttpBody.HttpBody
) => {
  const normalized = HttpClientRequest.get(url, { headers, body })
  return HttpClientRequest.makeWith(
    method,
    normalized.url,
    normalized.urlParams,
    normalized.hash,
    normalized.headers,
    normalized.body
  )
}
