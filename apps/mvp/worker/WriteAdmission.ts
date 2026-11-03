import { Data, Duration, Effect, Metric, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

/**
 * Fixed from dispatch, never renewed by a chunk. A 1 MiB coedit seed is ~1.33 MiB as base64 JSON and takes
 * over 10 s at 1 Mbit/s; long issue bodies also need time on slow phones. Authority is resolved after EOF,
 * so allowing 60 s retains no earlier authorization. Route byte caps still bound memory.
 */
export const BODY_READ_MILLIS = 60_000
/** Aggregate buffering cap; handlers retain their smaller, route-specific limits. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024
const methods = new Set(["POST", "PUT", "PATCH", "DELETE"])
class Refused extends Data.TaggedError("WriteBodyRefused")<{ readonly status: number }> {}
export const bodies = Metric.counter("smithers_write_bodies", { incremental: true,
  description: "Write bodies buffered before authentication, by status" })

/** The dispatcher wraps every route, including bodyless writes. No authority or database lookup is added here. */
export const afterBody = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!methods.has(request.method) || (request.source instanceof Request && request.source.body === null)) return yield* handler
    const read = Effect.gen(function* () {
      if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) return yield* new Refused({ status: 413 })
      const chunks: Array<Uint8Array> = []
      let length = 0
      yield* request.stream.pipe(Stream.runForEach((chunk) => {
        length += chunk.byteLength
        if (length > MAX_BODY_BYTES) return Effect.fail(new Refused({ status: 413 }))
        chunks.push(chunk)
        return Effect.void
      }), Effect.mapError((error) => error instanceof Refused ? error : new Refused({ status: 400 })))
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return bytes
    }).pipe(Effect.timeoutOrElse({ duration: Duration.millis(BODY_READ_MILLIS),
      orElse: () => Effect.fail(new Refused({ status: 408 })) }), Effect.result)
    const result = yield* read
    const status = result._tag === "Failure" ? result.failure.status : 200
    yield* Metric.update(Metric.withAttributes(bodies, { status: String(status) }), 1)
    if (result._tag === "Failure") {
      yield* Effect.logWarning("write.body").pipe(Effect.annotateLogs({ status }))
      return HttpServerResponse.jsonUnsafe({ code: status === 408 ? "body_timeout" : status === 413 ? "too_large" : "invalid" },
        { status, headers: { "cache-control": "no-store" } })
    }
    // Rebuild all body accessors, including stream: handlers continue to enforce their byte and UTF-8 contracts.
    const replay = HttpServerRequest.fromWeb(new Request(new URL(request.originalUrl, "http://localhost"), {
      method: request.method, headers: request.headers, body: result.success,
    })).modify({ url: request.url })
    return yield* handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, replay))
  }).pipe(Effect.withSpan("write.admission"))
