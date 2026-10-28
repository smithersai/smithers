/**
 * The engine in a worker: its composition, the leader's wake and election,
 * and the worker entry, over Node's own Web Locks and `BroadcastChannel` and
 * wa-sqlite.
 */
import { describe, expect, it } from "@effect/vitest"
import { EngineStore, RunCatalogRead } from "@smthrs/engine-store"
import { FlowRuntime } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import { afterEach, beforeEach, vi } from "vitest"
import { BrowserRuntime, type SharedSqlite, TabChannel, WebLock } from "../src/index.ts"
import * as Engines from "./fixtures/Engines.ts"
import { flows, registration, Sleeper, Steps } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

describe("BrowserRuntime.layer", () => {
  it.live("interrupts pending engine initialization when leadership is stolen", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const entered = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const database = yield* MemorySqlite.open
      const engine = Layer.unwrap(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
          Effect.as(Engines.engine(name, database, Engines.steps()))
        )
      )
      yield* Engines.leader(name, engine)
      yield* Deferred.await(entered)
      const thief = yield* Scope.make()
      yield* Effect.flatMap(WebLock.WebLock, (locks) => locks.hold(name, { steal: true })).pipe(
        Effect.provide(WebLock.layer),
        Scope.provide(thief)
      )
      expect(yield* Deferred.await(stopped).pipe(Effect.timeoutOption("300 millis"))).toMatchObject({ _tag: "Some" })
      yield* Scope.close(thief, Exit.void)
    }).pipe(Effect.scoped))

  it.effect("runs a three-step flow durably over wa-sqlite", () =>
    Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      expect(yield* runtime.execute(Steps, { executionId: "steps-1", payload: { prefix: "a" } })).toBe("a:three")
    }).pipe(
      Effect.provide(
        BrowserRuntime.layer({ name: "test" }, registration(Effect.succeed)).pipe(Layer.provide(MemorySqlite.layer))
      )
    ))
})

