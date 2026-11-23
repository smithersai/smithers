/**
 * Permission-aware outgoing HTTP requests.
 *
 * There is no kernel `HttpClient` interface and no kernel `HttpClient` tag.
 * Effect owns both, and its tag fixes the error channel to `HttpClientError`,
 * so this module is only the middleware: a `Layer` over Effect's own tag that
 * reads the raw client out of context and returns a guarded one in its place.
 * Permission failures are projected into `HttpClientError` by
 * {@link toHttpClientError}, which keeps the structured kernel failure on the
 * transport reason's `cause` so {@link fromHttpClientError} can hand it back.
 *
 * **Redirects.** A redirect is a second network destination, so it needs a
 * second grant check. Two halves guarantee that:
 *
 *  1. The client below this layer must **not** follow redirects on its own.
 *     That is a precondition on the host: Undici without a redirect
 *     interceptor, or Effect's fetch layer with `redirect: "manual"`. This
 *     layer also forces `RequestInit { redirect: "manual" }` over the ambient
 *     value for every request it executes, so a plain `FetchHttpClient.layer`,
 *     which follows redirects by default, cannot walk to another origin below
 *     the guard either. A custom client that ignores `RequestInit` must meet
 *     the precondition itself.
 *  2. This layer composes Effect's own `HttpClient.followRedirects` *above*
 *     the guard. That combinator re-enters `postprocess` for every hop, and
 *     `postprocess` is the guarded one, so hop *n* is checked exactly like hop
 *     zero and an authorized origin cannot lend its grant to another.
 *     A caller that sets `FetchHttpClient.RequestInit.redirect` to `manual`
 *     receives one guarded hop and owns any further redirect requests itself.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */

import type { Capability } from "@smthrs/capability/Capability"
import {
  formatError,
  isPermissionError,
  PermissionDenied,
  type PermissionError,
  type PermissionErrorPayload
} from "@smthrs/capability/Permission"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Headers from "effect/http/Headers"
import * as HttpBody from "effect/http/HttpBody"
import * as EffectHttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as UrlParams from "effect/http/UrlParams"
import { GrantStore, type Service as GrantService } from "./GrantStore.ts"
import { makeCapability } from "./internal/makeCapability.ts"

const snapshotRawBody = (value: unknown): unknown => {
  if (value instanceof globalThis.Uint8Array) return value.slice()
  if (value instanceof ArrayBuffer) return value.slice(0)
  if (value instanceof URLSearchParams) {
    return new URLSearchParams(value)
  }
  if (value instanceof Blob) return value
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  throw new TypeError("raw HTTP bodies must be immutable or copyable")
}

const snapshotBody = (body: HttpBody.HttpBody): HttpBody.HttpBody => {
  switch (body._tag) {
    case "Empty":
      return HttpBody.empty
    case "Raw":
      return HttpBody.raw(snapshotRawBody(body.body), {
        contentType: body.contentType,
        contentLength: body.contentLength
      })
    case "Uint8Array":
      return HttpBody.uint8Array(body.body.slice(), body.contentType)
    case "FormData": {
      const formData = new FormData()
      for (const [name, value] of body.formData.entries()) formData.append(name, value)
      return HttpBody.formData(formData)
    }
    case "Stream":
      return HttpBody.stream(body.stream, body.contentType, body.contentLength)
  }
}

const snapshotRequest = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.makeWith(
    request.method,
    request.url,
    UrlParams.make(
      Object.freeze(request.urlParams.params.map(([name, value]) => Object.freeze([name, value] as const)))
    ),
    Option.map(request.hash, (value) => value),
    Headers.fromInput(request.headers),
    snapshotBody(request.body)
  )

const invalidRequest = (request: HttpClientRequest.HttpClientRequest): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: "HTTP request must be an immutable supported request description"
    })
  })

/**
 * Effect's own outgoing HTTP client tag, unchanged. Re-exported so the kernel
 * namespace stays one-stop; it is the *same* tag, never a second one.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export { HttpClient } from "effect/http/HttpClient"

/**
 * Constructs a client from a low-level request runner, keeping Effect's own
 * URL construction, tracing, header redaction, and interruption behavior.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export { make } from "effect/http/HttpClient"

/**
 * The model id the caller of an outgoing request said it is for, if any.
 *
 * This reference is information, never authority. {@link withModelCall} sets
 * it so a transport or a trace can read the caller's intent; the guard does
 * not read it. A value another module provides here changes nothing about how
 * a request is checked: it stays `net:get` or `net:post`.
 *
 * @category references
 * @since 1.0.0-rc.0
 */
