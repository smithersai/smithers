/**
 * The tab the suites drive: `BrowserEngine.layer` over this page's own engine
 * worker, the app's shared database through `SharedSqlite.open`, and Web
 * Locks through `WebLock`, exposed to Playwright as `window.harness`.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { BrowserEngine, SharedSqlite, WebLock } from "../../../src/index.ts"
import { flows as declared } from "../../fixtures/Flows.ts"

const flows = Object.fromEntries(declared.map((flow) => [flow._tag, flow]))

const log: Array<{ readonly label: string; readonly worker: string }> = []
new BroadcastChannel("browser-test-log").onmessage = (event) => {
  log.push(event.data)
}

let workerClientId: string | undefined
const runtime = ManagedRuntime.make(BrowserEngine.layer({
  name: "browser-test",
  // `?worker=broken` starts a worker that throws while it loads.
  worker: () => {
    const worker = new Worker(
      `/${
        new URLSearchParams(location.search).get("worker") === "broken" ? "broken-worker" : "worker"
      }.js${location.search}`,
      { type: "module" }
    )
    worker.addEventListener("message", (event) => {
      if (typeof event.data?.workerClientId === "string") workerClientId = event.data.workerClientId
    })
    return worker
  }
}))

const events: Array<BrowserEngine.RunEvent> = []

// Build the layer now: it starts this tab's engine worker, which waits its
// turn to lead whether or not the tab has asked for anything.
runtime.runFork(
  Effect.flatMap(
    BrowserEngine.BrowserEngine,
    (engine) => Stream.runForEach(engine.events, (event) => Effect.sync(() => events.push(event)))
  )
)
await runtime.runPromise(BrowserEngine.BrowserEngine)

const engine = <A, E>(f: (engine: BrowserEngine.Service) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(BrowserEngine.BrowserEngine, f))

// The shared database opens once this tab's first statement is asked for.
let database: Promise<SharedSqlite.Database> | undefined
const sql = (statement: string, params?: ReadonlyArray<unknown>) => {
  database ??= SharedSqlite.open({ name: "browser-test" })
  return database.then((open) => open.execute(statement, params)).then(
    (rows) => ({ ok: true, rows }),
    (error: { readonly reason?: { readonly _tag?: string } }) => ({ ok: false, reason: error.reason?._tag })
  )
}

// Locks this tab holds, by name, and whether each was stolen.
const locks = WebLock.make(navigator.locks)
const held = new Map<string, { readonly scope: Scope.Closeable; lost: boolean }>()
const hold = (name: string, steal: boolean) =>
  Effect.runPromise(Effect.gen(function*() {
    const scope = yield* Scope.make()
    const lock = yield* locks.hold(name, { steal }).pipe(Scope.provide(scope))
    const entry = { scope, lost: false }
    held.set(name, entry)
    Effect.runFork(Effect.andThen(
      lock.lost,
      Effect.sync(() => {
        entry.lost = true
      })
    ))
  }))

Object.assign(globalThis, {
  harness: {
    get workerClientId() {
      return workerClientId
    },
    log,
    events,
    sql,
    hold: (name: string) => hold(name, false),
    steal: (name: string) => hold(name, true),
    lost: (name: string) => held.get(name)?.lost,
    release: (name: string) => Effect.runPromise(Scope.close(held.get(name)!.scope, Exit.void)),
    start: (flow: string, executionId: string, payload: never) =>
      engine((e) => e.start(flows[flow]!, { executionId, payload })),
    /** Starts a run and reports how the request ended, by the failure's tag. */
    attempt: (flow: string, executionId: string, payload: never) =>
      engine((e) => e.start(flows[flow]!, { executionId, payload })).then(
        () => ({ ok: true }),
        (error: { readonly _tag?: string; readonly reason?: string }) => ({
          ok: false,
          tag: error._tag,
          reason: error.reason
        })
      ),
    /** Why this tab's engine is unavailable, once it is. */
    unavailable: () => engine((e) => e.unavailable).then(({ _tag, reason, error }) => ({ _tag, reason, error })),
    result: (flow: string, executionId: string) =>
      engine((e) => e.result(flows[flow]!, executionId)).then((exit) =>
        Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, cause: String(exit.cause) }
      )
  }
})
