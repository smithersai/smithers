/**
 * The leader prepares the app's shared database before any tab's statement
 * runs on it: `BrowserRuntime.run({ prepare })` over OPFS in memory, with real
 * tabs over Node's own Web Locks and `BroadcastChannel`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import type { SqlError } from "effect/sql/SqlError"
import { afterEach, beforeEach } from "vitest"
import { BrowserRuntime, type SharedSqlite, WebLock } from "../src/index.ts"
import * as Engines from "./fixtures/Engines.ts"
import { flows, registration } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const Prepared = Schema.Struct({ rows: Schema.Number })

/** A preparation that records each run in `ran`, and does `work` on the database. */
const preparation = (
  epoch: number,
  ran: Array<number>,
  work: (database: SharedSqlite.Service) => Effect.Effect<void, unknown> = (database) =>
    Effect.gen(function*() {
      yield* database.execute("CREATE TABLE IF NOT EXISTS prepared (epoch INTEGER)")
      yield* database.execute("BEGIN IMMEDIATE")
      yield* database.execute("INSERT INTO prepared VALUES (?)", [epoch])
      yield* database.execute("COMMIT")
    })
): BrowserRuntime.Prepare<typeof Prepared.Type> => ({
  epoch,
  success: Prepared,
  run: (database) =>
    Effect.gen(function*() {
      ran.push(epoch)
      yield* work(database)
      return { rows: 1 }
    })
})

/** A worker over `name`'s OPFS that prepares with `prepare`, recording its telemetry. */
const worker = (name: string, prepare: BrowserRuntime.Prepare, telemetry = Telemetry.make()) =>
  BrowserRuntime.run({
    name,
    sqlite: MemorySqlite.build,
    flows,
    registerFlows: registration(Effect.succeed),
    prepare,
    telemetry: telemetry.layer
  })

const select = (tab: SharedSqlite.Service) => tab.execute("SELECT epoch FROM prepared ORDER BY epoch")

/** Whether `statement` failed because the leader fenced the database: a `ConnectionError` naming `PrepareFailed`. */
const fenced = (statement: Effect.Effect<unknown, SqlError>) =>
  Effect.map(Effect.flip(statement), (error) =>
    error.reason._tag === "ConnectionError" &&
    (error.reason.cause as { readonly name?: unknown } | undefined)?.name === "@smthrs/platform-browser/PrepareFailed")

