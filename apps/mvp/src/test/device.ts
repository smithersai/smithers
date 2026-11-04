import { TestSchemas } from "@smthrs/database"
import { FlowRegistry } from "../flows/registry"
// A device in Node, as the browser builds it (decision 0011 §4): a tab with its own `ThemeStore`, `BrowserEngine`,
// dispatch and navigation answers (src/flows/engine.ts `tabEngine` and `tabAnswers`, src/features/navigation/tab.ts), and the leader its engine worker runs (`BrowserRuntime.serve` over every
// client flow, src/flows/registrations.ts), over Node's own Web Locks and `BroadcastChannel`. The worker is a
// `MessageChannel`: the leader reaches its tab through one port (`TabPort`), and the tab answers on the other. Only
// the engine's store differs from a browser's: the compose Postgres in place of SQLite on OPFS. ChatApi is the agent
// tests' harness (src/test/agent.ts), so the agent's model calls and writes reach the real handler.
import type { HostOptions } from "../features/agent/host"
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserEngine, BrowserRuntime, TabChannel, WebLock } from "@smthrs/platform-browser"
import { Context, Effect, Exit, Fiber, Layer, Option, Redacted, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../db/TestDatabase.ts"
import type { ThemeMode } from "../features/theme/contract"
import { ThemeStore } from "../features/theme/store"
import { Theme } from "../features/theme/theme"
import { FlowDispatch } from "../flows/dispatch"
import { clientFlows } from "../flows/declarations"
import { tabAnswers, tabEngine } from "../flows/engine"
import { tabNavigation } from "../features/navigation/tab"
import { tabDoors } from "../flows/doors"
import { FilesPage } from "../features/files/actions"
import type { Here } from "../features/files/schema"
import { FilesStore } from "../features/files/store"
import { tabFiles } from "../features/files/tab"
import { workerRegistrations } from "../flows/registrations"
import type { Endpoint } from "../flows/tabPort"
import { ORIGIN } from "./agent"
import { repoAuthority } from "./repoAuthority"

/**
 * Where a device's records go: the tab's and the engine worker's own exporters, as `src/main.tsx` and
 * `src/flows/engine.worker.ts` install them. Without them, Effect's defaults.
 */
export interface DeviceTelemetry {
  readonly tab?: Layer.Layer<never>
  readonly engine?: Layer.Layer<never>
}

/**
 * A tab's navigation answers on engine `name`, recording where it went in `navigated`, and which door its runs came
 * through, so only its own press of a person's flow runs in the person's session, as src/boot.ts composes them.
 */
const navigation = (name: string, navigated: Array<string>) =>
  Layer.mergeAll(
    tabNavigation({ name, origin: ORIGIN, navigate: (path) => void navigated.push(path) }),
    tabDoors({ name }),
  ).pipe(Layer.provide(TabChannel.layer))

/** Where a tab at `at` is, for file tabs: a repository's directory page `/<owner>/<name>/tree/<revision>`, else nowhere. */
const hereAt = (at: string | undefined): Option.Option<Here> => {
  const [owner, name, kind, ...revision] = (at ?? "").split("/").filter(Boolean)
  return owner === undefined || name === undefined || kind !== "tree" || revision.length === 0
    ? Option.none()
    : Option.some({ owner, name, revision: revision.join("/"), kind: "tree", path: "" })
}

/**
 * A tab's file tabs answers on engine `name`, as src/boot.ts composes them, its page at `at` (`hereAt`): its tabs in
 * memory, and where they took it in `navigated`, which navigation's answers record too.
 */
const files = (name: string, at: string | undefined, navigated: Array<string>) =>
  tabFiles({ name }).pipe(
    Layer.provideMerge(FilesStore.layer.pipe(Layer.provide(repoAuthority))),
    Layer.provide(Layer.succeed(FilesPage, FilesPage.of({ here: Effect.succeed(hereAt(at)), navigate: (path) => void navigated.push(path) }))),
    Layer.provide(Persistence.memory),
    Layer.provide(TabChannel.layer),
  )

/** An engine worker that never leads: a second tab's, waiting its turn. */
const idleWorker = (): BrowserEngine.WorkerLike & Endpoint => ({
  terminate: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  postMessage: () => {},
})

/** The services a built context holds. */
type ServicesOf<C> = C extends Context.Context<infer S> ? S : never

/** A tab and its engine's leader, closed with `close`. */
export const openDevice = async (
  fetch: typeof globalThis.fetch,
  telemetry: DeviceTelemetry = {},
  memorySources?: HostOptions["memorySources"],
  /** `at`: the page the tab shows, for file tabs (`hereAt`); none unless set. */
  page: { readonly at?: string } = {},
) => {
  const scope = Effect.runSync(Scope.make())
  const name = `smithers-${crypto.randomUUID()}`
  const schema = TestSchemas.schemaName("flows")
  const url = await Effect.runPromise(TestDatabase.serverUrl)
  const channel = new MessageChannel()
  channel.port1.start()
  channel.port2.start()
  const http = Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch))

  // The engine worker: the leader over every client flow, reaching its tab through port1.
  const engine = BrowserRuntime.layer(
    // The flows' own schemas render their runs' values for the run page (decision 0014 §3), as the worker's do.
    { name, flows: clientFlows },
    workerRegistrations(channel.port1, { origin: ORIGIN, name, partsEvery: "20 millis", ...(memorySources === undefined ? {} : { memorySources }) }).pipe(Layer.provide(http)),
  ).pipe(Layer.provide(PostgresDatabase.layer({ url: url.toString(), driver: Pg, schema })))
  const leader = Effect.runFork(
    BrowserRuntime.serve({ name, flows: clientFlows }, engine).pipe(
      Effect.provide(Layer.mergeAll(WebLock.layer, TabChannel.layer, telemetry.engine ?? Layer.empty)),
    ),
  )

  // The tab: its store, its view of the engine, and dispatch; its "worker" is port2.
  const painted: Array<ThemeMode | undefined> = []
  const terminated: Array<boolean> = []
  const worker = {
    postMessage: (message: unknown) => channel.port2.postMessage(message),
    addEventListener: (type: string, listener: (event: never) => void) =>
      type === "message" && channel.port2.addEventListener("message", listener as never),
    removeEventListener: (type: string, listener: (event: never) => void) =>
      type === "message" && channel.port2.removeEventListener("message", listener as never),
    terminate: () => void terminated.push(true),
  } as unknown as BrowserEngine.WorkerLike & import("../flows/tabPort").Endpoint
  const store = ThemeStore.layer({
    paint: (mode) => void painted.push(mode),
    mirror: () => {},
    system: () => "light",
    painted: () => painted.at(-1),
  })
    .pipe(
      Layer.provide(Persistence.memory),
    )
  // Where this tab's navigations went.
  const navigated: Array<string> = []
  // As src/boot.ts composes it: the engine first, then the store, then the tab's answers to its worker, then dispatch
  // and the tab's navigation answers.
  const tab = Theme.layer.pipe(
    Layer.provideMerge(navigation(name, navigated)),
    Layer.provideMerge(files(name, page.at, navigated)),
    Layer.provideMerge(FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer))),
    Layer.provideMerge(tabAnswers),
    Layer.provideMerge(store),
    Layer.provideMerge(tabEngine(() => worker, name)),
    Layer.provideMerge(telemetry.tab ?? Layer.empty),
  )
  const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(tab)))

  /**
   * Another tab of this device: dispatch and its navigation answers over the same engine, whose own worker never leads,
   * as a second tab's waits its turn. Closed with the device.
   */
  const openTab = async () => {
    const moved: Array<string> = []
    const other = navigation(name, moved).pipe(
      Layer.provideMerge(FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer))),
      Layer.provideMerge(tabEngine(idleWorker, name)),
    )
    const built = await Effect.runPromise(Scope.provide(scope)(Layer.build(other)))
    return { navigated: moved, dispatch: Context.get(built, FlowDispatch) }
  }

  return {
    /** The engine's name: its Web Lock and the channels its steps ask its tabs on. */
    name,
    painted,
    navigated,
    openTab,
    terminated,
    theme: Context.get(context, Theme),
    dispatch: Context.get(context, FlowDispatch),
    engine: Context.get(context, BrowserEngine.BrowserEngine),
    store: Context.get(context, ThemeStore),
    /** Runs `effect` with the tab's services, its telemetry included, as the browser runs an action. */
    run: <A, E, R extends ServicesOf<typeof context>>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromiseWith(context)(effect),
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await Effect.runPromise(Fiber.interrupt(leader))
      channel.port1.close()
      channel.port2.close()
      await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(
            Layer.build(Pg.PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 })),
            (admin) => {
              const sql = Context.get(admin, SqlClient.SqlClient)
              return Effect.orDie(sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`)
            },
          ),
        ),
      )
    },
  }
}
