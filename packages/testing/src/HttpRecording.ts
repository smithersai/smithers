/**
 * Record, replay or pass through every request an `HttpClient` makes.
 *
 * A test that reaches an external service over HTTP (GitHub, a provider's
 * REST API, a sandbox control plane) runs in one of three modes, chosen by
 * the suite and never by this module:
 *
 * - `passthrough`: the live client, unchanged. Nothing is written.
 * - `record`: the live client, and every exchange is scrubbed of credentials
 *   and written to a JSON recording when the scope closes successfully.
 * - `replay`: answers only from the recording. A request the recording does
 *   not hold is a defect, never a network call.
 *
 * The recording is meant to be committed beside the test. Before anything is
 * written, request headers are dropped, response headers are cut to an
 * allowlist, every field named like a credential is replaced, every string is
 * run through the journal's token-shaped rules, and each live secret the suite
 * names is replaced wherever it appears. A recording that still matches a
 * credential shape after that is refused and not written.
 *
 * Governing design: `packages/testing/docs/guides/record-http.md`.
 *
 * @since 1.0.0
 */

import { placeholder, redact } from "@smthrs/journal/Redaction"
import { Effect, Exit, Layer, Redacted, Schema, type Scope } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { scan as scanCredentials } from "./internal/credentials.ts"

/**
 * How a recorded client reaches its service.
 *
 * @category models
 * @since 1.0.0
 */
export const Mode = Schema.Literals(["passthrough", "record", "replay"])

/**
 * The decoded form of {@link Mode}.
 *
 * @category models
 * @since 1.0.0
 */
export type Mode = typeof Mode.Type

/**
 * A request as it is keyed and recorded: no headers, the body parsed when it
 * is JSON.
 *
 * @category models
 * @since 1.0.0
 */
export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body?: unknown
}

/**
 * One request and the answer the service gave it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Exchange {
  readonly request: RecordedRequest
  readonly response: {
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly body: unknown
  }
}

/**
 * A committed recording: every exchange of one passing run, in the order the
 * answers arrived.
 *
 * @category models
 * @since 1.0.0
 */
export interface Recording {
  /**
   * The run's identity, fixed at record time: what a test puts in the names
   * it creates on the service so that a real run never meets an earlier one's
   * data, and a replay asks for exactly what was recorded.
   */
  readonly label?: string | undefined
  readonly exchanges: ReadonlyArray<Exchange>
}

const RecordingSchema = Schema.Struct({
  label: Schema.optional(Schema.String),
  exchanges: Schema.Array(Schema.Struct({
    request: Schema.Struct({ method: Schema.String, url: Schema.String, body: Schema.optional(Schema.Unknown) }),
    response: Schema.Struct({
      status: Schema.Number,
      headers: Schema.Record(Schema.String, Schema.String),
      body: Schema.Unknown
    })
  }))
})

/**
 * What a recorded client is built from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly mode: Mode
  /** The recording's JSON file. `record` writes it; `replay` reads it. */
  readonly path: string
  /** The real client. Required for `passthrough` and `record`; `replay` never touches it. */
  readonly live?: HttpClient.HttpClient | undefined
  /**
   * The live credentials of this run. Every nonempty value, regardless of
   * length, is replaced wherever it appears before anything is written, and
   * a recording that still holds one is refused. Empty values are ignored.
   * Shapes the journal's rules know (GitHub, AWS, Slack, Google and `sk-` keys,
   * JWTs, private key blocks) are caught without being named here.
   */
  readonly secrets?: ReadonlyArray<string | Redacted.Redacted<string>> | undefined
  /**
   * Rewrites what changes from run to run (a timestamp, a generated name) out
   * of a request before it is keyed and recorded, so the next run's request
   * finds the same recording. The live service still receives the original.
   */
  readonly normalize?: ((request: RecordedRequest) => RecordedRequest) | undefined
  /** Written as the recording's {@link Recording.label}. Read it back with {@link load}. */
  readonly label?: string | undefined
  /**
   * Removes what the code never reads from a response body before it is
   * recorded, such as a REST API's hypermedia links. While recording, the code
   * under test receives the pruned body too, so a field it needs fails the
   * recording run rather than a later replay.
   */
  readonly prune?: ((body: unknown, request: RecordedRequest) => unknown) | undefined
}

