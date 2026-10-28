/**
 * The durable flow engine, as a tab sees it.
 *
 * The engine runs in one dedicated worker per origin, the leader's (see
 * `BrowserRuntime`). {@link layer} starts this tab's worker, which waits its
 * turn to lead, and gives the tab a {@link BrowserEngine} that sends start,
 * poll, cancel and signal requests to whichever worker leads now, over the
 * engine's `BroadcastChannel`, and receives the engine's events back. A tab
 * whose own worker leads talks to it the same way.
 *
 * When the leader's tab closes, the next worker takes the lock, resumes due
 * runs from the store and announces itself; every tab then sends its
 * unanswered requests again. Requests are idempotent, so one the old leader
 * handled before it died is safe to repeat.
 *
 * When the tab's own worker fails, because it threw while loading or its
 * engine could not be built, the tab cannot lead, and no request of its waits
 * for a leader that may never come: pending requests fail with
 * {@link EngineUnavailable}, and {@link Service.unavailable} says why. A new
 * leader announcement restores later requests.
 *
 * @since 1.0.0
 */

import type { RunInspection } from "@smthrs/engine-store"
import type { Flow as FlowTypes } from "@smthrs/flow"
import { RetryPolicy, RunMetrics } from "@smthrs/flow"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Protocol from "./internal/Protocol.ts"
import * as RunReads from "./internal/RunReads.ts"
import { StoragePersistence } from "./StoragePersistence.ts"
import * as StoragePersistenceLayer from "./StoragePersistence.ts"
import { TabChannel } from "./TabChannel.ts"
import * as TabChannelLayer from "./TabChannel.ts"

/**
 * The leader refused a request. `error` is the tag of what it failed with,
 * such as `@smthrs/flow/FlowRuntime/FlowExecutionNotFound` for a poll of an
 * execution the store does not hold.
 *
 * @category errors
 * @since 1.0.0
 */
export class RequestRefused extends Schema.TaggedError<RequestRefused>()(
  "@smthrs/platform-browser/RequestRefused",
  {
    request: Schema.String,
    error: Schema.String
  }
) {}

/**
 * This tab's engine worker failed; requests fail until another leader announces itself: `reason` is
 * `worker-failed` when the worker threw, as when its module fails to load,
 * `engine-failed` when the worker could not build the engine, as without
 * OPFS, and `channel-overflow` when this tab fell the engine channel's
 * capacity behind (`TabChannelOverflow`), so it hears no leader again until it
 * reloads. `error` is the failure's tag or name, never its message.
 *
 * @category errors
 * @since 1.0.0
 */
export class EngineUnavailable extends Schema.TaggedError<EngineUnavailable>()(
  "@smthrs/platform-browser/EngineUnavailable",
  {
    reason: Schema.Literals(["worker-failed", "engine-failed", "channel-overflow"]),
    error: Schema.String
  }
) {}

/**
 * An event the engine committed for a run: a step started or finished, a
 * timer was set, the run settled.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunEvent {
  readonly executionId: string
  readonly eventType: string
}

/**
 * The slice of `Worker` this module uses: the tab's engine worker, which
 * calls `BrowserRuntime.run`.
 *
 * @category models
 * @since 1.0.0
 */
export interface WorkerLike {
  terminate(): void
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
}

/**
 * What a tab needs of a flow to run it: its tag and its schemas. A whole flow
 * is one, and so is a plain object holding just these four, so a tab can
 * start, await, cancel and signal a flow without importing what its steps run
 * on; only the worker that runs the flow needs its declaration.
 *
 * @category models
 * @since 1.0.0
 */
export type FlowReference = Pick<FlowTypes.Any, "_tag" | "payloadSchema" | "successSchema" | "errorSchema">

/**
 * What {@link layer} starts.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The engine's name; the worker passes the same one to `BrowserRuntime.run`. */
  readonly name: string
  /**
   * Starts this tab's engine worker, such as
   * `() => new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" })`.
   * The worker is terminated when the layer's scope closes.
   */
  readonly worker: () => WorkerLike
}

