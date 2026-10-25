import { FlowRegistry } from "../flows/registry"
// A browser tab's repository feature in Node, as React drives it: the `Repo` layer's plain actions, lookups and live
// queries, and the repository's home (the `Home` layer), over the real store and client, and dispatch over this device's engine: the Node host running the
// repository flows and `app/navigate` (src/features/repo/steps.ts), as the engine worker registers them. The tab answers
// its engine's clipboard and navigation channels, as src/boot.ts composes them. RepoApi is reached through `fetch`
// (RepoApi's real handler in repo.test.ts); an unhappy path gives the tab and its engine a faulty `RepoClient`, or a
// faulty shape source, instead (test.faults-by-injection). Nothing here intercepts a request.
import { Action } from "@smthrs/flow"
import { ShapeSource } from "@smthrs/effect-electric"
import { type Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { TabChannel } from "@smthrs/platform-browser"
import { type Duration, Effect, Layer, Logger, ManagedRuntime, Metric, type Schedule } from "effect"
import { FetchHttpClient } from "effect/http"
import { build } from "../../worker/test/flowHost.ts"
import type { AuthStore } from "../features/auth/store"
import { HomeClient } from "../features/home/api"
import { Home } from "../features/home/home"
import { HomeStore } from "../features/home/store"
import { FilesPage } from "../features/files/actions"
import { Files } from "../features/files/files"
import * as FileFlows from "../features/files/flows"
import { FilesStore } from "../features/files/store"
import { tabFiles } from "../features/files/tab"
import * as Navigation from "../features/navigation/flows"
import { tabNavigation } from "../features/navigation/tab"
import { RepoClient } from "../features/repo/api"
import { Clipboard } from "../clipboard"
import { TabClipboard } from "../features/repo/copy"
import { RepoAbout, RepoCloneRequest, RepoCopy, RepoRead, RepoRefs, RepoTree } from "../features/repo/flows"
import { Repo } from "../features/repo/repo"
import * as RepoSteps from "../features/repo/steps"
import { RepoStore } from "../features/repo/store"
import { tabClipboard } from "../features/repo/tab"
import { ClientEngine, FlowDispatch } from "../flows/dispatch"
import type { TabRequests } from "../flows/requests"
import { CodeIntel } from "../features/code-intel/codeIntel"
import type { LanguageServers } from "../features/code-intel/session"
import { CodeIntelStore } from "../features/code-intel/store"

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

export interface DeviceOptions {
  /** Optional real router used by navigation integration tests. */
  readonly navigate?: (path: string) => void
  /** RepoApi's origin. */
  readonly origin: string
  /** How the tab reaches RepoApi and Electric: the global `fetch` unless set. */
  readonly fetch?: typeof globalThis.fetch
  /** The client in place of the real one, for an unhappy path: the tab's and its engine's. */
  readonly client?: Layer.Layer<RepoClient>
  /** The home's client in place of the real one (ChatApi's home route on `origin`), for an unhappy path. */
  readonly homeClient?: Layer.Layer<HomeClient>
  /** The real home store with injected scheduling faults. */
  readonly homeStore?: typeof HomeStore.layer
  /**
   * `down`: every shape request fails on the network, as offline. `stalled`: every shape response is held until `heal`,
   * as a cold shape that takes its time.
   */
  readonly shapes?: "real" | "down" | "stalled"
  /** How long a failed shape request waits: the store's default unless set. */
  readonly retry?: Schedule.Schedule<unknown, ShapeSource.RequestFailed>
  /** How long Electric gets to deliver a clone's row: the store's default unless set. */
  readonly confirmWithin?: Duration.Input
  /** How long a navigation's warm waits for the files: the store's default unless set. */
  readonly pageWait?: Duration.Input
  /** The clipboard's write: kept in `copied` unless set. */
  readonly writeText?: (text: string) => Promise<void>
  /** Sign-in's store, when the app has sign-in. */
  readonly auth?: Layer.Layer<AuthStore, Collection.LoadFailed>
  /** `refusing`: this tab's engine refuses every dispatch, as an engine that can't start a run does. */
  readonly engine?: "running" | "refusing"
  /** Code intelligence over these language servers (src/test/languageServer.ts); none unless set. */
  readonly languageServers?: Layer.Layer<LanguageServers>
  /** The device store; memory unless a persistence or recovery test supplies SQLite. */
  readonly persistence?: Layer.Layer<Persistence.Persistence>
}

/** The flows this device's engine runs, as the registry names them. */
const flows = [
  RepoTree,
  RepoRead,
  RepoRefs,
  RepoAbout,
  RepoCloneRequest,
  RepoCopy,
  Navigation.Navigate,
  FileFlows.OpenFile,
  FileFlows.CloseFile,
]

/**
 * A tab: the repository layer over `options`, recording its log lines, metrics, clipboard and navigations, with
 * dispatch over an engine of its own, closed with `dispose`.
 */
export const openTab = async (options: DeviceOptions) => {
  const logs: Array<StructuredLog> = []
  const copied: Array<string> = []
  const navigated: Array<string> = []
  const registry: Metric.MetricRegistry = new Map()
  const fetch = options.fetch ?? globalThis.fetch
  const name = `repo-${crypto.randomUUID()}`
  const client = options.client ??
    RepoClient.layer({ origin: options.origin, within: "10 seconds" }).pipe(Layer.provide(FetchHttpClient.layer))
  // Each real browser tab has its own module realm. These Node tabs share Electric's URL-keyed replay caches,
  // so give each tab a namespace just as src/test/chatApi.ts does; it is never sent to RepoApi.
  const shapes = Layer.effect(ShapeSource.ShapeSource, Effect.map(ShapeSource.ShapeSource, (source) => ({
    ...source,
    cacheNamespace: name,
  }))).pipe(Layer.provideMerge(options.shapes === "down"
    ? ShapeSource.layerFaulty((switches) => switches.down())
    : options.shapes === "stalled"
    ? ShapeSource.layerFaulty((switches) => switches.stall())
    : Layer.empty))
  // The engine: the Node host over the compose Postgres, running what the engine worker registers for these flows.
  const registration = Layer.mergeAll(RepoSteps.registration, Navigation.registration, FileFlows.registration).pipe(
    Layer.provide(TabClipboard.layerChannel({ name, origin: options.origin })),
    Layer.provide(FileFlows.FileTabsTabs.layerChannel({ name })),
    Layer.provide(Navigation.Tabs.layerChannel({ name, origin: options.origin })),
    Layer.provide(TabChannel.layer),
    Layer.provide(client),
    Layer.provideMerge(Action.layerImplementations),
  )
  const engine = Layer.effectContext(Effect.map(build(registration, { maxConnections: 2 }), ({ context }) => context))
  // The router's location, as `at` sets it; file tabs' navigations go to `navigated` too, and move it.
  let pathname = "/"
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Repo.layer,
      Files.layer.pipe(
        Layer.provideMerge(tabFiles({ name }).pipe(Layer.provide(TabChannel.layer))),
        Layer.provideMerge(FilesStore.layer),
        Layer.provideMerge(
          FilesPage.layer({
            pathname: () => pathname,
            navigate: (path) => {
              navigated.push(path)
              pathname = path.split("?")[0]!
              options.navigate?.(path)
            },
          }),
        ),
      ),
      Home.layer.pipe(Layer.provide(options.homeStore ?? HomeStore.layer)),
      options.languageServers === undefined
        ? Layer.empty
        : CodeIntel.layer.pipe(Layer.provide(CodeIntelStore.layer), Layer.provide(options.languageServers)),
    ).pipe(
      Layer.provideMerge(
        RepoStore.layer({
          origin: options.origin,
          ...(options.confirmWithin === undefined ? {} : { confirmWithin: options.confirmWithin }),
          ...(options.pageWait === undefined ? {} : { pageWait: options.pageWait }),
          ...(options.retry === undefined ? {} : { retry: options.retry }),
        }),
      ),
      Layer.provideMerge(options.auth ?? Layer.empty),
      // Above dispatch, which remembers this tab's requests, as src/boot.ts composes them.
      Layer.provideMerge(
        Layer.merge(
          tabClipboard({ name }),
          tabNavigation({ name, origin: options.origin, navigate: (path) => void navigated.push(path) }),
        ).pipe(Layer.provide(TabChannel.layer)),
      ),
      Layer.provideMerge(FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer))),
      Layer.provideMerge(
        ClientEngine.layerRuntime(options.engine === "refusing" ? [] : flows).pipe(Layer.provide(engine)),
      ),
      Layer.provideMerge(shapes),
      Layer.provideMerge(options.persistence ?? Persistence.memory),
      Layer.provideMerge(client),
      Layer.provideMerge(
        options.homeClient ??
          HomeClient.layer({ origin: options.origin, within: "10 seconds" }).pipe(
            Layer.provide(FetchHttpClient.layer),
          ),
      ),
      Layer.provideMerge(Clipboard.layer(options.writeText ?? (async (text) => void copied.push(text)))),
      Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, registry)),
      Layer.provideMerge(
        Logger.layer([Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))]),
      ),
    // AuthStore is there only when `auth` gave it; a test reads it only then.
    ) as Layer.Layer<Repo | Home | RepoStore | AuthStore | Files | FilesStore | FlowDispatch | TabRequests, Collection.LoadFailed>,
  )
  const repo = await runtime.runPromise(Effect.service(Repo))
  const files = await runtime.runPromise(Effect.service(Files))
  files.queries.tabs.startSyncImmediate()
  const home = await runtime.runPromise(Effect.service(Home))
  const codeIntel = options.languageServers === undefined
    ? undefined
    : await runtime.runPromise(Effect.service(CodeIntel) as Effect.Effect<CodeIntel["Service"]>)
  codeIntel?.queries.state.startSyncImmediate()
  // What React's live queries start on first render; the home's stack is a function of the repository, started by its
  // own reader.
  for (const query of [...Object.values(repo.queries), ...Object.values(home.queries)]) {
    if (typeof query !== "function") query.startSyncImmediate()
  }
  const count = (
    metric: Metric.Metric<number, Metric.CounterState<number>>,
    attributes: Record<string, string> = {},
  ) =>
    runtime.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  const histogramCount = (metric: Metric.Metric<number, Metric.HistogramState>, attributes: Record<string, string>) =>
    runtime.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  return {
    repo,
    home,
    files,
    /** Puts the router's location at `path`, as a navigation does before its route opens. */
    at: (path: string) => void (pathname = path),
    /** The open files, in the order they opened. */
    tabs: () => files.queries.tabs.toArray,
    codeIntel,
    runtime,
    logs,
    copied,
    navigated,
    count,
    histogramCount,
    /** The log lines with `message`. */
    lines: (message: string) => logs.filter((log) => log.message === message),
    /** Lets held shape responses through (`shapes: "stalled"`), and the shapes answer from then on. */
    // The faulty source is there only when `shapes` asked for one; a test calls `heal` only then.
    heal: () => runtime.runPromise(Effect.flatMap(Effect.service(ShapeSource.Faults), (faults) => faults.heal) as Effect.Effect<void>),
    /** The view as the header and page read it. */
    view: () => repo.queries.view.toArray[0]!,
    refs: () => repo.queries.refs.toArray[0]!,
    tree: () => repo.queries.tree.toArray[0]!,
    file: () => repo.queries.file.toArray[0]!,
    readme: () => repo.queries.readme.toArray[0]!,
    about: () => repo.queries.about.toArray[0]!,
    manifest: () => repo.queries.manifest.toArray[0]!,
    dispose: () => runtime.dispose(),
  }
}

export type Tab = Awaited<ReturnType<typeof openTab>>