/**
 * A replayed request the recording does not hold, or holds fewer times than it
 * was asked. Names the method and the scrubbed URL, never a body.
 *
 * @category errors
 * @since 1.0.0
 */
export class UnrecordedRequestError extends Schema.TaggedError<UnrecordedRequestError>()(
  "UnrecordedRequestError",
  { method: Schema.String, url: Schema.String, recorded: Schema.Number }
) {
  override get message(): string {
    return `No recorded answer left for ${this.method} ${this.url} (${this.recorded} recorded). Record the test again.`
  }
}

/**
 * A recording that still holds a credential after scrubbing. Names the rule,
 * never the value. Nothing is written.
 *
 * @category errors
 * @since 1.0.0
 */
export class CredentialInRecordingError extends Schema.TaggedError<CredentialInRecordingError>()(
  "CredentialInRecordingError",
  { path: Schema.String, rules: Schema.Array(Schema.String) }
) {
  override get message(): string {
    return `Refusing to write ${this.path}: it holds a value shaped like a credential (${this.rules.join(", ")}).`
  }
}

/**
 * The ids of the credential shapes found in `text`; empty when it holds none.
 *
 * A placeholder the scrubber wrote does not match. Run it over every committed
 * recording in CI, so a hand-edited or wrongly recorded file fails the build.
 *
 * @throws {never}
 * @category scanning
 * @since 1.0.0
 */
export const scan = (text: string): ReadonlyArray<string> => scanCredentials(text)

// Response headers that change what a client does. Everything else (cookies,
// request ids, rate-limit counters, signatures) is dropped.
const keptHeaders = new Set(["content-type", "link", "location", "retry-after"])

const sensitiveQuery =
  /^(?:access_token|token|code|client_secret|sig|signature|key|api_key|apikey|auth|password|x-amz-signature|x-amz-credential|x-amz-security-token)$/i

const secretValues = (secrets: Options["secrets"]): ReadonlyArray<string> =>
  (secrets ?? []).map((secret) => typeof secret === "string" ? secret : Redacted.value(secret))
    .filter((secret) => secret.length > 0)

const replaceSecrets = (value: unknown, secrets: ReadonlyArray<string>): unknown => {
  if (secrets.length === 0) return value
  if (typeof value === "string") return secrets.reduce((text, secret) => text.split(secret).join(placeholder), value)
  if (Array.isArray(value)) return value.map((item) => replaceSecrets(item, secrets))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceSecrets(item, secrets)]))
  }
  return value
}

const scrubUrl = (url: string): string => {
  const parsed = new URL(url)
  parsed.username = ""
  parsed.password = ""
  for (const name of [...parsed.searchParams.keys()]) {
    if (sensitiveQuery.test(name)) parsed.searchParams.set(name, placeholder)
  }
  return parsed.toString()
}

const parsed = (text: string): unknown => {
  if (text === "") return ""
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * The request as it is keyed and recorded: credentials removed, then
 * `normalize` applied.
 *
 * @category scrubbing
 * @since 1.0.0
 */
export const scrubRequest = (
  request: RecordedRequest,
  options: Pick<Options, "secrets" | "normalize"> = {}
): RecordedRequest => {
  const secrets = secretValues(options.secrets)
  const body = request.body === undefined ? undefined : redact(replaceSecrets(request.body, secrets))
  const scrubbed: RecordedRequest = {
    method: request.method,
    url: scrubUrl(replaceSecrets(request.url, secrets) as string),
    ...(body === undefined ? {} : { body })
  }
  return options.normalize === undefined ? scrubbed : options.normalize(scrubbed)
}

/**
 * The exchange as it is written: the request as {@link scrubRequest} keys it,
 * the response's allowlisted headers, and its body with every credential
 * removed.
 *
 * @category scrubbing
 * @since 1.0.0
 */
export const scrubExchange = (exchange: Exchange, options: Pick<Options, "secrets" | "normalize"> = {}): Exchange => {
  const secrets = secretValues(options.secrets)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(exchange.response.headers)) {
    const lower = name.toLowerCase()
    if (keptHeaders.has(lower)) headers[lower] = lower === "location" ? scrubUrl(value) : value
  }
  return {
    request: scrubRequest(exchange.request, options),
    response: {
      status: exchange.response.status,
      headers: redact(replaceSecrets(headers, secrets)) as Record<string, string>,
      body: redact(replaceSecrets(exchange.response.body, secrets))
    }
  }
}