export const ModelCall: Context.Reference<string | undefined> = Context.Reference<string | undefined>(
  "@smthrs/kernel/HttpClient/ModelCall",
  { defaultValue: (): string | undefined => undefined }
)

/**
 * A model-call claim. Only {@link withModelCall} mints one, and the guard
 * accepts only the objects it minted: a look-alike handed to a reference with
 * the same key is not in {@link claims} and is ignored.
 */
interface ModelClaim {
  readonly modelId: string
}

const claims = new WeakSet<ModelClaim>()

const Claim = Context.Reference<ModelClaim | undefined>("@smthrs/kernel/HttpClient/ModelClaim", {
  defaultValue: () => undefined
})

/**
 * Reads the model one outgoing request provably asks its endpoint for, or
 * `undefined` when the request does not name one.
 *
 * The guard asks this of the exact request it is about to send, after the
 * request was snapshotted, so the answer cannot go stale. It is trusted code:
 * {@link layerWith} captures it when the host builds the layer, and nothing a
 * caller provides later replaces it.
 *
 * @category model calls
 * @since 1.0.0
 */
export type ModelIdentity = (request: HttpClientRequest.HttpClientRequest) => string | undefined

/** How many keys of the JSON object `text` holds, at its top level, spell `key`. */
const countTopLevelKey = (text: string, key: string): number => {
  let depth = 0
  let count = 0
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === "\"") {
      let end = index + 1
      while (text[end] !== "\"") end += text[end] === "\\" ? 2 : 1
      if (depth === 1 && JSON.parse(text.slice(index, end + 1)) === key && /^\s*:/.test(text.slice(end + 1))) {
        count += 1
      }
      index = end + 1
    } else {
      if (char === "{" || char === "[") depth += 1
      else if (char === "}" || char === "]") depth -= 1
      index += 1
    }
  }
  return count
}

/**
 * The default {@link ModelIdentity}: the `model` string at the top level of a
 * `POST` request's JSON body, which is where the Anthropic Messages, OpenAI
 * Chat Completions and OpenAI Responses protocols name the model.
 *
 * It answers `undefined` for every other method, for a body that is not
 * in-memory bytes holding one JSON object, and for a body that spells `model`
 * more than once at the top level, because two parsers may disagree about
 * which spelling wins.
 *
 * It reads the body and not the path, so on its own it does not tell a model
 * endpoint from another `POST` endpoint of the same host that accepts a
 * `model` field. Pin the endpoints with {@link modelEndpoints} to close that.
 *
 * @category model calls
 * @since 1.0.0
 */
export const declaredModel: ModelIdentity = (request) => {
  if (request.method !== "POST" || request.body._tag !== "Uint8Array") return undefined
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(request.body.body)
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const model: unknown = Object.hasOwn(parsed, "model") ? (parsed as { readonly model: unknown }).model : undefined
  return typeof model === "string" && countTopLevelKey(text, "model") === 1 ? model : undefined
}

/**
 * A {@link ModelIdentity} for a protocol that names the model in a request
 * header, such as the AI gateway's `ai-model-id`. A header says nothing about
 * the endpoint, so use it only inside {@link modelEndpoints}.
 *
 * @category model calls
 * @since 1.0.0
 */
export const headerModel = (name: string): ModelIdentity => (request) =>
  request.method === "POST" ? request.headers[name.toLowerCase()] : undefined

/** The exact URL a request goes to, query included and fragment dropped. */
const exactUrl = (url: string, params: ReadonlyArray<readonly [string, unknown]>): string | undefined => {
  try {
    const parsed = new URL(url)
    for (const [name, value] of params) {
      // A redacted parameter cannot be compared, so the URL is not exact.
      if (typeof value !== "string") return undefined
      parsed.searchParams.append(name, value)
    }
    parsed.hash = ""
    return parsed.href
  } catch {
    return undefined
  }
}

/**
 * A {@link ModelIdentity} that admits a model call only at the exact URLs a
 * host lists, each read by its own `identity` ({@link declaredModel} when
 * omitted). A request to any other URL names no model, whatever its body or
 * headers say, so a `model:call` grant reaches the listed endpoints and
 * nothing else on their hosts.
 *
 * @example
 * ```ts
 * import { HttpClient } from "@smthrs/kernel"
 *
 * const guarded = HttpClient.layerWith({
 *   modelIdentity: HttpClient.modelEndpoints([
 *     { url: "https://api.anthropic.com/v1/messages" },
 *     { url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", identity: HttpClient.headerModel("ai-model-id") }
 *   ])
 * })
 * ```
 *
 * @category model calls
 * @since 1.0.0
 */
