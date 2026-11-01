// `core/agent-runs` and `core/machines` as a plugin first reads them: rows still loading are never no rows, or the
// fleet draws "No agent runs" and "runners 0/0" until the first sync arrives (seen on smithers.sh, 2026-11-01).
import { Deferred, Effect, Fiber, Layer, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import type { FleetStore } from "../features/fleet/store"
import { Plugins, queryOf } from "./plugins"

type Row = { readonly key: string }

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
    return Layer.succeed(Plugins, Plugins.of({ core: new Map(), fleet, fleetOpen: new Map(), scope } as unknown as Plugins["Service"]))
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
