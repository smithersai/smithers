// Keeps Electric's container running between visits, and records each request the gateway's object forwards to it. A
// Durable Object's container stops shortly after the object goes idle unless the object sets an inactivity timeout
// (Cloudflare: Durable Object Container API), and a stopped Electric loses its disk: the next page load waited for the
// container to start and Electric to rebuild every shape, and Electric answered each waiting shape request 503
// meanwhile. On smithers.sh on 2026-10-22, every first load after 11 or more idle minutes (12 of 12) got 503s from
// Electric, 53 of them on one load (docs/infrastructure.md#electric). So the object holds the container for
// `INACTIVITY`, the most Cloudflare allows.
//
// Cloudflare's pattern is to set the timeout after `start()`, and again when an object is constructed while its
// container already runs: a restarted object starts without one. Until 2026-10-25 the object set it on every request,
// a call into the container's control plane on each shape request through the one object every device shares. That day
// production served about 2 shape requests a second at most: 20 at once, even malformed ones Electric refuses at once,
// waited up to 26 s, while Electric's container used at most a fifth of its CPU (docs/infrastructure.md#electric).
import { Logger } from "@smthrs/observability"
import { Clock, Duration, Effect } from "effect"

/**
 * How long the container keeps running after the object's last request: Cloudflare's maximum, 6 hours. A longer one
 * makes `setInactivityTimeout` reject. A deployment quiet for longer still starts Electric again on its next visit.
 */
export const INACTIVITY = Duration.hours(6)

/** What the gateway's object does to Electric's container. */
export interface Host<E = unknown, R = never> {
  /** Whether the container's process is running: a read, no call into the container. */
  readonly running: Effect.Effect<boolean, E, R>
  /** Starts the container unless it is running. */
  readonly start: Effect.Effect<void, E, R>
  readonly setInactivityTimeout: (ms: number) => Effect.Effect<void, E, R>
}

/** What waking Electric did for one request: whether it started the container, and whether it set the hold. */
export interface Woken {
  readonly started: boolean
  readonly held: boolean
}

/**
 * The gateway's object's waker, made once per object instance. Each request starts Electric if it isn't running; the
 * hold is set on the instance's first request and after each start, and on the next request again if Cloudflare
 * refused it, which is logged as `electric.hold` and lets the request through. Every other request only reads
 * `running`.
 */
export const makeAwake = <E, R>(host: Host<E, R>): Effect.Effect<Woken, E, R> => {
  let held = false
  return Effect.gen(function* () {
    const started = !(yield* host.running)
    if (started) {
      yield* host.start
      // A started container has no timeout of its own yet.
      held = false
    }
    if (held) return { started, held: false }
    // Taken before the call, so requests arriving meanwhile don't set it too.
    held = true
    held = yield* host.setInactivityTimeout(Duration.toMillis(INACTIVITY)).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("electric.hold").pipe(Effect.annotateLogs({ error: String(error) }), Effect.as(false))
      ),
    )
    return { started, held }
  })
}

/**
 * `effect` with its log lines written as one structured JSON line each, as ChatApi's are. Workers Logs keeps a JSON line
 * whole; Effect's default console logger writes each annotation as a line of its own, which Workers Logs stores as
 * separate events (production, 2026-10-25), so a record's fields couldn't be counted together.
 */
export const logged = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.provide(effect, logs)

const logs = Logger.layerStructuredJson()

/** Whether a shape request is a live one, which Electric holds open until the shape changes or its timeout. */
export const isLive = (url: string): boolean => new URL(url, "http://electric").searchParams.get("live") === "true"

/**
 * The requests one object instance is forwarding: each counts from its arrival until Electric's headers or its failure.
 * A live request's body, which streams for up to Electric's long poll after its headers, isn't counted.
 */
export interface InFlight {
  current: number
}

/** A count of nothing in flight, made once per object instance. */
export const makeInFlight = (): InFlight => ({ current: 0 })

/**
 * Wakes Electric, then sends the request, recording one log line `electric.object.request`: whether it was live, how
 * many requests the object was forwarding when it arrived, itself included (`inFlight`), the milliseconds waking took
 * (`awakeMs`) and then Electric's headers (`headersMs`), Electric's status, and whether the request started the
 * container or set the hold. A failure records the stage it failed at and the error's tag; never a URL, a parameter, a
 * header or a body.
 */
export const forward = <A extends { readonly status: number }, E1, R1, E2, R2>(
  wake: Effect.Effect<Woken, E1, R1>,
  send: Effect.Effect<A, E2, R2>,
  live: boolean,
  inFlight: InFlight,
): Effect.Effect<A, E1 | E2, R1 | R2> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const arrived = ++inFlight.current
    const failed = (stage: "awake" | "electric") => (error: E1 | E2) =>
      Effect.gen(function* () {
        const durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Effect.logError("electric.object.request").pipe(
          Effect.annotateLogs({ live, inFlight: arrived, outcome: "failed", stage, error: tagOf(error), durationMs }),
        )
      })
    const woken = yield* wake.pipe(Effect.tapError(failed("awake")))
    const awokeAt = yield* Clock.currentTimeMillis
    const response = yield* send.pipe(Effect.tapError(failed("electric")))
    const answeredAt = yield* Clock.currentTimeMillis
    yield* Effect.logInfo("electric.object.request").pipe(
      Effect.annotateLogs({
        live,
        inFlight: arrived,
        outcome: "answered",
        status: response.status,
        awakeMs: awokeAt - startedAt,
        headersMs: answeredAt - awokeAt,
        started: woken.started,
        held: woken.held,
      }),
    )
    return response
  }).pipe(Effect.ensuring(Effect.sync(() => void inFlight.current--)))

/**
 * Sends a request `direct`ly to Electric's port, or, when that fails before Electric answers, the `waited` way, which
 * waits until the port accepts connections. The direct way hands back the container's own response, which the object
 * returns as it is, so its body never passes through the object's JavaScript: re-streaming each body through Effect cost
 * the one object about 15 ms of CPU per request in production on 2026-10-26, and overloaded it
 * (docs/infrastructure.md#electric). Only a container still starting fails it; each fallback is logged as
 * `electric.object.port` with the error's tag.
 */
export const directOr = <A, E1, R1, E2, R2>(
  direct: Effect.Effect<A, E1, R1>,
  waited: Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E2, R1 | R2> =>
  direct.pipe(
    Effect.catch((error) =>
      Effect.logWarning("electric.object.port").pipe(Effect.annotateLogs({ error: tagOf(error) }), Effect.andThen(waited))
    ),
  )

/** An error's tag or class name, which carries no request content. */
export const tagOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const tag = (error as { readonly _tag?: unknown })._tag
    if (typeof tag === "string") return tag
    return error.constructor.name
  }
  return typeof error
}