export const modelEndpoints = (
  endpoints: ReadonlyArray<{ readonly url: string; readonly identity?: ModelIdentity }>
): ModelIdentity => {
  const pinned = new Map<string | undefined, ModelIdentity>()
  for (const endpoint of endpoints) {
    const url = exactUrl(endpoint.url, [])
    if (url === undefined) throw new TypeError("a model endpoint needs an absolute, parseable URL")
    pinned.set(url, endpoint.identity ?? declaredModel)
  }
  return (request) => pinned.get(exactUrl(request.url, request.urlParams.params))?.(request)
}

/**
 * Runs `effect` with each outgoing request in it offered to the guard as a
 * `model:call` on `modelId` instead of as plain network access.
 *
 * The claim is an offer, not a grant of anything. The guard takes it only
 * when the layer's {@link ModelIdentity} reads that same `modelId` out of the
 * exact request being sent; then the check is `model:call` on
 * `<resource>/<modelId>`. A request that names another model, no model, or
 * goes somewhere the identity does not cover is checked as `net:get` or
 * `net:post`, like any other request.
 *
 * @category references
 * @since 1.0.0-rc.0
 */
export const withModelCall = (modelId: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const claim: ModelClaim = Object.freeze({ modelId })
  claims.add(claim)
  return Effect.provideService(Effect.provideService(effect, ModelCall, modelId), Claim, claim)
}

/**
 * The model id a request is admitted under: the claim's, when this module
 * minted the claim and the trusted identity reads the same id out of the
 * request itself.
 */
const admittedModel = (
  request: HttpClientRequest.HttpClientRequest,
  claim: ModelClaim | undefined,
  identity: ModelIdentity
): string | undefined =>
  claim !== undefined && claims.has(claim) && identity(request) === claim.modelId ? claim.modelId : undefined

/**
 * Projects a permission failure into the error channel Effect's `HttpClient`
 * tag fixes.
 *
 * Nothing is lost: the reason is always a `TransportError` — the request did
 * not leave the host because the capability kernel refused, suspended, or
 * could not decide it — `description` carries the human rendering from
 * `Permission.formatError`, and `cause` carries the structured failure itself,
 * so {@link fromHttpClientError} hands the attended surface back the original
 * `capability`, `tier`, `requestId`, and `reason`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const toHttpClientError = (options: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly error: PermissionError
}): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: options.request,
      description: formatError(options.error),
      cause: options.error
    })
  })

/**
 * Recovers the structured permission failure a {@link toHttpClientError}
 * projection carries, so an attended surface can still reply to the request
 * and an unattended report can still name the capability.
 *
 * Recovery validates data fields and the transport reason tag, not origin or
 * class operations. Establish producer or request identity separately across
 * a trust boundary.
 *
 * @category refinements
 * @since 1.0.0-rc.0
 */
export const fromHttpClientError = (
  error: HttpClientError.HttpClientError
): Option.Option<PermissionErrorPayload> =>
  error.reason._tag === "TransportError" && isPermissionError(error.reason.cause)
    ? Option.some(error.reason.cause)
    : Option.none()

/**
 * The host has no HTTP: the request was refused before it left the process.
 *
 * {@link makeNoop} carries it as the `TransportError` reason's `cause`. A live
 * client that fails to connect raises the same `TransportError` reason, so
 * this cause is what tells "no HTTP here" apart from "the network failed";
 * test it with {@link isUnavailable}.
 *
 * @category errors
 * @since 1.0.0-rc.19
 */
export class HttpUnavailable extends Schema.TaggedError<HttpUnavailable>()(
  "@smthrs/kernel/HttpUnavailable",
  { message: Schema.String }
) {}

/**
 * Whether `error` is a refusal from a host with no HTTP ({@link makeNoop})
 * rather than a failure of a request that really went out.
 *
 * @category refinements
 * @since 1.0.0-rc.19
 */
export const isUnavailable = (error: unknown): boolean =>
  error instanceof HttpClientError.HttpClientError && error.reason._tag === "TransportError" &&
  Schema.is(HttpUnavailable)(error.reason.cause)

/**
 * Constructs an unavailable HTTP client stub.
 *
 * Every request reports the missing host as a `TransportError` naming the
 * request, with an {@link HttpUnavailable} cause, so an unconfigured
 * capability answers rather than vanishing.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeNoop = (): EffectHttpClient.HttpClient =>
  EffectHttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: new HttpUnavailable({ message: "HTTP is unavailable on this host" })
        })
      })
    )
  )

/**
 * Provides an unavailable HTTP client stub.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNoop = (): Layer.Layer<EffectHttpClient.HttpClient> =>
  Layer.succeed(EffectHttpClient.HttpClient)(makeNoop())

/**
 * Keeps HTTPS resources host-only so existing grants remain valid. Every
 * other scheme is explicit, which prevents an HTTPS grant from authorizing a
 * cleartext or otherwise different transport.
 */