describe("BrowserRuntime.run with prepare", () => {
  it.live("interrupts pending preparation when leadership is stolen", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const entered = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const running = worker(
        name,
        preparation(1, [], () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(stopped, undefined))
          ))
      )
      yield* Effect.addFinalizer(() => Fiber.interrupt(running))
      yield* Deferred.await(entered)
      const thief = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      yield* Effect.flatMap(WebLock.WebLock, (locks) => locks.hold(name, { steal: true })).pipe(
        Effect.provide(WebLock.layer),
        Scope.provide(thief)
      )
      expect(yield* Deferred.await(stopped).pipe(Effect.timeoutOption("300 millis"))).toMatchObject({ _tag: "Some" })
    }).pipe(Effect.scoped))

  let remove: () => void = () => undefined
  beforeEach(() => {
    remove = MemoryOpfs.install()
  })
  afterEach(() => remove())

  it.live("prepares the app's database before any tab's statement runs on it", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const ran: Array<number> = []
      const release = yield* Deferred.make<void>()
      const telemetry = Telemetry.make()
      const running = worker(
        name,
        preparation(1, ran, (database) =>
          Deferred.await(release).pipe(Effect.andThen(preparation(1, []).run(database)), Effect.asVoid)),
        telemetry
      )
      const tab = yield* Engines.sharedTab(name)
      // While the leader prepares, a tab's statement waits.
      expect(yield* select(tab).pipe(Effect.timeoutOption("300 millis"))).toEqual(Option.none())
      yield* Deferred.succeed(release, undefined)
      expect(yield* select(tab)).toEqual([{ epoch: 1 }])
      yield* Fiber.interrupt(running)
      expect(ran).toEqual([1])
      expect(telemetry.lines("browser.runtime.prepare")).toMatchObject([
        { message: "browser.runtime.prepare", annotations: { outcome: "prepared", epoch: 1 } }
      ])
      expect(telemetry.count(BrowserRuntime.preparations, { outcome: "prepared" })).toBe(1)
      expect(telemetry.named("browser.runtime.prepare")).toHaveLength(1)
    }).pipe(Effect.scoped))

  it.live("prepares once per epoch: the next leader of the same build answers from the journal", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const ran: Array<number> = []
      const first = preparation(1, ran)
      const tab = yield* Engines.sharedTab(name)
      const one = worker(name, first)
      expect(yield* select(tab)).toEqual([{ epoch: 1 }])
      yield* Fiber.interrupt(one)
      const again = worker(name, first)
      expect(yield* select(tab)).toEqual([{ epoch: 1 }])
      yield* Fiber.interrupt(again)
      const next = worker(name, preparation(2, ran))
      expect(yield* select(tab)).toEqual([{ epoch: 1 }, { epoch: 2 }])
      yield* Fiber.interrupt(next)
      expect(ran).toEqual([1, 2])
    }).pipe(Effect.scoped))

  it.live("resumes a preparation the leader died in, and nothing of its open transaction stands", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const ran: Array<number> = []
      const midway = yield* Deferred.make<void>()
      const prepare = preparation(1, ran, (database) =>
        Effect.gen(function*() {
          yield* database.execute("CREATE TABLE IF NOT EXISTS prepared (epoch INTEGER)")
          yield* database.execute("BEGIN IMMEDIATE")
          yield* database.execute("INSERT INTO prepared VALUES (?)", [1])
          // The first leader dies here, inside its transaction; the next one runs the step again to its end.
          if (ran.length === 1) {
            yield* Deferred.succeed(midway, undefined)
            return yield* Effect.never
          }
          yield* database.execute("COMMIT")
        }))
      const dying = worker(name, prepare)
      yield* Deferred.await(midway)
      yield* Fiber.interrupt(dying)
      const telemetry = Telemetry.make()
      const next = worker(name, prepare, telemetry)
      const tab = yield* Engines.sharedTab(name)
      expect(yield* select(tab)).toEqual([{ epoch: 1 }])
      yield* Fiber.interrupt(next)
      expect(ran).toEqual([1, 1])
      expect(telemetry.count(BrowserRuntime.wakes, { outcome: "unknown-flow" })).toBe(0)
      expect(telemetry.lines("browser.runtime.wake")).toEqual([])
      expect(telemetry.count(BrowserRuntime.preparations, { outcome: "prepared" })).toBe(1)
    }).pipe(Effect.scoped))

  it.live("fences every tab's statement with PrepareFailed when the preparation keeps failing, after rolling back what it left open", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const ran: Array<number> = []
      const telemetry = Telemetry.make()
      const failing = preparation(1, ran, (database) =>
        Effect.gen(function*() {
          yield* database.execute("CREATE TABLE IF NOT EXISTS prepared (epoch INTEGER)")
          yield* database.execute("BEGIN IMMEDIATE")
          yield* database.execute("INSERT INTO prepared VALUES (?)", [1])
          // A statement SQLite refuses: the transaction stays open until the step ends.
          yield* database.execute("INSERT INTO missing VALUES (1)")
        }))
      const running = worker(name, failing, telemetry)
      const tab = yield* Engines.sharedTab(name)
      // Neither a read nor a write runs on a database this build could not prepare.
      for (const sql of ["SELECT epoch FROM prepared", "INSERT INTO prepared VALUES (2)"]) {
        expect(yield* fenced(tab.execute(sql))).toBe(true)
      }
      yield* Fiber.interrupt(running)
      // The step's retry policy tried three times.
      expect(ran).toEqual([1, 1, 1])
      expect(telemetry.lines("browser.runtime.prepare")).toMatchObject([
        { annotations: { outcome: "failed", epoch: 1, "error.type": "@smthrs/platform-browser/PrepareFailed" } }
      ])
      expect(telemetry.count(BrowserRuntime.preparations, { outcome: "failed" })).toBe(1)
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "fenced" })).toBe(2)
      // What the failed step left open was rolled back: a later build that prepares finds nothing of it.
      const next = worker(name, preparation(2, ran))
      expect(yield* select(tab)).toEqual([{ epoch: 2 }])
      yield* Fiber.interrupt(next)
    }).pipe(Effect.scoped))

  it.live("keeps the fence for the build whose preparation failed: its next leader answers from the journal, and a later build prepares", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const ran: Array<number> = []
      const failing = preparation(1, ran, () => Effect.fail("no"))
      const tab = yield* Engines.sharedTab(name)
      const first = worker(name, failing)
      expect(yield* fenced(tab.execute("SELECT 1"))).toBe(true)
      yield* Fiber.interrupt(first)
      const again = worker(name, failing)
      expect(yield* fenced(tab.execute("SELECT 1"))).toBe(true)
      yield* Fiber.interrupt(again)
      expect(ran).toEqual([1, 1, 1])
      const next = worker(name, preparation(2, ran))
      expect(yield* select(tab)).toEqual([{ epoch: 2 }])
      yield* Fiber.interrupt(next)
    }).pipe(Effect.scoped))
})

describe("BrowserRuntime.run with a preparation that dies", () => {
  let remove: () => void = () => undefined
  beforeEach(() => {
    remove = MemoryOpfs.install()
  })
  afterEach(() => remove())

  it.live("records it as a failed preparation, by no tag, and fences the tabs", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const telemetry = Telemetry.make()
      const running = worker(name, { epoch: 1, success: Prepared, run: () => Effect.die("no tag") }, telemetry)
      const tab = yield* Engines.sharedTab(name)
      expect(yield* fenced(tab.execute("SELECT 1 AS one"))).toBe(true)
      yield* Fiber.interrupt(running)
      expect(telemetry.count(BrowserRuntime.preparations, { outcome: "failed" })).toBe(1)
    }).pipe(Effect.scoped))
})

describe("BrowserRuntime.serve with prepare", () => {
  it.live("skips the preparation when the engine serves no app database", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const ran: Array<number> = []
      const telemetry = Telemetry.make()
      const database = yield* MemorySqlite.open
      const running = yield* Effect.forkChild(
        BrowserRuntime.serve(
          { name, flows, prepare: preparation(1, ran) },
          Engines.engine(name, database, Engines.steps())
        ).pipe(Effect.provide(Layer.merge(Engines.platform, telemetry.layer)))
      )
      const engine = yield* Engines.tab(name)
      yield* engine.start(flows[0], { executionId: "after", payload: { prefix: "a" } })
      yield* engine.result(flows[0], "after")
      yield* Fiber.interrupt(running)
      expect(ran).toEqual([])
      expect(telemetry.count(BrowserRuntime.preparations, { outcome: "skipped" })).toBe(1)
    }).pipe(Effect.scoped))
})
