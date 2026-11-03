import { ModelProxy } from "@smthrs/model"
import { Data, Duration, Effect, Metric, Option, Stream } from "effect"
import * as BodyLimits from "./BodyLimits.ts"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

/**
 * Fixed from dispatch, never renewed by a chunk. A 1 MiB coedit seed is ~1.33 MiB as base64 JSON and takes
 * over 10 s at 1 Mbit/s; long issue bodies also need time on slow phones. Authority is resolved after EOF,
 * so allowing 60 s retains no earlier authorization. Route byte caps still bound memory.
 */
export const BODY_READ_MILLIS = 60_000
/** Aggregate ceiling; each route is capped while reading. */
export { MAX_BODY_BYTES } from "./BodyLimits.ts"
const methods = new Set(["POST", "PUT", "PATCH", "DELETE"])
class Refused extends Data.TaggedError("WriteBodyRefused")<{ readonly status: number }> {}
export const bodies = Metric.counter("smithers_write_bodies", { incremental: true,
  description: "Write bodies buffered before authentication, by status" })

/** The cheap throttle runs first, then route-capped buffering. No authority lookup is added here. */
export const afterBody = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  preflight: Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>, never, HttpServerRequest.HttpServerRequest> = Effect.succeed(Option.none())) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const limited = yield* preflight
    if (Option.isSome(limited)) return limited.value
    if (!methods.has(request.method) || (request.source instanceof Request && request.source.body === null)) return yield* handler
    const maxBytes = yield* BodyLimits.forRequest(request.url).pipe(Effect.orDie)
    const read = Effect.gen(function* () {
      if (Number(request.headers["content-length"]) > maxBytes) return yield* new Refused({ status: 413 })
      const chunks: Array<Uint8Array> = []
      let length = 0
      yield* request.stream.pipe(Stream.runForEach((chunk) => {
        length += chunk.byteLength
        if (length > maxBytes) return Effect.fail(new Refused({ status: 413 }))
        chunks.push(chunk)
        return Effect.void
      }), Effect.mapError((error) => error instanceof Refused ? error : new Refused({ status: 400 })))
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return bytes
    }).pipe(Effect.timeoutOrElse({ duration: Duration.millis(BODY_READ_MILLIS),
      orElse: () => Effect.fail(new Refused({ status: 408 })) }), Effect.withSpan("write.admission"), Effect.result)
    const result = yield* read
    const status = result._tag === "Failure" ? result.failure.status : 200
    yield* Metric.update(Metric.withAttributes(bodies, { status: String(status) }), 1)
    if (result._tag === "Failure") {
      yield* Effect.logWarning("write.body").pipe(Effect.annotateLogs({ status }))
      if (status === 413 && request.url.split("?")[0]!.startsWith("/api/model/")) {
        const requestId = crypto.randomUUID().replaceAll("-", "")
        return HttpServerResponse.jsonUnsafe({ code: "invalid_request", message: `Send at most ${maxBytes} bytes.`, requestId } satisfies ModelProxy.ErrorBody,
          { status, headers: { "cache-control": "no-store", [ModelProxy.requestIdHeader]: requestId } })
      }
      return HttpServerResponse.jsonUnsafe({ code: status === 408 ? "body_timeout" : status === 413 ? "too_large" : "invalid" },
        { status, headers: { "cache-control": "no-store" } })
    }
    // Rebuild all body accessors, including stream: handlers continue to enforce their byte and UTF-8 contracts.
    const replay = HttpServerRequest.fromWeb(new Request(new URL(request.originalUrl, "http://localhost"), {
      method: request.method, headers: request.headers, body: result.success,
    })).modify({ url: request.url })
    return yield* handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, replay))
  })