const capabilityFor = (
  request: HttpClientRequest.HttpClientRequest,
  modelId: string | undefined
): Effect.Effect<Capability, PermissionError> => {
  const action = modelId === undefined
    ? request.method === "GET" || request.method === "HEAD" ? "net:get" : "net:post"
    : "model:call"
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return makeCapability(action, request.url).pipe(
      Effect.flatMap((capability) =>
        Effect.fail(
          PermissionDenied.new({
            code: "permission_denied",
            capability,
            reason: "HTTP capability checks require an absolute, parseable URL"
          })
        )
      )
    )
  }
  // A trailing dot names the same DNS host, so `evil.example.` must not
  // escape a rule written for `evil.example`.
  const hostname = url.hostname.toLowerCase().replace(/(.)\.$/, "$1")
  const host = url.port === "" ? hostname : `${hostname}:${url.port}`
  const resource = url.protocol === "https:" ? host : `${url.protocol}//${host}`
  return makeCapability(action, modelId === undefined ? resource : `${resource}/${modelId}`)
}

interface PreflightAdmission {
  readonly store: GrantService
  readonly capability: Capability
  consumed: boolean
}

const Admission = Context.Reference<PreflightAdmission | undefined>("@smthrs/kernel/HttpClient/Admission", {
  defaultValue: () => undefined
})

/** The admissions {@link authorizePreflight} minted; the guard consumes no other. */
const admissions = new WeakSet<PreflightAdmission>()

/**
 * Authorizes a request before a caller performs network preflight work such as
 * DNS. The guarded transport consumes the same admission once, so a one-shot
 * grant is not spent twice. Admissions match both store identity and the exact
 * capability; redirects and retries require their own authorization.
 *
 * A preflight authorizes ordinary network access (`net:get` or `net:post`)
 * only. A model call is admitted by the guarded layer itself, which holds the
 * trusted {@link ModelIdentity}, so it is checked when it is sent.
 *
 * @category authorization
 * @since 1.0.0
 */
