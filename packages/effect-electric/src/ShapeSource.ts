/**
 * Where an Electric collection's shape requests go: the source of its shape
 * stream, as an Effect service.
 *
 * Every collection sends its shape requests through `ShapeSource`. Its
 * default sends them with the `fetch` in Effect's `FetchHttpClient.Fetch`
 * reference, the global one unless a program provides its own, so a program
 * that never mentions `ShapeSource` syncs from Electric as it is. It sends
 * each request with `cache: "no-store"`, so the HTTP cache never answers a
 * shape request or keeps its response: rows read under one session can't
 * come back from the cache after sign-out, whatever the server's headers say.
 * In a Cloudflare Worker that needs a compatibility date of 2024-11-11 or
 * later.
 *
 * `layerFaulty` is the test implementation: the source a program would use,
 * behind switches (`Faults`) that make it down, refuse, stall or cut its
 * responses short on command.
 * Use it to test what a program does when sync fails. Happy paths run on the
 * real source, so the test source is only ever the variation, never the
 * evidence that sync works.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"

/**
 * A shape request failed on the network (`status` absent) or with a 5xx or
 * 429 (`status`). An Electric collection steps its sync policy with it.
 *
 * @category errors
 * @since 0.1.0
 */
export class RequestFailed extends Data.TaggedError("RequestFailed")<{ readonly status?: number }> {}

/**
 * A shape source: it sends one shape request and answers with Electric's
 * response, or fails with `RequestFailed` when the request never got one.
 * Interrupting the Effect aborts the request. The caller's signal also stays
 * connected after the headers arrive, so aborting it cancels the response body.
 *
 * @category models
 * @since 0.1.0
 */
export interface Source {
  /**
   * Isolates Electric's module-level URL caches when independent browser realms are hosted in one JavaScript
   * realm. Stable for this source's collections; absent in a normal browser tab. Never sent to the server.
   */
  readonly cacheNamespace?: string | undefined
  readonly request: (url: string, init: RequestInit) => Effect.Effect<Response, RequestFailed>
}

/**
 * The real source: each request sent with the `fetch` in
 * `FetchHttpClient.Fetch`, past the HTTP cache (`cache: "no-store"`).
 *
 * A live request (`live=true`, a long poll that waits at Electric for a
 * change) is sent with `priority: "low"`. A browser opens at most six
 * HTTP/1.1 connections to an origin, so on a page with six or more shapes
 * every connection can be waiting at Electric; at the same priority, the
 * page's other requests queue behind long polls that are themselves sent
 * again as they end, and wait a whole long poll or more. At low priority, a
 * long poll never takes a connection another request is waiting for. Over
 * HTTP/2 there is no such limit, and a runtime without priorities ignores it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fetchSource: Source = {
  request: (url, init) =>
    Effect.gen(function*() {
      const fetch = yield* FetchHttpClient.Fetch
      const live = new URL(url).searchParams.get("live") === "true"
      return yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            ...init,
            ...(live ? { priority: "low" } : {}),
            cache: "no-store",
            signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal
          }),
        catch: () => new RequestFailed({})
      })
    })
}

/**
 * The service an Electric collection sends its shape requests through.
 * Without a layer it is `fetchSource`.
 *
 * @category services
 * @since 0.1.0
 */
export const ShapeSource: Context.Reference<Source> = Context.Reference<Source>(
  "@smthrs/effect-electric/ShapeSource",
  { defaultValue: () => fetchSource }
)

/**
 * `source`, each request (the first, a live one, a reconnect) waiting until
 * `open`'s latest value is `true`. While it waits, nothing reaches the
 * network, and the collection stays loading: it never reads as empty. A
 * request already sent runs to its end; the next one waits again.
 *
 * Use it to open a shape only on demand: when someone is signed in, when a
 * view shows the shape's rows. `open` must give its current value first, as
 * a `SubscriptionRef`'s `changes` or a live query's rows do; a stream that
 * ends without `true` leaves requests waiting until the collection closes.
 *
 * @category combinators
 * @since 0.2.0
 */
export const gated = (source: Source, open: Stream.Stream<boolean>): Source => {
  const opened = open.pipe(
    Stream.filter((value) => value),
    Stream.runHead,
    Effect.flatMap((first) => Option.isSome(first) ? Effect.void : Effect.never)
  )
  return {
    cacheNamespace: source.cacheNamespace,
    request: (url, init) => Effect.andThen(opened, source.request(url, init))
  }
}

/**
 * Which requests a fault applies to: every one, or only live requests (the
 * long polls that follow the shape).
 *
 * @category models
 * @since 0.1.0
 */
export type Requests = "all" | "live"

/**
 * The switches of `layerFaulty`'s source. Each fault lasts until the next
 * switch; `heal` returns to the real source and lets stalled responses
 * through.
 *
 * @category models
 * @since 0.1.0
 */
