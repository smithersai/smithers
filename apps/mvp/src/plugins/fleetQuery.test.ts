// `core/agent-runs` and `core/machines` as a plugin first reads them: rows still loading are never no rows, or the
// fleet draws "No agent runs" and "runners 0/0" until the first sync arrives (seen on smithers.sh, 2026-11-01).
import { Deferred, Effect, Fiber, Layer, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import type { FleetStore } from "../features/fleet/store"
import { Plugins, queryOf } from "./plugins"

type Row = { readonly key: string }

/** Whether the repository may show, as the host's gate reads it (`repoVisibility`), and who listens. */
const shown = { now: true, listeners: new Set<() => void>() }

/** A repository's live query whose first sync arrives when `sync` completes, holding `rows` from then on. */
const liveQuery = (sync: Deferred.Deferred<void, Error>, rows: () => ReadonlyArray<Row>) => ({
  preload: Deferred.await(sync),
  toArray: Effect.sync(rows),
  rows: Stream.fromEffect(Effect.sync(rows)),
})

const plugins = (query: ReturnType<typeof liveQuery>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const fleet = { runs: () => Effect.succeed(query), machines: () => Effect.succeed(query) } as unknown as FleetStore["Service"]
    return Layer.succeed(Plugins, Plugins.of({
      core: new Map(), fleet, fleetOpen: new Map(), scope, visible: () => shown.now, onVisibility: (listener: () => void) => {
        shown.listeners.add(listener)
        return () => void shown.listeners.delete(listener)
      },
    } as unknown as Plugins["Service"]))
  })

const scoped = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(TestClock.layer())))

describe("a fleet query's first read", () => {
  test("waits for the first sync and answers its rows", () =>
    scoped(Effect.gen(function* () {
      const sync = yield* Deferred.make<void, Error>()
      let rows: ReadonlyArray<Row> = []
      const layer = yield* plugins(liveQuery(sync, () => rows))
      const asked = yield* queryOf("core/agent-runs", { repo: "acme/widgets" }).pipe(Effect.provide(layer), Effect.forkScoped)
      yield* Effect.yieldNow
      expect(asked.pollUnsafe()).toBeUndefined()
      rows = [{ key: "t1#g1" }]
      yield* Deferred.succeed(sync, undefined)
      const live = yield* Fiber.join(asked)
      expect(live.current()).toEqual([{ key: "t1#g1" }])
    })))

  test("answers what the tab has when the first sync fails", () =>
    scoped(Effect.gen(function* () {
      const sync = yield* Deferred.make<void, Error>()
      const layer = yield* plugins(liveQuery(sync, () => []))
      yield* Deferred.fail(sync, new Error("refused"))
      const live = yield* queryOf("core/machines", { repo: "acme/widgets" }).pipe(Effect.provide(layer))
      expect(live.current()).toEqual([])
    })))

  test("answers what the tab has when the first sync never comes", () =>
    scoped(Effect.gen(function* () {
      const sync = yield* Deferred.make<void, Error>()
      const layer = yield* plugins(liveQuery(sync, () => []))
      const asked = yield* queryOf("core/agent-runs", { repo: "acme/widgets" }).pipe(Effect.provide(layer), Effect.forkScoped)
      yield* TestClock.adjust("31 seconds")
      expect((yield* Fiber.join(asked)).current()).toEqual([])
    })))
})

// Decision 0110, 2026-11-03: a repository's rows reach a plugin only while the repository may show, read at each read.
test("a fleet query answers no rows while its repository may not show, and tells its listener when that changes", () =>
  scoped(Effect.gen(function* () {
    const sync = yield* Deferred.make<void, Error>()
    yield* Deferred.succeed(sync, undefined)
    const layer = yield* plugins(liveQuery(sync, () => [{ key: "t1#g1" }]))
    const live = yield* queryOf("core/machines", { repo: "acme/widgets" }).pipe(Effect.provide(layer))
    let told = 0
    const stop = live.subscribe(() => { told++ })
    expect(live.current()).toEqual([{ key: "t1#g1" }])
    shown.now = false
    for (const listener of shown.listeners) listener()
    expect(told).toBe(1)
    expect(live.current()).toEqual([])
    shown.now = true
    stop()
  })))

// The gated view is kept per query, so it must decide on every read, never hold an earlier answer.
test("two reads of one query answer the same view, and each read decides again", () =>
  scoped(Effect.gen(function* () {
    const sync = yield* Deferred.make<void, Error>()
    yield* Deferred.succeed(sync, undefined)
    const layer = yield* plugins(liveQuery(sync, () => [{ key: "t1#g1" }]))
    const first = yield* queryOf("core/agent-runs", { repo: "acme/widgets" }).pipe(Effect.provide(layer))
    expect(first.current()).toEqual([{ key: "t1#g1" }])
    shown.now = false
    const second = yield* queryOf("core/agent-runs", { repo: "acme/widgets" }).pipe(Effect.provide(layer))
    expect(second).toBe(first)
    expect(second.current()).toEqual([])
    expect(first.current()).toEqual([])
    shown.now = true
    expect(first.current()).toEqual([{ key: "t1#g1" }])
  })))