export const authorizePreflight = <A, E, R>(
  request: HttpClientRequest.HttpClientRequest,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | HttpClientError.HttpClientError, R | GrantStore> =>
  Effect.gen(function*() {
    const store = yield* GrantStore
    const capability = yield* capabilityFor(request, undefined).pipe(
      Effect.tap((capability) => store.check(capability)),
      Effect.mapError((error) => toHttpClientError({ request, error }))
    )
    const admission: PreflightAdmission = { store, capability, consumed: false }
    admissions.add(admission)
    return yield* Effect.provideService(effect, Admission, admission)
  })

/**
 * Forces `redirect: "manual"` on the fetch options a fetch-backed client reads
 * at execute time, keeping every other ambient field.
 */
const manualRedirects = (context: Context.Context<never>): Context.Context<never> =>
  Context.add(context, FetchHttpClient.RequestInit, {
    ...Context.getOrUndefined(context, FetchHttpClient.RequestInit),
    redirect: "manual"
  })

/**
 * Decorates the HTTP client in place with a `net:get`/`net:post`/`model:call`
 * capability check, then follows redirects *through* that check.
 *
 * The layer provides the tag it also requires: compose it over a host client
 * layer with `Layer.provide` and a consumer that never heard of the kernel is
 * guarded too. Because every hop re-enters the guarded `postprocess`, an
 * authorized first URL that redirects to an unauthorized one is denied at the
 * second hop instead of being fetched.
 *
 * `modelIdentity` decides which requests are model calls. It is captured here,
 * when the host builds the layer, and is the only thing that can turn a
 * {@link withModelCall} claim into a `model:call` check: the claim is taken
 * for one request, by this layer's own grant store, when the identity reads
 * the claimed model out of that exact request. A redirect hop is a new
 * request and is read again.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerWith = (options: { readonly modelIdentity: ModelIdentity }): Layer.Layer<
  EffectHttpClient.HttpClient,
  never,
  EffectHttpClient.HttpClient | GrantStore
> =>
  Layer.effect(
    EffectHttpClient.HttpClient,
    Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const grants = yield* GrantStore
      const snapshotted = EffectHttpClient.mapRequestEffect(
        client,
        (request) =>
          Effect.try({
            try: () => snapshotRequest(request),
            catch: () => invalidRequest(request)
          })
      )
      const guarded = EffectHttpClient.transform(
        snapshotted,
        (execute, request) =>
          Effect.withFiber((fiber) =>
            capabilityFor(request, admittedModel(request, fiber.getRef(Claim), options.modelIdentity)).pipe(
              Effect.flatMap((capability) => {
                const admission = fiber.getRef(Admission)
                if (
                  admission !== undefined && admissions.has(admission) && !admission.consumed &&
                  admission.store === grants
                  && admission.capability.action === capability.action &&
                  admission.capability.resource === capability.resource
                ) {
                  admission.consumed = true
                  return Effect.void
                }
                return grants.check(capability)
              }),
              Effect.mapError((error: PermissionError) => toHttpClientError({ request, error })),
              Effect.andThen(Effect.updateContext(execute, manualRedirects))
            )
          )
      )
      const followed = EffectHttpClient.followRedirects(guarded)
      const result = EffectHttpClient.makeWith(
        (request) =>
          Effect.withFiber((fiber) =>
            // Read caller policy before the guard forces manual transport.
            Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect === "manual"
              ? guarded.postprocess(request)
              : followed.postprocess(request)
          ),
        guarded.preprocess
      )
      return supportsDestinationPinning(client) ? withDestinationPinning(result) : result
    })
  )

/**
 * {@link layerWith} reading model calls with {@link declaredModel}.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer: Layer.Layer<
  EffectHttpClient.HttpClient,
  never,
  EffectHttpClient.HttpClient | GrantStore
> = layerWith({ modelIdentity: declaredModel })

/**
 * Address snapshot authorized for one web request. Host transports must reject
 * a different origin and use only these addresses for every connection attempt.
 * Ordinary model traffic leaves this reference unset.
 * @category references
 * @since 1.0.0
 */
export const Destination = Context.Reference<
  {
    readonly origin: string
    readonly addresses: ReadonlyArray<string>
  } | undefined
>("@smthrs/kernel/HttpClient/Destination", { defaultValue: () => undefined })

const pinnedClients = new WeakSet<EffectHttpClient.HttpClient>()

/**
 * Marks a trusted transport that enforces Destination on every connection.
 * The assertion belongs to this client instance, not ambient context. A
 * replacement client must establish its own transport guarantee.
 * @category constructors
 * @since 1.0.0
 */
export const withDestinationPinning = <A extends EffectHttpClient.HttpClient>(client: A): A => {
  pinnedClients.add(client)
  return client
}

/**
 * Whether this exact client implements the Destination transport contract.
 * @category predicates
 * @since 1.0.0
 */
export const supportsDestinationPinning = (client: EffectHttpClient.HttpClient): boolean => pinnedClients.has(client)

/**
 * A host resolved no addresses for a web request's hostname because it has no
 * resolver a pinning transport can honor. `reason` says why, in the host's
 * words.
 *
 * @category errors
 * @since 1.0.0-rc.16
 */
export class ResolveHostUnavailable extends Schema.TaggedError<ResolveHostUnavailable>()(
  "@smthrs/kernel/ResolveHostUnavailable",
  { hostname: Schema.String, reason: Schema.String }
) {}

/**
 * Resolves a web request's hostname to every address the request may reach.
 *
 * A web tool's destination policy checks each address this returns, and a
 * pinning transport ({@link withDestinationPinning}) connects only to the
 * {@link Destination} built from them, so the resolver and the transport must
 * come from the same host. `@smthrs/platform-node`'s `EgressHttpClient.layer`
 * provides the system resolver beside its pinning client, on Node and on Bun.
 *
 * The default resolves nothing: it fails with {@link ResolveHostUnavailable}.
 * That is the answer where the platform mediates the network, in a browser
 * tab or a Cloudflare Worker. Such a host can neither look a name up nor hold
 * a connection to the addresses a lookup returned, so a web request that
 * needs a name is refused, never sent unchecked.
 *
 * @example
 * ```ts
 * import { HttpClient } from "@smthrs/kernel"
 * import { Effect } from "effect"
 *
 * // A test pins every name to one documentation address.
 * const pinned = Effect.provideService(HttpClient.ResolveHost, () => Effect.succeed(["192.0.2.10"]))
 * ```
 *
 * @category references
 * @since 1.0.0-rc.16
 */
export const ResolveHost = Context.Reference<(hostname: string) => Effect.Effect<ReadonlyArray<string>, unknown>>(
  "@smthrs/kernel/HttpClient/ResolveHost",
  {
    defaultValue: () => (hostname) =>
      Effect.fail(
        new ResolveHostUnavailable({
          hostname,
          reason: "this host has no name resolver for web requests; its platform mediates the network"
        })
      )
  }
)