/**
 * Engine operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  /**
   * Admits `executionId` with `payload` and returns once the leader recorded
   * it; the run continues in the background. Starting the same execution
   * again is a no-op.
   */
  readonly start: <F extends FlowReference>(
    flow: F,
    options: { readonly executionId: string; readonly payload: F["payloadSchema"]["Type"] }
  ) => Effect.Effect<void, RequestRefused | Schema.SchemaError | EngineUnavailable>
  /**
   * Waits for `executionId` to settle and returns how it ended. A cancelled
   * run ends interrupted.
   */
  readonly result: <F extends FlowReference>(
    flow: F,
    executionId: string
  ) => Effect.Effect<
    Exit.Exit<F["successSchema"]["Type"], F["errorSchema"]["Type"]>,
    RequestRefused | Schema.SchemaError | EngineUnavailable
  >
  /** Requests cancellation of `executionId`. */
  readonly cancel: (flow: FlowReference, executionId: string) => Effect.Effect<void, RequestRefused | EngineUnavailable>
  /** Resolves `executionId`'s `WaitFor` point `name` with `value`. */
  readonly signal: (
    flow: FlowReference,
    executionId: string,
    name: string,
    value: Schema.Json
  ) => Effect.Effect<void, RequestRefused | EngineUnavailable>
  /**
   * Reads one run of the leader's engine: its lifecycle, its steps with their
   * attempts, the runs it started, and the page of its journal after
   * `afterSeq`, at most `limit` events (500 at most). Every value is redacted
   * and cut to 16 KiB by the leader (`@smthrs/engine-store`'s
   * `RunInspection`). A run the engine never held is refused with
   * `@smthrs/engine-store/RunNotFound`.
   */
  readonly inspect: (
    runId: string,
    options?: { readonly afterSeq?: number; readonly limit?: number }
  ) => Effect.Effect<RunInspection.Inspection, RequestRefused | EngineUnavailable>
  /**
   * Lists the leader's runs newest first, `limit` at a time (200 at most)
   * from `cursor`; `roots`, the default, keeps the runs with no parent;
   * `flows` keeps only the runs of those flows, by tag (64 at most).
   */
  readonly list: (
    options?: {
      readonly limit?: number
      readonly cursor?: string
      readonly roots?: boolean
      readonly flows?: ReadonlyArray<string>
    }
  ) => Effect.Effect<RunInspection.RunList, RequestRefused | EngineUnavailable>
  /**
   * The leader's runs as `list` reads them (`limit`, `roots` and `flows` as
   * there): read once subscribed, then again after the events committed
   * since and after each new leader, at most once per `every` (250 ms unless
   * set). With `within`, each read is every run created that long ago or
   * since, page after page, rather than the newest page. A run that settled
   * appears in the next read without an event of its own. A read that fails
   * emits nothing, logs `browser.engine.runs` once per run of failures, and is
   * read again after a backoff from 250 ms doubling to 5 s, or sooner on the
   * next event or leader. The stream never fails.
   */
  readonly runs: (
    options?: {
      readonly limit?: number
      readonly roots?: boolean
      readonly flows?: ReadonlyArray<string>
      readonly within?: Duration.Input
      readonly every?: Duration.Input
    }
  ) => Stream.Stream<RunInspection.RunList>
  /** Every event the leader's engine commits from now on, for every run. */
  readonly events: Stream.Stream<RunEvent>
  /**
   * Completes with why, once this tab's engine worker failed; never while it
   * runs. An app shows its engine-failure state from it instead of a hang.
   */
  readonly unavailable: Effect.Effect<EngineUnavailable>
}

/**
 * Service tag for the tab's view of the engine.
 *
 * @category services
 * @since 1.0.0
 */
export class BrowserEngine extends Context.Service<BrowserEngine, Service>()(
  "@smthrs/platform-browser/BrowserEngine"
) {}

/**
 * One run as `inspect` answers it, `@smthrs/engine-store`'s
 * `RunInspection.Inspection`, as a schema a tab decodes with. A tab that reads
 * a run from elsewhere, such as a server inspecting its own engine, decodes
 * that answer with it too, without loading `@smthrs/engine-store`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Inspection = RunReads.Inspection

/**
 * A page of runs as `list` answers it, `RunInspection.RunList`, as a schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RunList = RunReads.RunList

/** The first wait before `runs` reads again after a failed read, and the longest. */
const RUNS_BACKOFF_MS = 250
const RUNS_BACKOFF_CAP_MS = 5_000

