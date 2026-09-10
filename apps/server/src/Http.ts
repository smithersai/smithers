import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { BodyNotJson, BodyTooLarge, BodyUnreadable, UpstreamTimeout, UpstreamUnreachable } from "./Failures"
import type { BodyFailure, UpstreamFailure } from "./Failures"

/*
 * Outbound HTTP and request bodies: the two places a Web API enters this
 * Worker's Effects.
 *
 * `Transport` is the one service that performs `fetch`. Every upstream call
 * (identity, billing, chat, Cloud, GitHub, Cerebras) goes through it, so a
 * test injects a transport instead of patching `globalThis.fetch`, and the
 * live layer resolves `globalThis.fetch` at call time so the existing suites
 * that still patch the global keep working until they are migrated.
 *
 * Interruption is cancellation: `Effect.tryPromise` hands the fiber's
 * AbortSignal to `fetch`, so a deadline that wins, or a client that
 * disconnects, aborts the socket instead of leaking it.
 */

export type FetchInput = Request | string | URL

export interface TransportShape {
  readonly fetch: (seam: string, input: FetchInput, init?: RequestInit) => Effect.Effect<Response, UpstreamUnreachable>
}

export class Transport extends Context.Service<Transport, TransportShape>()("smithers-server/Transport") {}

export type FetchImplementation = (input: FetchInput, init?: RequestInit) => Promise<Response>

const combineSignals = (incoming: AbortSignal | null | undefined, own: AbortSignal): AbortSignal =>
  incoming == null ? own : AbortSignal.any([incoming, own])

/** A transport over one `fetch` implementation; the fiber's signal is joined to the caller's. */
export const transportFrom = (fetchImpl: FetchImplementation): TransportShape => ({
  fetch: (seam, input, init) =>
    Effect.suspend(() => {
      const incoming = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      // A caller whose signal is already aborted gets the refusal `fetch`
      // would give it, without a request ever leaving.
      if (incoming?.aborted === true) {
        return Effect.fail(new UpstreamUnreachable({ seam, cause: incoming.reason ?? new DOMException("The operation was aborted.", "AbortError") }))
      }
      return Effect.tryPromise({
        try: (signal) => fetchImpl(input, { ...init, signal: combineSignals(incoming, signal) }),
        catch: (cause) => new UpstreamUnreachable({ seam, cause })
      })
    })
})

export const transportLayer = (fetchImpl: FetchImplementation): Layer.Layer<Transport> =>
  Layer.succeed(Transport, transportFrom(fetchImpl))

/** The deployed transport: the platform `fetch`, looked up per call. */
export const TransportLive: Layer.Layer<Transport> = transportLayer((input, init) => globalThis.fetch(input, init))

/** The default any-upstream deadline, in ms: bounds the wait for HEADERS only. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 20_000

/**
 * `fetch` under a deadline. The timer covers the headers only, so a streaming
 * answer is never cut off mid-body; when it wins, the underlying request is
 * interrupted (and so aborted) before the failure is raised.
 */
export const fetchWithDeadline = (
  seam: string,
  input: FetchInput,
  init: RequestInit | undefined,
  timeoutMs: number
): Effect.Effect<Response, UpstreamFailure, Transport> =>
  Transport.use((transport) => transport.fetch(seam, input, init)).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new UpstreamTimeout({ seam, timeoutMs }))
    })
  )

/** Discard a response body we will not read, so the connection is released. */
export const discardBody = (response: Request | Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve())

/**
 * Read a body whole, refusing past `limit` bytes. Bytes, not UTF-16 code
 * units: a multi-byte body encodes to up to 4x its string length, and a
 * chunked request declares no length at all.
 */
export const readBoundedBytes = (
  body: Request | Response,
  limit: number
): Effect.Effect<Uint8Array<ArrayBuffer>, BodyTooLarge | BodyUnreadable> => {
  const declared = Number(body.headers.get("content-length") ?? "0")
  if (declared > limit) return Effect.andThen(discardBody(body), new BodyTooLarge({ limit }))
  const stream = body.body
  if (stream === null) return Effect.succeed(new Uint8Array(0))
  // The reader owns the stream for the read's lifetime: every exit (the end
  // of the body, a ceiling, a failed read, an interruption) cancels an
  // unfinished stream through the reader and releases the lock.
  return Effect.acquireUseRelease(
    Effect.sync(() => ({ reader: stream.getReader(), finished: false })),
    (held) =>
      Effect.gen(function* () {
        const chunks: Array<Uint8Array> = []
        let byteLength = 0
        const read = Effect.tryPromise({ try: () => held.reader.read(), catch: (cause) => new BodyUnreadable({ cause }) })
        for (;;) {
          const { done, value } = yield* read
          if (done) {
            held.finished = true
            break
          }
          byteLength += value.byteLength
          if (byteLength > limit) return yield* new BodyTooLarge({ limit })
          chunks.push(value)
        }
        const bytes = new Uint8Array(byteLength)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return bytes
      }),
    (held) =>
      Effect.promise(() => (held.finished ? Promise.resolve() : held.reader.cancel().catch(() => undefined))).pipe(
        Effect.ensuring(Effect.sync(() => held.reader.releaseLock()))
      )
  )
}

/** Read a body whole as text, under a byte ceiling. */
export const readBoundedText = (body: Request | Response, limit: number): Effect.Effect<string, BodyTooLarge | BodyUnreadable> =>
  Effect.map(readBoundedBytes(body, limit), (bytes) => new TextDecoder().decode(bytes))

/** Read a body whole as JSON, under a byte ceiling. */
export const readBoundedJson = (body: Request | Response, limit: number): Effect.Effect<unknown, BodyFailure> =>
  Effect.flatMap(readBoundedText(body, limit), (text) =>
    Effect.try({ try: () => JSON.parse(text) as unknown, catch: (cause) => new BodyNotJson({ cause }) }))

/**
 * Read an unbounded body whole (an upstream answer this Worker chose to
 * call). Reader-owned like the bounded read: a body that stalls after its
 * headers arrived is cancelled when the fiber is interrupted or times out,
 * so an abandoned provider response never keeps streaming into nothing.
 */
export const readBytes = (body: Request | Response): Effect.Effect<Uint8Array<ArrayBuffer>, BodyUnreadable> =>
  readBoundedBytes(body, Number.POSITIVE_INFINITY).pipe(
    Effect.catchTag("BodyTooLarge", (failure) => Effect.die(failure))
  )

/** Read an unbounded text body (an upstream answer this Worker chose to call). */
export const readText = (body: Request | Response): Effect.Effect<string, BodyUnreadable> =>
  Effect.map(readBytes(body), (bytes) => new TextDecoder().decode(bytes))

/** Read an unbounded JSON body (an upstream answer this Worker chose to call). */
export const readJson = (body: Request | Response): Effect.Effect<unknown, BodyUnreadable | BodyNotJson> =>
  Effect.flatMap(readText(body), (text) =>
    Effect.try({ try: () => JSON.parse(text) as unknown, catch: (cause) => new BodyNotJson({ cause }) }))

/** A JSON body read for its content, where an unreadable one is simply absent. */
export const readJsonOrUndefined = (body: Request | Response): Effect.Effect<unknown> =>
  readJson(body).pipe(Effect.catch(() => Effect.succeed(undefined)))