describe("BrowserRuntime over OPFS", () => {
  let remove: () => void = () => undefined
  beforeEach(() => {
    remove = MemoryOpfs.install()
  })
  afterEach(() => remove())

  it.effect("authorization runs before registration or resume, fails closed, and is checked on each activation", () =>
    Effect.gen(function*() {
      let authorized = 0
      let registered = 0
      const host = (allowed: boolean) =>
        BrowserRuntime.layerHost(
          {
            name: "identity-gate",
            sqlite: MemorySqlite.build,
            authorize: (database) =>
              Effect.gen(function*() {
                yield* database.execute("SELECT 1")
                authorized++
                if (!allowed) return yield* Effect.fail("identity refused")
                expect(yield* database.execute("SELECT name FROM sqlite_master WHERE name = 'authorization_left_open'"))
                  .toEqual([])
                yield* database.execute("BEGIN")
                yield* database.execute("CREATE TABLE authorization_left_open (value TEXT)")
                // The host rolls a check's unfinished transaction back before it builds anything else.
              })
          },
          Layer.merge(
            registration(Effect.succeed),
            Layer.effectDiscard(Effect.sync(() => {
              registered++
            }))
          )
        )
      expect(yield* Effect.exit(Layer.build(host(false)).pipe(Effect.scoped))).toEqual(Exit.fail("identity refused"))
      expect(registered).toBe(0)
      for (let index = 0; index < 2; index++) yield* Layer.build(host(true)).pipe(Effect.scoped)
      expect(authorized).toBe(3)
      expect(registered).toBe(2)
    }))

  it.effect("the database a successful check was given stays usable while the activation serves", () =>
    Effect.gen(function*() {
      let kept: SharedSqlite.Service | undefined
      const host = BrowserRuntime.layerHost(
        {
          name: "identity-recheck",
          sqlite: MemorySqlite.build,
          authorize: (database) =>
            Effect.andThen(
              database.execute("CREATE TABLE IF NOT EXISTS device_owner (person TEXT)"),
              Effect.sync(() => {
                kept = database
              })
            )
        },
        registration(Effect.succeed)
      )
      yield* Effect.gen(function*() {
        const context = yield* Layer.build(host)
        // Later, while the engine serves, the host checks again and records an owner, each statement on its own.
        yield* kept!.execute("INSERT INTO device_owner (person) VALUES (?)", ["person-1"])
        expect(yield* kept!.execute("SELECT person FROM device_owner")).toEqual([{ person: "person-1" }])
        const runtime = Context.get(context, FlowRuntime.FlowRuntime)
        expect(yield* runtime.execute(Steps, { executionId: "after-recheck", payload: { prefix: "c" } })).toBe(
          "c:three"
        )
      }).pipe(Effect.scoped)
      // The next activation's check reads what the later one recorded.
      yield* Effect.gen(function*() {
        yield* Layer.build(host)
        expect(yield* kept!.execute("SELECT person FROM device_owner")).toEqual([{ person: "person-1" }])
      }).pipe(Effect.scoped)
    }))

  it.effect("layerHost keeps a run's result in OPFS across engines", () =>
    Effect.gen(function*() {
      const host = BrowserRuntime.layerHost({ name: "opfs", sqlite: MemorySqlite.build }, registration(Effect.succeed))
      yield* Effect.flatMap(
        FlowRuntime.FlowRuntime,
        (runtime) => runtime.execute(Steps, { executionId: "kept", payload: { prefix: "k" } })
      ).pipe(Effect.provide(host))
      const result = yield* Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) => runtime.poll(Steps, "kept")).pipe(
        Effect.provide(host)
      )
      expect(result).toMatchObject({ _tag: "Some", value: { _tag: "Complete", exit: Exit.succeed("k:three") } })
    }))

  it.live("run serves a tab until its fiber is interrupted", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const run = Engines.steps()
      const worker = BrowserRuntime.run({
        name,
        sqlite: MemorySqlite.build,
        flows,
        registerFlows: registration(run.step)
      })
      const engine = yield* Engines.tab(name)
      yield* engine.start(Steps, { executionId: "run-1", payload: { prefix: "r" } })
      expect(yield* engine.result(Steps, "run-1")).toEqual(Exit.succeed("r:three"))
      yield* Fiber.interrupt(worker)
    }).pipe(Effect.scoped))

  it.live("run sends the worker's logs, spans and metrics to its telemetry", () =>
    Effect.gen(function*() {
      const telemetry = Telemetry.make()
      const name = Engines.name()
      const run = Engines.steps()
      const worker = BrowserRuntime.run({
        name,
        sqlite: MemorySqlite.build,
        flows,
        registerFlows: registration(run.step),
        telemetry: telemetry.layer
      })
      const engine = yield* Engines.tab(name)
      yield* engine.start(Steps, { executionId: "observed", payload: { prefix: "o" } })
      expect(yield* engine.result(Steps, "observed")).toEqual(Exit.succeed("o:three"))
      yield* Fiber.interrupt(worker)
      expect(telemetry.lines("browser.runtime.leader")).toHaveLength(1)
      // One line for every flow the engine registered; each registration's own line stays at Debug, out of telemetry.
      const recovered = telemetry.lines("engine-store.registration.recovered")
      expect(recovered.map((line) => line.level)).toEqual(["INFO"])
      expect(recovered[0]!.annotations["registrations"]).toBeGreaterThanOrEqual(flows.length)
      expect(telemetry.lines("engine-store.registration.flow.recovered")).toEqual([])
      expect(telemetry.named("browser.runtime.elect")).toHaveLength(1)
      expect(telemetry.named("browser.runtime.request").length).toBeGreaterThan(0)
      expect(telemetry.count(BrowserRuntime.leaderships, {})).toBe(1)
    }).pipe(Effect.scoped))

  it.live("run logs its stop to its telemetry, by the failure's tag", () =>
    Effect.gen(function*() {
      const telemetry = Telemetry.make()
      const worker = BrowserRuntime.run({
        name: Engines.name(),
        sqlite: { ...MemorySqlite.build, wasm: () => Promise.resolve(new Uint8Array([0])) },
        flows,
        registerFlows: registration(Effect.succeed),
        telemetry: telemetry.layer
      })
      yield* Fiber.await(worker)
      expect(telemetry.lines("browser.runtime.stopped").map(({ level, annotations }) => [level, annotations])).toEqual([
        ["ERROR", expect.objectContaining({ "error.type": "SqlError" })]
      ])
    }))

  it.live("run ends, releasing the lock, when the engine cannot be built", () =>
    Effect.gen(function*() {
      const worker = BrowserRuntime.run({
        name: Engines.name(),
        sqlite: { ...MemorySqlite.build, wasm: () => Promise.resolve(new Uint8Array([0])) },
        flows,
        registerFlows: registration(Effect.succeed)
      })
      expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true)
    }))

  describe("in a dedicated worker", () => {
    const posted: Array<unknown> = []
    beforeEach(() => {
      posted.length = 0
      vi.stubGlobal("WorkerGlobalScope", function WorkerGlobalScope() {})
      vi.stubGlobal("postMessage", (message: unknown) => posted.push(message))
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it.live("run tells its tab when the engine cannot be built, by the failure's tag", () =>
      Effect.gen(function*() {
        const worker = BrowserRuntime.run({
          name: Engines.name(),
          sqlite: { ...MemorySqlite.build, wasm: () => Promise.resolve(new Uint8Array([0])) },
          flows,
          registerFlows: registration(Effect.succeed)
        })
        yield* Fiber.await(worker)
        expect(posted).toEqual([{ _tag: "@smthrs/platform-browser/EngineStopped", error: "SqlError" }])
      }))

    it.live("run tells its tab when telemetry initialization fails", () =>
      Effect.gen(function*() {
        const worker = BrowserRuntime.run({
          name: Engines.name(),
          sqlite: MemorySqlite.build,
          flows,
          registerFlows: registration(Effect.succeed),
          telemetry: Layer.effectDiscard(Effect.fail({ _tag: "TelemetryUnavailable" }))
        })
        expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true)
        expect(posted).toEqual([{ _tag: "@smthrs/platform-browser/EngineStopped", error: "TelemetryUnavailable" }])
      }))

    it.live("run logs what nothing caught on the worker's global while it runs, by kind and name, never the message", () =>
      Effect.gen(function*() {
        const listeners = new Map<string, (event: unknown) => void>()
        vi.stubGlobal(
          "addEventListener",
          (type: string, listener: (event: unknown) => void) => listeners.set(type, listener)
        )
        vi.stubGlobal("removeEventListener", (type: string) => listeners.delete(type))
        const telemetry = Telemetry.make()
        const name = Engines.name()
        const worker = BrowserRuntime.run({
          name,
          sqlite: MemorySqlite.build,
          flows,
          registerFlows: registration(Effect.succeed),
          telemetry: telemetry.layer
        })
        const engine = yield* Engines.tab(name)
        yield* engine.start(Steps, { executionId: "uncaught", payload: { prefix: "u" } })
        listeners.get("error")!({ type: "error", error: new TypeError("SENTINEL someone's words") })
        listeners.get("unhandledrejection")!({ type: "unhandledrejection", reason: { _tag: "Refused" } })
        listeners.get("unhandledrejection")!({ type: "unhandledrejection", reason: "SENTINEL a string" })
        yield* Fiber.interrupt(worker)
        expect(telemetry.lines("browser.runtime.uncaught").map(({ level, annotations }) => [level, annotations]))
          .toEqual([
            ["ERROR", expect.objectContaining({ kind: "error", "error.type": "TypeError" })],
            ["ERROR", expect.objectContaining({ kind: "rejection", "error.type": "Refused" })],
            ["ERROR", expect.objectContaining({ kind: "rejection", "error.type": "string" })]
          ])
        // The worker's listeners go with it.
        expect(listeners.size).toBe(0)
        expect(Telemetry.dump(telemetry)).not.toContain("SENTINEL")
      }).pipe(Effect.scoped))

    it.live("run tells its tab nothing when it is only interrupted", () =>
      Effect.gen(function*() {
        const name = Engines.name()
        const worker = BrowserRuntime.run({
          name,
          sqlite: MemorySqlite.build,
          flows,
          registerFlows: registration(Effect.succeed)
        })
        const engine = yield* Engines.tab(name)
        yield* engine.start(Steps, { executionId: "quiet", payload: { prefix: "q" } })
        yield* Fiber.interrupt(worker)
        expect(posted).toEqual([])
      }).pipe(Effect.scoped))
  })
})

