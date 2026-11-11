import { Effect, Layer, Logger, Metric, Redacted, References, Tracer } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Egress, Scrub } from "../src/index.ts"

// The egress's seams, as a host provides them: the third-party hosts a guest reaches stand behind `fetch` (scripted
// per test, or the real one against real local servers), and the host's vault and audit are injected services.

/** A value no test text otherwise contains, with characters that make each of its encoded forms differ. */
export const VALUE = "sk_live_51Hq SENTINEL/value+=:\"quoted\"~é"

/** Another bound value, for a second secret. */
export const OTHER = "ghp_OtherSentinelToken0123456789"

export const PLACEHOLDER = `smthrs-secret-${"a".repeat(64)}`
export const OTHER_PLACEHOLDER = `smthrs-secret-${"b".repeat(64)}`
/** A placeholder no policy knows: an earlier generation's. */
export const STALE_PLACEHOLDER = `smthrs-secret-${"c".repeat(64)}`

export const API = "api.example.com"

/** A guest with two secrets: `API_KEY` for the API by GET and POST, and `GH_TOKEN` for GitHub. */
export const policy: Egress.Policy = {
  secrets: [
    { name: "API_KEY", placeholder: PLACEHOLDER, hosts: [API], methods: ["GET", "POST"] },
    { name: "GH_TOKEN", placeholder: OTHER_PLACEHOLDER, hosts: ["api.github.com"] }
  ],
  allow: ["registry.npmjs.org"]
}

/** Every form an echo of `value` may take, the value itself included. */
export const formsOf = (value: string) => Scrub.forms(value)

/** The forms of `values` that `text` contains: none, when nothing leaked. */
export const leaks = (text: string, values: ReadonlyArray<string> = [VALUE, OTHER]) =>
  values.flatMap((value) => formsOf(value).filter((form) => text.includes(form)))

export interface Seen {
  readonly url: string
  readonly method: string
  readonly redirect: RequestRedirect | undefined
  readonly headers: Record<string, string>
  readonly body: string
}

/** A scripted `fetch`: records what reached the host and answers with `answer`; `throw` rejects as a network error. */
export const scripted = (
  answer: (request: Request) => Response | "throw" | Promise<Response> = () => new Response("ok")
) => {
  const seen: Array<Seen> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({
      url: request.url,
      method: request.method,
      redirect: init?.redirect,
      headers: Object.fromEntries(request.headers),
      body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text()
    })
    const response = await answer(request)
    if (response === "throw") throw new TypeError(`fetch failed: ${request.headers.get("authorization")}`)
    return response
  }
  return { fetch, seen }
}

export interface Recorded {
  readonly entries: Array<Egress.Entry>
}

/** The vault: values by name; a name it lacks fails as a host's store would. */
export const vault = (values: Record<string, string> = { API_KEY: VALUE, GH_TOKEN: OTHER }) =>
  Layer.succeed(
    Egress.Vault,
    Egress.Vault.of({
      reveal: (name) =>
        name in values
          ? Effect.succeed(Redacted.make(values[name]!))
          : Effect.fail(new Egress.SecretUnavailable({ name }))
    })
  )

/** The audit: keeps every entry, or fails every record when `down`. */
export const audit = (down = false) => {
  const entries: Array<Egress.Entry> = []
  const layer = Layer.succeed(
    Egress.Audit,
    Egress.Audit.of({
      record: (entry) => down ? Effect.fail(new Egress.AuditUnavailable()) : Effect.sync(() => void entries.push(entry))
    })
  )
  return { entries, layer }
}

/** Everything a program records: its spans (with their attributes and events), log lines and metric registry. */
export const telemetry = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const logs: Array<{ level: string; message: unknown; annotations: Record<string, unknown> }> = []
  const registry = new Map()
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const recorder = Logger.make(({ logLevel, message, fiber }) => {
    logs.push({ level: logLevel, message, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } })
  })
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Logger.layer([recorder])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, registry)
    )
  const count = (outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(Egress.requests, { outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    ).count
  /** Every string the program recorded: span names, attributes, events and exits, and log lines. */
  const recorded = () =>
    JSON.stringify([
      spans.map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(span.attributes),
        events: span.events,
        status: span.status
      })),
      logs
    ], (_, value) =>
      typeof value === "bigint" ?
        String(value) :
        value instanceof Error ?
        { ...value, name: value.name, message: value.message, cause: String(value.cause) } :
        value)
  return { spans, logs, provide, count, recorded }
}

/** Effect's fetch client over `fetch`. */
export const httpClient = (fetch: typeof globalThis.fetch) =>
  Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch))

/**
 * Sends `request` from a guest through `Egress.forward` and reads the answer the guest gets, whole, with the records
 * the program made while it ran and streamed.
 */
export const forwardThrough = async (
  request: Request,
  options: {
    readonly fetch: typeof globalThis.fetch
    readonly policy?: Egress.Policy
    readonly values?: Record<string, string>
    readonly auditDown?: boolean
    /** Whether the host streams the answer with the request's services; a Worker's host streams it with its own. */
    readonly hostContext?: boolean
  }
) => {
  const recorded = telemetry()
  const audited = audit(options.auditDown)
  const { response, context } = await Effect.runPromise(
    recorded.provide(
      Effect.all({
        response: Egress.forward(HttpServerRequest.fromWeb(request), options.policy ?? policy),
        context: Effect.context<never>()
      }).pipe(Effect.provide(Layer.mergeAll(httpClient(options.fetch), vault(options.values), audited.layer)))
    )
  )
  const web = options.hostContext === false
    ? HttpServerResponse.toWeb(response)
    : HttpServerResponse.toWeb(response, { context })
  const body = await web.text()
  return { response: web, body, recorded, entries: audited.entries }
}

/** A body that streams `parts` one chunk each. */
export const chunked = (parts: ReadonlyArray<string | Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === "string" ? new TextEncoder().encode(part) : part)
      controller.close()
    }
  })

/** A body that sends `first` and then breaks, as a connection reset mid-answer would. */
export const brokenBody = (first: string) => {
  let pulls = 0
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(first))
      else controller.error(new Error(`connection reset ${VALUE}`))
    }
  })
}