/**
 * Requests this tab sent, by `request` and `outcome` (`replied` or `refused`).
 *
 * @category metrics
 * @since 1.0.0
 */
export const requests = Metric.counter("smithers_browser_engine_requests", {
  description: "Requests a tab sent to the browser engine's leader, by request and outcome",
  incremental: true
})

/**
 * Tabs whose engine worker failed, by `reason` (`worker-failed` or
 * `engine-failed`).
 *
 * @category metrics
 * @since 1.0.0
 */
export const unavailable = Metric.counter("smithers_browser_engine_unavailable", {
  description: "Tabs whose engine worker failed, so they have no engine, by reason",
  incremental: true
})

/**
 * Persistent-storage answers, by `outcome` (`granted` or `denied`).
 *
 * @category metrics
 * @since 1.0.0
 */
export const persistence = Metric.counter("smithers_browser_engine_storage", {
  description: "Whether the origin holds persistent storage, asked once per tab",
  incremental: true
})

type Reply = Extract<Protocol.Message, { readonly _tag: "Replied" | "Refused" }>
type Notice = Extract<Protocol.Message, { readonly _tag: "Leader" | "RunChanged" }>
type Body = Protocol.Request extends infer R ? R extends Protocol.Request ? Omit<R, "client" | "id"> : never : never