describe("BrowserRuntime.serve", () => {
  it.live("leads only while it holds the lock: a second leader waits, then takes over", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const listener = yield* Effect.flatMap(TabChannel.TabChannel, (channels) => channels.open(name)).pipe(
        Effect.provide(TabChannel.layer)
      )
      const announcements = yield* listener.subscribe
      const first = yield* Engines.leader(name, Engines.engine(name, yield* MemorySqlite.open, Engines.steps()))
      expect(yield* Queue.take(announcements)).toEqual({ _tag: "Leader" })
      yield* Engines.leader(name, Engines.engine(name, yield* MemorySqlite.open, Engines.steps()))
      yield* Effect.sleep("100 millis")
      expect(yield* Queue.size(announcements)).toBe(0)
      yield* Engines.close(first)
      expect(yield* Queue.take(announcements)).toEqual({ _tag: "Leader" })
    }).pipe(Effect.scoped))

  it.live("stops leading when another context steals its lock, and leads again once that context lets go", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const name = Engines.name()
        const listener = yield* Effect.flatMap(TabChannel.TabChannel, (channels) => channels.open(name)).pipe(
          Effect.provide(TabChannel.layer)
        )
        const announcements = yield* listener.subscribe
        const run = Engines.steps()
        yield* Engines.leader(name, Engines.engine(name, yield* MemorySqlite.open, run))
        expect(yield* Queue.take(announcements)).toEqual({ _tag: "Leader" })
        const thief = yield* Scope.make()
        yield* Effect.flatMap(WebLock.WebLock, (lock) => lock.hold(name, { steal: true })).pipe(
          Effect.provide(WebLock.layer),
          Scope.provide(thief)
        )
        const engine = yield* Engines.tab(name)
        const started = yield* Effect.forkChild(
          engine.start(Steps, { executionId: "stolen-1", payload: { prefix: "s" } })
        )
        yield* Effect.sleep("100 millis")
        // The robbed leader stopped: nobody answers.
        expect(started.pollUnsafe()).toBeUndefined()
        expect(run.ran).toEqual([])
        yield* Scope.close(thief, Exit.void)
        // The tab's own request is on the channel too; the next announcement follows it.
        let announced: unknown
        while ((announced as { readonly _tag?: string } | undefined)?._tag !== "Leader") {
          announced = yield* Queue.take(announcements)
        }
        yield* Fiber.join(started)
        expect(yield* engine.result(Steps, "stolen-1")).toEqual(Exit.succeed("s:three"))
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.leaderships, {})).toBe(2)
      expect(telemetry.lines("browser.runtime.lost")).toHaveLength(1)
    })))
  })

  it.live("wakes each unfinished run once, counts the outcome, and carries no content", () => {
    const telemetry = Telemetry.make()
    const sentinel = "SENTINEL-7d0e"
    return telemetry.observed(
      Effect.gen(function*() {
        const name = Engines.name()
        const database = yield* MemorySqlite.open
        const first = Engines.steps({ block: [`${sentinel}:two`] })
        const leader = yield* Engines.leader(name, Engines.engine(name, database, first))
        const engine = yield* Engines.tab(name)
        yield* engine.start(Steps, { executionId: "released", payload: { prefix: sentinel } })
        yield* engine.start(Sleeper, { executionId: "parked", payload: { prefix: "p", pauseMs: 600_000 } })
        while (!first.ran.includes(`${sentinel}:two`) || !first.ran.includes("p:before")) {
          yield* Effect.sleep("10 millis")
        }
        yield* Engines.close(leader)

        // The next leader is not given Sleeper, so its parked run is one it cannot drive.
        const next = Engines.steps()
        yield* Engines.leader(name, Engines.engine(name, database, next), [Steps])
        expect(yield* engine.result(Steps, "released")).toEqual(Exit.succeed(`${sentinel}:three`))
        expect(next.ran).toEqual([`${sentinel}:two`, `${sentinel}:three`])
        yield* Effect.sleep("50 millis")
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.wakes, { outcome: "settled" })).toBe(1)
      expect(telemetry.count(BrowserRuntime.wakes, { outcome: "unknown-flow" })).toBe(1)
      expect(telemetry.count(BrowserRuntime.leaderships, {})).toBe(2)
      expect(telemetry.count(BrowserRuntime.requests, { request: "Start", outcome: "replied" })).toBe(2)
      expect(telemetry.named("browser.runtime.wake").map((span) => span.attributes.get("smithers.wake"))).toEqual([
        "settled"
      ])
      expect(Telemetry.dump(telemetry)).not.toContain(sentinel)
    })))
  })

  it.live("leaves a run parked on a later timer parked", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const name = Engines.name()
        const database = yield* MemorySqlite.open
        const run = Engines.steps()
        const leader = yield* Engines.leader(name, Engines.engine(name, database, run))
        const engine = yield* Engines.tab(name)
        yield* engine.start(Sleeper, { executionId: "later", payload: { prefix: "t", pauseMs: 600_000 } })
        // Parked on its timer: the leader's store says so, rather than a wait that a loaded machine outlasts.
        while ((yield* engine.inspect("later")).run.status !== "suspended") yield* Effect.sleep("10 millis")
        yield* Engines.close(leader)
        yield* Engines.leader(name, Engines.engine(name, database, run))
        // The next leader has driven it once, and left it parked.
        while (telemetry.count(BrowserRuntime.wakes, { outcome: "parked" }) === 0) yield* Effect.sleep("10 millis")
        expect(run.ran).toEqual(["t:before"])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.wakes, { outcome: "parked" })).toBe(1)
    })))
  })

  it.live("counts a drive that fails, and keeps serving when the store cannot list its runs", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const name = Engines.name()
        const database = yield* MemorySqlite.open
        const run = Engines.steps({ block: ["d:two"] })
        const leader = yield* Engines.leader(name, Engines.engine(name, database, run))
        const engine = yield* Engines.tab(name)
        yield* engine.start(Steps, { executionId: "drive", payload: { prefix: "d" } })
        while (!run.ran.includes("d:two")) yield* Effect.sleep("10 millis")
        yield* Engines.close(leader)

        const failingDriver = Layer.succeed(EngineStore.Driver)({
          admit: () => Effect.die("admission not used by this fault service"),
          drive: () => Effect.die("drive failed"),
          reportRecovery: Effect.die("recovery reports not used by this fault service")
        })
        const second = yield* Engines.leader(
          name,
          Layer.merge(Engines.engine(name, database, Engines.steps()), failingDriver)
        )
        yield* Effect.sleep("200 millis")
        yield* Engines.close(second)

        const unlisted = Layer.succeed(RunCatalogRead.RunCatalogRead)({
          listRunIds: () => Effect.succeed([]),
          listRuns: () => Effect.fail(new RunCatalogRead.RunCatalogError({ code: "list_failed", message: "x" }))
        })
        yield* Engines.leader(name, Layer.merge(Engines.engine(name, database, Engines.steps()), unlisted))
        // Requests are still answered.
        const missing = yield* engine.result(Steps, "never-started").pipe(Effect.flip)
        expect(missing).toMatchObject({ request: "Poll" })
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.wakes, { outcome: "failed" })).toBe(1)
      const wakes = telemetry.lines("browser.runtime.wake").map((line) => line.annotations)
      // A failure with no tag is named `unknown`, never by what it says.
      expect(wakes).toContainEqual(expect.objectContaining({ outcome: "failed", "error.type": "unknown" }))
      expect(wakes).toContainEqual(expect.objectContaining({ outcome: "unlisted" }))
    })))
  })

  it.live("follows the run catalog's pages to the last one", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const driven: Array<string> = []
      const pages = Layer.succeed(RunCatalogRead.RunCatalogRead)({
        listRunIds: () => Effect.succeed([]),
        listRuns: (options) =>
          Effect.succeed(
            {
              runs: options?.filters?.status !== "pending" ? [] : [
                { runId: options.cursor === undefined ? "first" : "second", flowName: Steps._tag }
              ],
              cursor: options?.filters?.status === "pending" && options.cursor === undefined ? "next" : null
            } as unknown as RunCatalogRead.RunPage
          )
      })
      const recording = Layer.succeed(EngineStore.Driver)({
        admit: () => Effect.die("admission not used by this fault service"),
        drive: (_flow, { executionId }) =>
          Effect.sync(() => driven.push(executionId)).pipe(Effect.as({ _tag: "Parked", wakeAtMs: undefined } as const)),
        reportRecovery: Effect.die("recovery reports not used by this fault service")
      })
      yield* Engines.leader(
        name,
        Layer.mergeAll(Engines.engine(name, yield* MemorySqlite.open, Engines.steps()), pages, recording)
      )
      while (driven.length < 2) yield* Effect.sleep("10 millis")
      expect(driven).toEqual(["first", "second"])
    }).pipe(Effect.scoped))
})
