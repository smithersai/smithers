import { telemetryExport } from "../telemetryExport"
import { FetchFailures, LogFailures, Otlp } from "@smthrs/observability"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { TELEMETRY_ROUTE } from "../features/chat/contract"
import { tabHandlers } from "../features/theme/store"
import { apiRoute } from "../apiRoutes"
import { BROWSER_TELEMETRY, ENGINE_SERVICE, EXPORTED_SPANS, TELEMETRY_LIMITS } from "../telemetry"
import { ENGINE_NAME } from "./contract"
import { ClientEngine } from "./dispatch"
import { answer, type Endpoint } from "./tabPort"

// This device's engine as the tab sees it (docs/features/flows.md#the-engine-and-the-tab-port): the tab's view of the
// leader's engine (`tabEngine`), the tab's answers to its own worker's calls (`tabAnswers`), and where the engine
// worker's records go. The tab loads this module, so it never imports what a flow's steps run on: the registrations
// are src/flows/registrations.ts, which only an engine's host imports.

/**
 * Where the engine worker's records go: ChatApi's relay on `origin` (docs/observability.md#browser), as
 * `smithers-mvp-engine`, with only the spans the relay keeps but a request's (src/telemetry.ts `EXPORTED_SPANS`). The
 * engine's storage spans and one span per poll, hundreds per answer, stay in the worker. As in the tab, every line at
 * Warn or above is counted (`LogFailures`).
 */
export const engineTelemetry = (origin: string) =>
  LogFailures.layer({ records: BROWSER_TELEMETRY.records }).pipe(
    Layer.provideMerge(
      Otlp.layerFetch({
        baseUrl: `${origin}${TELEMETRY_ROUTE}`,
        serviceName: ENGINE_SERVICE,
        spans: EXPORTED_SPANS,
                transform: telemetryExport,
        ...TELEMETRY_LIMITS,
      }),
    ),
  )

/**
 * The engine worker's requests to the app's own /api/ on `origin`, the agent's model calls included, recorded by their
 * route template when they fail (`FetchFailures`, docs/observability.md#failed-requests): the `fetch` the worker's
 * program sends through, wrapped. The worker provides it above `engineTelemetry`, whose loggers it records through
 * and whose exporter keeps its own fetch.
 */
export const engineRequests = (origin: string) => FetchFailures.layer({ route: apiRoute(origin) })

/** The engine worker this tab started: the other end of its tab port, which `tabAnswers` answers. */
export class TabWorker extends Context.Service<TabWorker, Endpoint>()("@smthrs/mvp/flows/TabWorker") {}

/**
 * The tab's engine: starts this tab's engine worker with `worker`, gives dispatch the engine of whichever tab leads
 * (`ClientEngine`, over `BrowserEngine`), and keeps the started worker (`TabWorker`). When the worker fails,
 * `BrowserEngine`'s `unavailable` says so (it logs `browser.engine.unavailable` and counts it). `name` is the
 * engine's, `ENGINE_NAME` unless set; the worker runs the same one. It needs nothing of the tab, so it builds before
 * the device store, whose SQLite the leader's worker serves.
 */
export const tabEngine = (worker: () => BrowserEngine.WorkerLike & Endpoint, name: string = ENGINE_NAME) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const started = yield* Deferred.make<Endpoint>()
      const engine = BrowserEngine.layer({
        name,
        worker: () => {
          const running = worker()
          Deferred.doneUnsafe(started, Effect.succeed(running))
          return running
        },
      })
      return Layer.merge(ClientEngine.layerBrowser, Layer.effect(TabWorker, Deferred.await(started))).pipe(
        Layer.provideMerge(engine),
      )
    }),
  )

/**
 * The device store's options with `open` failing once this tab's engine is unavailable (`BrowserEngine`'s
 * `unavailable`), instead of waiting for a leader that will never answer: `Persistence.layer` then logs `persistence
 * unavailable` and keeps the rows in memory. The race's promise bridges `unavailable` for the host's `open`, which
 * TanStack DB calls, and ends with the layer.
 */
export const failFastOnEngine = <D extends Persistence.Database>(options: Persistence.Options<D>) =>
  Effect.gen(function* () {
    const engine = yield* BrowserEngine.BrowserEngine
    const watching = yield* Effect.forkScoped(engine.unavailable)
    const failed = Effect.runPromiseWith(yield* Effect.context<never>())(Fiber.join(watching)).then(() => {
      throw new EngineFailed()
    })
    // expected: the race below handles this rejection; until `open` runs, nothing else would
    failed.catch(() => {})
    return { ...options, open: () => Promise.race([Promise.resolve(options.open()), failed]) } satisfies Persistence.Options<D>
  })

/** This tab's engine is unavailable, so no leader will serve the device store. */
export class EngineFailed extends Error {
  override readonly name = "EngineFailed"
}

/**
 * Answers the engine worker's calls into this tab (the theme's writes) with this tab's handlers, from when it is built
 * until its scope closes. It needs the tab's `ThemeStore`, so it attaches only once the device store has opened, after
 * `tabEngine` started the worker. A call the worker makes before then goes unanswered and fails `timeout` after
 * `CALL_WITHIN` (src/flows/tabPort.ts); its step fails or runs again by its own retry policy, and every handler is a
 * setter, so running one again is harmless.
 */
export const tabAnswers = Layer.effectDiscard(
  Effect.gen(function* () {
    const stop = yield* answer(yield* TabWorker, yield* tabHandlers)
    yield* Effect.addFinalizer(() => Effect.sync(stop))
  }),
)