const requestBody = (request: HttpClientRequest.HttpClientRequest): unknown => {
  const body = request.body
  if (body._tag === "Empty") return undefined
  if (body._tag === "Uint8Array") return parsed(new TextDecoder().decode(body.body))
  if (body._tag === "Raw" && typeof body.body === "string") return parsed(body.body)
  // A FormData, Stream or binary raw body cannot be keyed without consuming it.
  throw new Error(`HttpRecording cannot key a ${body._tag} request body`)
}

const recordedRequest = (request: HttpClientRequest.HttpClientRequest, url: URL): RecordedRequest => {
  const body = requestBody(request)
  return { method: request.method, url: url.toString(), ...(body === undefined ? {} : { body }) }
}

const keyOf = (request: RecordedRequest): string => JSON.stringify([request.method, request.url, request.body ?? null])

const answer = (
  request: HttpClientRequest.HttpClientRequest,
  exchange: Exchange
): HttpClientResponse.HttpClientResponse => {
  const body = exchange.response.body
  const text = typeof body === "string" ? body : JSON.stringify(body)
  // A null-body status cannot carry a body in a web Response.
  const empty = exchange.response.status === 204 || exchange.response.status === 205 || exchange.response.status === 304
  return HttpClientResponse.fromWeb(
    request,
    new Response(empty ? null : text, { status: exchange.response.status, headers: exchange.response.headers })
  )
}

/**
 * A client that answers from `recording` and never reaches a network.
 *
 * Exchanges with the same method, URL and body are claimed once each, in
 * recorded order, so a read before a write and the same read after it get
 * their own answers. `remaining` counts the exchanges no request claimed.
 *
 * @category constructors
 * @since 1.0.0
 */
export const replay = (
  recording: Recording,
  options: Pick<Options, "normalize"> = {}
): HttpClient.HttpClient & { readonly remaining: () => number } => {
  const queues = new Map<string, Array<Exchange>>()
  for (const exchange of recording.exchanges) {
    const key = keyOf(exchange.request)
    const queue = queues.get(key)
    if (queue === undefined) queues.set(key, [exchange])
    else queue.push(exchange)
  }
  const counts = new Map([...queues].map(([key, queue]) => [key, queue.length]))
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const keyed = scrubRequest(recordedRequest(request, url), options)
      const key = keyOf(keyed)
      const next = queues.get(key)?.shift()
      if (next === undefined) {
        return Effect.die(
          new UnrecordedRequestError({ method: keyed.method, url: keyed.url, recorded: counts.get(key) ?? 0 })
        )
      }
      return Effect.succeed(answer(request, next))
    }).pipe(Effect.withSpan("testing.http_recording.replay", { attributes: { method: request.method } }))
  )
  return Object.assign(client, {
    remaining: () => [...queues.values()].reduce((total, queue) => total + queue.length, 0)
  })
}

/**
 * Reads and decodes a recording file. A missing or malformed file is a
 * defect: a replayed test without its recording is a broken setup.
 *
 * @category constructors
 * @since 1.0.0
 */
export const load = (path: string): Effect.Effect<Recording> =>
  Effect.tryPromise(() => readFile(resolve(path), "utf8")).pipe(
    Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as unknown)),
    Effect.flatMap(Schema.decodeUnknownEffect(RecordingSchema)),
    Effect.mapError((cause) => new Error(`Recording ${path}: ${String(cause)}`, { cause })),
    Effect.orDie
  )