/**
 * Builds the service: starts the tab's worker, asks for persistent storage,
 * and opens the engine's channel, all closed with the scope.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Effect.Effect<Service, never, TabChannel | StoragePersistence | Scope.Scope> =>
  Effect.gen(function*() {
    const port = yield* (yield* TabChannel).open(options.name)
    const inbox = yield* port.subscribe
    const notices = yield* Effect.acquireRelease(PubSub.unbounded<Notice>(), PubSub.shutdown)
    const client = crypto.randomUUID()
    const pending = new Map<
      number,
      { readonly message: Protocol.Request; readonly reply: Deferred.Deferred<Reply, EngineUnavailable> }
    >()
    let next = 0
    let failed = yield* Deferred.make<EngineUnavailable>()
    // Fails requests until a live leader announces itself, and records why.
    const fail = (reason: EngineUnavailable["reason"], error: string) =>
      Effect.gen(function*() {
        const failure = new EngineUnavailable({ reason, error })
        if (!(yield* Deferred.succeed(failed, failure))) return
        yield* Metric.update(Metric.withAttributes(unavailable, { reason }), 1)
        yield* Effect.logError("browser.engine.unavailable").pipe(Effect.annotateLogs({ reason, "error.type": error }))
        for (const { reply } of pending.values()) yield* Deferred.fail(reply, failure)
      })
    const unavailableFailure = Effect.suspend(() => Effect.flatMap(Deferred.await(failed), Effect.fail))

    yield* Stream.fromQueue(inbox).pipe(
      Stream.runForEach((input) =>
        Effect.gen(function*() {
          const message = Protocol.decode(input)
          switch (message?._tag) {
            case "Replied":
            case "Refused": {
              // A reply to a request already answered, by a leader that died
              // after answering it, finds nothing waiting.
              const waiting = message.client === client ? pending.get(message.id) : undefined
              if (waiting !== undefined) yield* Deferred.succeed(waiting.reply, message)
              return
            }
            case "Leader": {
              if (yield* Deferred.isDone(failed)) failed = yield* Deferred.make<EngineUnavailable>()
              for (const { message: request } of pending.values()) yield* port.post(Protocol.encode(request))
              yield* PubSub.publish(notices, message)
              return
            }
            case "RunChanged": {
              yield* PubSub.publish(notices, message)
              return
            }
          }
        })
      ),
      // Behind by the channel's capacity, this tab hears no leader again: every request fails until it reloads.
      Effect.catch((overflow) => fail("channel-overflow", overflow._tag)),
      Effect.forkScoped
    )

    yield* Effect.forkScoped(
      (yield* StoragePersistence).persist.pipe(
        Effect.tap((granted) => {
          const outcome = granted ? "granted" : "denied"
          return Metric.update(Metric.withAttributes(persistence, { outcome }), 1).pipe(
            Effect.andThen(Effect.logInfo("browser.engine.storage").pipe(Effect.annotateLogs({ outcome })))
          )
        })
      )
    )

    // The worker reports its failures outside any fiber: an error event when
    // it throws, and `Stopped` when its engine could not be built.
    const runFork = Effect.runForkWith(yield* Effect.context<never>())
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const worker = options.worker()
        worker.addEventListener("error", (event) => {
          runFork(fail("worker-failed", String((event.error as Error | null | undefined)?.name ?? "ErrorEvent")))
        })
        worker.addEventListener("message", (event) => {
          const stopped = Protocol.decodeStopped(event.data)
          if (stopped !== undefined) runFork(fail("engine-failed", stopped.error))
        })
        return worker
      }),
      (worker) => Effect.sync(() => worker.terminate())
    ).pipe(Effect.catchCause((cause) => fail("worker-failed", RetryPolicy.failureType(cause))))

    const request = (
      body: Body
    ): Effect.Effect<Protocol.Message & { readonly _tag: "Replied" }, RequestRefused | EngineUnavailable> =>
      Effect.gen(function*() {
        const id = next++
        const message = { ...body, client, id } as Protocol.Request
        const reply = yield* Deferred.make<Reply, EngineUnavailable>()
        pending.set(id, { message, reply })
        // Registered first, so a failure from now on reaches it either way.
        if (yield* Deferred.isDone(failed)) yield* Deferred.fail(reply, yield* Deferred.await(failed))
        const answer = yield* port.post(Protocol.encode(message)).pipe(
          Effect.andThen(Deferred.await(reply)),
          Effect.ensuring(Effect.sync(() => pending.delete(id)))
        )
        const outcome = answer._tag === "Replied" ? "replied" : "refused"
        yield* Metric.update(Metric.withAttributes(requests, { request: body._tag, outcome }), 1)
        yield* Effect.annotateCurrentSpan({ "smithers.request.outcome": outcome })
        if (answer._tag === "Refused") {
          return yield* new RequestRefused({ request: body._tag, error: answer.error })
        }
        return answer
      }).pipe(
        Effect.withSpan("browser.engine.request", {
          attributes: {
            "smithers.request": body._tag,
            ...("flow" in body ? { "smithers.flow": body.flow, "smithers.execution.id": body.executionId } : {}),
            ...("runId" in body ? { "smithers.execution.id": body.runId } : {})
          }
        })
      )

    /** A read's reply, decoded; a reply this tab cannot read is refused as `SchemaError`. */
    const read = <A>(
      body: Body,
      decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>
    ): Effect.Effect<A, RequestRefused | EngineUnavailable> =>
      request(body).pipe(
        Effect.flatMap((reply) =>
          decode(reply.result).pipe(
            Effect.mapError(() => new RequestRefused({ request: body._tag, error: "SchemaError" }))
          )
        )
      )

    const poll = (flow: FlowReference, executionId: string) =>
      request({ _tag: "Poll", flow: flow._tag, executionId }).pipe(
        Effect.flatMap((reply) =>
          reply.result === null
            ? Effect.succeed(undefined)
            : Schema.decodeUnknownEffect(Protocol.resultCodec(flow))(reply.result)
        )
      )

    const list: Service["list"] = (options = {}) => read({ _tag: "List", ...options }, RunReads.decodeRunList)

    /** One read for `runs`: the newest page, or, `within` a window, every page back to its start. */
    const readWindow = (
      options: { readonly limit?: number; readonly roots?: boolean; readonly flows?: ReadonlyArray<string> },
      within: Duration.Input | undefined
    ) =>
      within === undefined ? list(options) : Effect.gen(function*() {
        const since = (yield* Clock.currentTimeMillis) - Duration.toMillis(within)
        let page = yield* list(options)
        const runs = [...page.runs]
        // Newest first: the window ends at the first run created before it, or with the runs.
        while (page.cursor !== null && page.runs.every((run) => run.createdAtMs >= since)) {
          page = yield* list({ ...options, cursor: page.cursor })
          runs.push(...page.runs)
        }
        return { runs: runs.filter((run) => run.createdAtMs >= since), cursor: null }
      })

    const runs: Service["runs"] = (
      { every = "250 millis", within, ...options }: NonNullable<Parameters<Service["runs"]>[0]> = {}
    ) =>
      Stream.unwrap(Effect.gen(function*() {
        // Subscribed before the first read, so a change between the read and
        // the next one is not missed.
        const changes = yield* PubSub.subscribe(notices)
        // A failed read reads again on its own: no later event may come.
        const again = yield* Queue.unbounded<void>()
        const failures = yield* Ref.make(0)
        const scope = yield* Effect.scope
        const snapshot = readWindow(options, within).pipe(
          Effect.tap(() => Ref.set(failures, 0)),
          Effect.map(Option.some),
          Effect.catch((failure) =>
            Effect.gen(function*() {
              const failed = yield* Ref.getAndUpdate(failures, (count) => count + 1)
              // Once per run of failures, never again until a read succeeds.
              yield* failed > 0 ? Effect.void : Effect.logWarning("browser.engine.runs").pipe(
                Effect.annotateLogs({
                  outcome: "unread",
                  "error.type": failure._tag === "@smthrs/platform-browser/RequestRefused"
                    ? failure.error
                    : failure.reason
                })
              )
              const wait = Math.min(RUNS_BACKOFF_MS * 2 ** failed, RUNS_BACKOFF_CAP_MS)
              yield* Effect.forkIn(Effect.andThen(Effect.sleep(wait), Queue.offer(again, undefined)), scope)
              return Option.none<RunInspection.RunList>()
            })
          )
        )
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.merge(Stream.fromSubscription(changes).pipe(Stream.as(undefined)), Stream.fromQueue(again)).pipe(
            Stream.groupedWithin(Number.MAX_SAFE_INTEGER, every),
            Stream.mapEffect(() => snapshot)
          )
        ).pipe(Stream.filterMap((read) => Option.isSome(read) ? Result.succeed(read.value) : Result.failVoid))
      }))

    return BrowserEngine.of({
      start: (flow, { executionId, payload }) =>
        (Schema.encodeEffect(Schema.toCodecJson(flow.payloadSchema))(payload) as Effect.Effect<
          Schema.Json,
          Schema.SchemaError
        >).pipe(
          // The caller's door and actor kind travel with the start, so the
          // leader's engine labels the run's usage metrics with them.
          Effect.flatMap((encoded) =>
            Effect.gen(function*() {
              const origin = yield* RunMetrics.CurrentOrigin
              return yield* request({
                _tag: "Start",
                flow: flow._tag,
                executionId,
                payload: encoded,
                origin: { door: origin.door, actor: origin.actor }
              })
            })
          ),
          Effect.asVoid
        ),
      result: (flow, executionId) =>
        Effect.scoped(Effect.gen(function*() {
          // Subscribed before the first poll, so an event between the poll and
          // the wait is not missed.
          const changes = yield* PubSub.subscribe(notices)
          while (true) {
            const result = yield* poll(flow, executionId)
            if (result !== undefined && result._tag === "Complete") return result.exit
            let relevant = false
            while (!relevant) {
              const notice = yield* PubSub.take(changes)
              relevant = notice._tag === "Leader" ||
                (notice._tag === "RunChanged" && notice.executionId === executionId)
            }
          }
        })).pipe(Effect.raceFirst(unavailableFailure)),
      cancel: (flow, executionId) => Effect.asVoid(request({ _tag: "Cancel", flow: flow._tag, executionId })),
      signal: (flow, executionId, name, value) =>
        Effect.asVoid(request({ _tag: "Signal", flow: flow._tag, executionId, name, value })),
      inspect: (runId, options = {}) => read({ _tag: "Inspect", runId, ...options }, RunReads.decodeInspection),
      list,
      runs,
      events: Stream.fromPubSub(notices).pipe(
        Stream.filterMap((notice) =>
          notice._tag === "RunChanged"
            ? Result.succeed({ executionId: notice.executionId, eventType: notice.eventType })
            : Result.failVoid
        )
      ),
      unavailable: Effect.suspend(() => Deferred.await(failed))
    })
  })

/**
 * Provides the tab's {@link BrowserEngine} over the browser's own
 * `BroadcastChannel` and `navigator.storage`: the one layer an app's tab
 * composes.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options): Layer.Layer<BrowserEngine> =>
  Layer.effect(BrowserEngine, make(options)).pipe(
    Layer.provide(Layer.mergeAll(TabChannelLayer.layer, StoragePersistenceLayer.layer))
  )
