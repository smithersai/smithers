/**
 * In-process leaders and tabs for the Node suites: the real `serve` and
 * `BrowserEngine.make` over Node's own Web Locks and `BroadcastChannel`, and
 * a store on wa-sqlite's in-memory VFS that two leaders can share.
 */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import {
  BrowserEngine,
  BrowserRuntime,
  BrowserSqlite,
  SharedSqlite,
  StoragePersistence,
  TabChannel,
  WebLock
} from "../../src/index.ts"
import * as SqlConnection from "../../src/internal/SqlConnection.ts"
import { flows, registration } from "./Flows.ts"
import * as MemorySqlite from "./MemorySqlite.ts"

/** A fresh engine name, so concurrent cases never share a lock or a channel. */
export const name = (): string => `engine-${crypto.randomUUID()}`

/** What every step did, in order. */
export interface Steps {
  readonly ran: Array<string>
  readonly step: (label: string) => Effect.Effect<string>
}

/**
 * Steps that record their label and succeed, except the labels in `block`,
 * which never finish, and those in `die`, which die.
 */
export const steps = (
  options: { readonly block?: ReadonlyArray<string>; readonly die?: ReadonlyArray<string> } = {}
): Steps => {
  const ran: Array<string> = []
  return {
    ran,
    step: (label) =>
      Effect.sync(() => ran.push(label)).pipe(
        Effect.andThen(
          options.block?.includes(label) ?
            Effect.never
            : options.die?.includes(label) ?
            Effect.die(new Error("step died"))
            : Effect.succeed(label)
        )
      )
  }
}

/**
 * The engine over `database`, registering every fixture flow. Its run reads
 * know those flows, as `BrowserRuntime.run`'s know the flows it serves, so a
 * run's values read through their schemas instead of as `<withheld>`.
 */
export const engine = (engineName: string, database: BrowserSqlite.Database, run: Steps) =>
  BrowserRuntime.layer({ name: engineName, flows }, registration(run.step)).pipe(
    Layer.provide(MemorySqlite.over(database))
  )

/**
 * The engine over `database`, with the app's shared database opened on `pool`
 * as `SharedSqlite.filename`, the way `BrowserRuntime.layerHost` opens it in
 * OPFS. Each leader opens its own connection, closed with the leader.
 */
export const engineWithApp = (
  engineName: string,
  database: BrowserSqlite.Database,
  run: Steps,
  pool: BrowserSqlite.Sqlite["Service"]
) =>
  Layer.merge(
    engine(engineName, database, run),
    SqlConnection.layer({ filename: SharedSqlite.filename }).pipe(
      Layer.provide(Layer.succeed(BrowserSqlite.Sqlite)(pool))
    )
  )

/** The real lock and channel. */
export const platform = Layer.mergeAll(WebLock.layer, TabChannel.layer)

/** Forks a leader over `engineLayer`; interrupting it is its tab closing. */
export const leader = <E>(
  engineName: string,
  engineLayer: Layer.Layer<BrowserRuntime.Services, E>,
  served: BrowserRuntime.ServeOptions["flows"] = flows
) =>
  Effect.forkChild(
    BrowserRuntime.serve({ name: engineName, flows: served }, engineLayer).pipe(Effect.provide(platform))
  )

/**
 * A worker handle that records what the tab did with it: `fail` fires an error
 * event, as a worker that throws does, and `post` a message to the tab.
 */
export const worker = () => {
  const listeners: Array<(event: ErrorEvent) => void> = []
  const messages: Array<(event: MessageEvent) => void> = []
  let terminated = 0
  return {
    listeners,
    terminated: () => terminated,
    fail: (event: ErrorEvent) => listeners.forEach((listener) => listener(event)),
    post: (data: unknown) => messages.forEach((listener) => listener(new MessageEvent("message", { data }))),
    handle: {
      terminate: () => {
        terminated++
      },
      addEventListener: (type: "error" | "message", listener: (event: any) => void) => {
        if (type === "error") listeners.push(listener)
        else messages.push(listener)
      }
    } as BrowserEngine.WorkerLike
  }
}

/** A tab's engine client, over the real channel and a storage answer of `granted`. */
export const tab = (
  engineName: string,
  options: { readonly granted?: boolean; readonly worker?: BrowserEngine.WorkerLike } = {}
) =>
  BrowserEngine.make({ name: engineName, worker: () => options.worker ?? worker().handle }).pipe(
    Effect.provide(Layer.mergeAll(
      TabChannel.layer,
      Layer.succeed(StoragePersistence.StoragePersistence)(
        StoragePersistence.make({ persist: () => Promise.resolve(options.granted ?? true) })
      )
    ))
  )

/** Interrupts a leader, as its tab closing would. */
export const close = (fiber: Fiber.Fiber<unknown, unknown>) => Fiber.interrupt(fiber)

/** A tab's shared database client, over the real channel and Web Locks. */
export const sharedTab = (engineName: string) => SharedSqlite.make({ name: engineName }).pipe(Effect.provide(platform))