/**
 * The recording a run produces, refused when a credential survives scrubbing.
 *
 * @category scrubbing
 * @since 1.0.0
 */
export const encode = (
  path: string,
  recording: Recording,
  secrets: Options["secrets"]
): Effect.Effect<string, CredentialInRecordingError> => {
  // One exchange per line: a re-recording's diff names the exchanges that changed, at a quarter less than indented.
  const head = recording.label === undefined ? "" : `"label":${JSON.stringify(recording.label)},`
  const lines = recording.exchanges.map((exchange) => JSON.stringify(exchange)).join(",\n")
  const text = `{${head}"exchanges":[\n${lines}\n]}\n`
  const rules = [
    ...scan(text),
    ...(secretValues(secrets).some((secret) => text.includes(secret)) ? ["live-secret"] : [])
  ]
  return rules.length === 0 ? Effect.succeed(text) : Effect.fail(new CredentialInRecordingError({ path, rules }))
}

/**
 * A client that calls `live` and records every exchange. The recording is
 * written to `path` when the scope closes successfully; a failed or
 * interrupted run writes nothing and leaves the previous recording in place.
 *
 * @category constructors
 * @since 1.0.0
 */
export const record = (
  path: string,
  options: Pick<Options, "live" | "secrets" | "normalize" | "label" | "prune">
): Effect.Effect<HttpClient.HttpClient, never, Scope.Scope> =>
  Effect.gen(function*() {
    const live = options.live
    if (live === undefined) return yield* Effect.die(new Error("HttpRecording.record needs a live client"))
    const exchanges: Array<Exchange> = []
    yield* Effect.addFinalizer((exit) =>
      Exit.isSuccess(exit)
        ? Effect.gen(function*() {
          const text = yield* encode(
            path,
            options.label === undefined ? { exchanges } : { label: options.label, exchanges },
            options.secrets
          )
          yield* Effect.promise(async () => {
            await mkdir(dirname(resolve(path)), { recursive: true })
            await writeFile(resolve(path), text)
          })
          yield* Effect.logInfo("http recording written").pipe(Effect.annotateLogs({ exchanges: exchanges.length }))
        }).pipe(Effect.orDie)
        : Effect.logWarning("http recording not written: the run failed")
    )
    return HttpClient.make((request, url) =>
      Effect.gen(function*() {
        const keyed = recordedRequest(request, url)
        const response = yield* live.execute(request)
        const liveText = yield* response.text.pipe(Effect.orDie)
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(response.headers)) headers[name] = value
        // A pruned body is what the code under test sees too, so recording and replay run on the same answer.
        const body = options.prune === undefined ? parsed(liveText) : options.prune(parsed(liveText), keyed)
        const text = options.prune === undefined || typeof body === "string" ? liveText : JSON.stringify(body)
        exchanges.push(scrubExchange({ request: keyed, response: { status: response.status, headers, body } }, options))
        const empty = response.status === 204 || response.status === 205 || response.status === 304
        return HttpClientResponse.fromWeb(
          request,
          new Response(empty ? null : text, { status: response.status, headers })
        )
      }).pipe(Effect.withSpan("testing.http_recording.record", { attributes: { method: request.method } }))
    )
  })

/**
 * The client `options.mode` selects: the live client, a recording one, or a
 * replaying one.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Effect.Effect<HttpClient.HttpClient, never, Scope.Scope> => {
  switch (options.mode) {
    case "passthrough":
      return options.live === undefined
        ? Effect.die(new Error("HttpRecording passthrough needs a live client"))
        : Effect.succeed(options.live)
    case "record":
      return record(options.path, options)
    case "replay":
      return Effect.map(load(options.path), (recording) => replay(recording, options))
  }
}

/**
 * Provides {@link make} as the `HttpClient` service.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(HttpClient.HttpClient, make(options))