export interface Switches {
  /** Requests fail on the network and never reach Electric, as when a device is offline. */
  readonly down: (requests?: Requests) => Effect.Effect<void>
  /** Requests are answered with `status` (default 400) and never reach Electric, as by a gateway. */
  readonly refuse: (status?: number, requests?: Requests) => Effect.Effect<void>
  /** Responses that arrive from Electric, a long poll's included, are held until `heal`, as on a slow link. */
  readonly stall: (requests?: Requests) => Effect.Effect<void>
  /** Responses that arrive from Electric come back with its status and headers but a body cut short. */
  readonly corrupt: (requests?: Requests) => Effect.Effect<void>
  /**
   * Responses that arrive from Electric keep their status and headers, and their body ends after its first `bytes`
   * bytes, as when a proxy closes a response early. A negative `bytes` counts back from the body's end.
   */
  readonly cut: (bytes: number, requests?: Requests) => Effect.Effect<void>
  /**
   * Responses that arrive from Electric keep their status and headers, and reading their body fails after its first
   * `bytes` bytes, as when the connection drops. A negative `bytes` counts back from the body's end.
   */
  readonly drop: (bytes: number, requests?: Requests) => Effect.Effect<void>
  /** Back to the real source; stalled responses go through. */
  readonly heal: Effect.Effect<void>
  /** Every request's URL, in the order sent. */
  readonly sent: Effect.Effect<ReadonlyArray<URL>>
}

/**
 * The switches of the faulty source a `layerFaulty` provides.
 *
 * @category services
 * @since 0.1.0
 */
export class Faults extends Context.Service<Faults, Switches>()("@smthrs/effect-electric/ShapeSource/Faults") {}

type Fault =
  | { readonly _tag: "Down" | "Stall" | "Corrupt"; readonly requests: Requests }
  | { readonly _tag: "Refuse"; readonly requests: Requests; readonly status: number }
  | { readonly _tag: "Cut" | "Drop"; readonly requests: Requests; readonly bytes: number }

const applies = (requests: Requests, url: URL): boolean => requests === "all" || url.searchParams.get("live") === "true"

// A body that gives `bytes`, then fails as a dropped connection does.
const breaksOff = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
  let given = false
  return new ReadableStream({
    pull: (controller) => {
      if (given) return controller.error(new TypeError("terminated"))
      given = true
      controller.enqueue(bytes)
    }
  })
}

/**
 * The test implementation of `ShapeSource`: the source in place when the
 * layer is built, behind `Faults` switches. Healthy, it is that source
 * unchanged. `start` throws switches before anything uses the source, for a
 * program that must start with sync already failing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFaulty = (
  start: (switches: Switches) => Effect.Effect<void> = () => Effect.void
) =>
  Layer.effectContext(Effect.gen(function*() {
    const real = yield* ShapeSource
    const fault = yield* Ref.make<Fault | undefined>(undefined)
    const healed = yield* Latch.make(true)
    const sent = yield* Ref.make<ReadonlyArray<URL>>([])
    const set = (next: Fault) => Effect.andThen(healed.close, Ref.set(fault, next))

    // Down and refuse act when a request starts; stall, corrupt, cut and drop when its response arrives, so a stall also
    // holds a long poll that was already waiting at Electric.
    const source: Source = {
      cacheNamespace: real.cacheNamespace,
      request: (url, init) =>
        Effect.gen(function*() {
          const parsed = new URL(url)
          yield* Ref.update(sent, (urls) => [...urls, parsed])
          const before = yield* Ref.get(fault)
          if (before?._tag === "Down" && applies(before.requests, parsed)) return yield* new RequestFailed({})
          if (before?._tag === "Refuse" && applies(before.requests, parsed)) {
            return Response.json({ message: "Refused" }, { status: before.status })
          }
          const response = yield* real.request(url, init)
          const after = yield* Ref.get(fault)
          if (after?._tag === "Stall" && applies(after.requests, parsed)) yield* healed.await
          if (after?._tag === "Corrupt" && applies(after.requests, parsed)) {
            return new Response("[{", { status: response.status, headers: response.headers })
          }
          if ((after?._tag === "Cut" || after?._tag === "Drop") && applies(after.requests, parsed)) {
            const body = yield* Effect.tryPromise({
              try: () => response.arrayBuffer(),
              catch: () => new RequestFailed({})
            })
            const kept = new Uint8Array(body).slice(0, after.bytes)
            return new Response(after._tag === "Cut" ? kept : breaksOff(kept), {
              status: response.status,
              headers: response.headers
            })
          }
          return response
        })
    }
    const switches = Faults.of({
      down: (requests = "all") => set({ _tag: "Down", requests }),
      refuse: (status = 400, requests = "all") => set({ _tag: "Refuse", requests, status }),
      stall: (requests = "all") => set({ _tag: "Stall", requests }),
      corrupt: (requests = "all") => set({ _tag: "Corrupt", requests }),
      cut: (bytes, requests = "all") => set({ _tag: "Cut", requests, bytes }),
      drop: (bytes, requests = "all") => set({ _tag: "Drop", requests, bytes }),
      heal: Effect.andThen(Ref.set(fault, undefined), healed.open).pipe(Effect.asVoid),
      sent: Ref.get(sent)
    })
    yield* start(switches)
    return Context.make(Faults, switches).pipe(Context.add(ShapeSource, source))
  }))
