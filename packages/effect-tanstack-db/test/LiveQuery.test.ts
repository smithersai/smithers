import { LimitOffsetRequireOrderByError } from "@tanstack/db"
import { Context, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { Collection, LiveQuery, Query } from "../src/index.ts"
import { id, Note, note } from "./fixtures.ts"

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

const notes = (initialData: ReadonlyArray<Note>) =>
  Collection.local({ id: id("notes"), schema: Note, getKey: (row) => row.id, initialData })

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map(({ id }) => id)

/**
 * An on-demand source: it loads nothing until a query asks, then serves `rows` once `serve` says how. A load that
 * fails rejects with `failure`.
 */
const onDemand = (rows: ReadonlyArray<Note>, serve: () => "rows" | "fail" = () => "rows") =>
  Collection.make(Note, {
    id: id("on-demand"),
    getKey: (row: Note) => row.id,
    syncMode: "on-demand",
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        markReady()
        return {
          loadSubset: async () => {
            await Promise.resolve()
            if (serve() === "fail") throw new Error("source refused")
            begin()
            for (const value of rows) write({ type: "insert", value })
            commit()
          }
        }
      }
    }
  })

describe("make", () => {
  test("reports invalid query construction through the typed error channel", async () => {
    const error = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1)])
      return yield* Effect.flip(LiveQuery.make((q) => q.from({ note: collection.tanstack }).limit(1)))
    }))
    expect(error).toBeInstanceOf(Collection.LoadFailed)
    expect(error.cause).toBeInstanceOf(LimitOffsetRequireOrderByError)
  })

  test("keeps a typed, ordered view of its sources, and is cleaned up with its scope", async () => {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const collection = yield* Scope.provide(notes([note("a", 2), note("b", 1)]), scope)
      const ordered = yield* Scope.provide(
        LiveQuery.make((q) =>
          q.from({ note: collection.tanstack }).orderBy(({ note }) => note.n).select(({ note }) => ({
            id: note.id,
            n: note.n
          }))
        ),
        scope
      )
      yield* ordered.preload
      const before = ids(yield* ordered.toArray)
      yield* collection.insert(note("c", 0))
      const after = ids(yield* ordered.toArray)
      yield* Scope.close(scope, Exit.void)
      return { before, after, status: ordered.tanstack.status }
    }))
    expect(result).toEqual({ before: ["b", "a"], after: ["c", "b", "a"], status: "cleaned-up" })
  })

  test("getKey keys a joined row as its source does", async () => {
    const found = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1), note("b", 2)])
      const shown = yield* Collection.local({
        id: id("shown"),
        schema: Note,
        getKey: (row) => row.id,
        initialData: [note("a", 0)]
      })
      const query = yield* LiveQuery.make((q) =>
        q
          .from({ note: collection.tanstack })
          .innerJoin({ shown: shown.tanstack }, ({ note, shown }) => Query.eq(note.id, shown.id))
          .select(({ note }) => note), { getKey: (row) => row.id })
      yield* query.preload
      return { a: query.tanstack.get("a"), b: query.tanstack.get("b"), size: query.tanstack.size }
    }))
    expect(found).toEqual({ a: expect.objectContaining(note("a", 1)), b: undefined, size: 1 })
  })

  test("findOne reads one row", async () => {
    const found = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1), note("b", 2)])
      const one = yield* LiveQuery.make((q) =>
        q.from({ note: collection.tanstack }).where(({ note }) => Query.eq(note.id, "b")).findOne()
      )
      yield* one.preload
      return yield* one.toArray
    }))
    expect(found).toEqual([expect.objectContaining(note("b", 2))])
  })

  test("preload fails with LoadFailed when a source can't load", async () => {
    const error = await run(Effect.gen(function*() {
      const source = yield* onDemand([note("a", 1)], () => "fail")
      const query = yield* LiveQuery.make((q) => q.from({ note: source.tanstack }))
      return yield* Effect.flip(query.preload)
    }))
    expect(error._tag).toBe("LoadFailed")
  })
})

describe("streams", () => {
  test("rows coalesces a burst while the consumer is paused and keeps listening afterwards", async () => {
    const result = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 0)])
      const query = yield* LiveQuery.make((q) => q.from({ note: collection.tanstack }))
      yield* query.preload
      const pull = yield* Stream.toPull(query.rows.pipe(Stream.map((rows) => rows.map(({ n }) => n))))
      const initial = yield* pull
      for (let n = 1; n <= 256; n++) {
        yield* collection.update("a", (row) => {
          row.n = n
        })
      }
      const latest = yield* pull
      yield* collection.update("a", (row) => {
        row.n = 257
      })
      const next = yield* pull
      return { initial, latest, next }
    }))
    expect(result).toEqual({ initial: [[0]], latest: [[256]], next: [[257]] })
  })

  test("rows emits the current result, then the result after each change", async () => {
    const results = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1)])
      const query = yield* LiveQuery.make((q) => q.from({ note: collection.tanstack }).orderBy(({ note }) => note.n))
      yield* query.preload
      const fiber = yield* query.rows.pipe(
        Stream.map(ids),
        Stream.takeUntil((rows) => rows.join() === "b"),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* collection.insert(note("b", 2))
      yield* Effect.yieldNow
      yield* collection.delete("a")
      return yield* Fiber.join(fiber)
    }))
    expect(results[0]).toEqual(["a"])
    expect(results).toContainEqual(["a", "b"])
    expect(results.at(-1)).toEqual(["b"])
  })

  test("changes streams the query's own changes, with its rows first when asked", async () => {
    const batches = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1)])
      const query = yield* LiveQuery.make((q) =>
        q.from({ note: collection.tanstack }).where(({ note }) => Query.gt(note.n, 0))
      )
      yield* query.preload
      const fiber = yield* query.changes({ initial: true }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* collection.insert(note("b", 0))
      yield* collection.insert(note("c", 5))
      return yield* Fiber.join(fiber)
    }))
    expect(batches.map((batch) => batch.map(({ type, key }) => `${type}:${key}`))).toEqual([["insert:a"], ["insert:c"]])
  })
})

describe.each(["settled", "incremental"] as const)("setWindow (%s publication)", (mode) => {
  const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(Effect.scoped(program.pipe(Effect.provideService(LiveQuery.Publication, { mode }))))
  const newest = (source: Collection.Collection<Note, string>, limit: number) =>
    LiveQuery.make((q) => q.from({ note: source.tanstack }).orderBy(({ note }) => note.n, "desc").limit(limit))

  test("widens and narrows the window over rows already loaded", async () => {
    const shown = await run(Effect.gen(function*() {
      const query = yield* Effect.flatMap(
        notes([note("a", 1), note("b", 2), note("c", 3)]),
        (source) => newest(source, 1)
      )
      yield* query.preload
      yield* query.setWindow({ limit: 3 })
      const wide = ids(yield* query.toArray)
      yield* query.setWindow({ limit: 2 })
      return { wide, narrow: ids(yield* query.toArray) }
    }))
    expect(shown).toEqual({ wide: ["c", "b", "a"], narrow: ["c", "b"] })
  })

  test("waits for an on-demand source to load the rows the window needs", async () => {
    const shown = await run(Effect.gen(function*() {
      const query = yield* Effect.flatMap(
        onDemand([note("a", 1), note("b", 2), note("c", 3)]),
        (source) => newest(source, 1)
      )
      yield* query.preload
      const first = ids(yield* query.toArray)
      yield* query.setWindow({ limit: 2 })
      return { first, then: ids(yield* query.toArray) }
    }))
    expect(shown).toEqual({ first: ["c"], then: ["c", "b"] })
  })

  test("fails with LoadFailed when the rows don't load, and keeps the window", async () => {
    const result = await run(Effect.gen(function*() {
      let serve: "rows" | "fail" = "rows"
      const source = yield* onDemand([note("a", 1), note("b", 2)], () => serve)
      const query = yield* newest(source, 1)
      yield* query.preload
      serve = "fail"
      const error = yield* Effect.flip(query.setWindow({ limit: 2 }))
      return { error: error._tag, window: query.tanstack.utils.getWindow() }
    }))
    expect(result).toEqual({ error: "LoadFailed", window: { offset: 0, limit: 1 } })
  })

  test("fails with LoadFailed on a query with no window", async () => {
    const error = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1)])
      const query = yield* LiveQuery.make((q) => q.from({ note: collection.tanstack }))
      yield* query.preload
      return yield* Effect.flip(query.setWindow({ limit: 1 }))
    }))
    expect(error._tag).toBe("LoadFailed")
  })
})

test.each(
  [
    { mode: undefined, override: undefined, remaining: 2 },
    { mode: "incremental", override: undefined, remaining: 0 },
    { mode: "settled", override: "incremental", remaining: 0 },
    { mode: "incremental", override: "settled", remaining: 2 }
  ] as const
)(
  "an ordered display withdraws gated rows according to publication $mode / $override",
  async ({ mode, override, remaining }) => {
    const options = override === undefined ? undefined : { publication: override }
    const program = Effect.gen(function*() {
      const source = yield* notes([note("a", 1, "repo"), note("b", 2, "repo")])
      const permission = yield* Collection.local({
        id: id("permission"),
        schema: Schema.Struct({ id: Schema.String, show: Schema.Boolean }),
        getKey: (row) => row.id,
        initialData: [{ id: "repo", show: true }]
      })
      // A real sync source that has not supplied its initial readiness receipt yet.
      const pending = yield* Collection.make(Note, {
        id: id("pending"),
        getKey: (row) => row.id,
        syncMode: "eager",
        sync: {
          sync: ({ begin, commit }) => {
            begin()
            commit()
            return () => {}
          }
        }
      })
      const gated = yield* LiveQuery.make((q) =>
        q.from({ row: source.tanstack })
          .innerJoin({ permission: permission.tanstack }, ({ row, permission }) => Query.eq(row.text, permission.id))
          .where(({ permission }) => Query.eq(permission.show, true))
          .leftJoin({ pending: pending.tanstack }, ({ row, pending }) => Query.eq(row.id, pending.id))
          .select(({ row }) => row), options)
      const latest = yield* LiveQuery.make(
        (q) => q.from({ row: gated.tanstack }).orderBy(({ row }) => row.n, "desc").limit(50),
        options
      )
      const display = yield* LiveQuery.make(
        (q) => q.from({ row: latest.tanstack }).orderBy(({ row }) => row.n),
        options
      )
      display.tanstack.startSyncImmediate()
      yield* display.rows.pipe(Stream.filter((rows) => rows.length === 2), Stream.take(1), Stream.runDrain)
      expect((yield* display.toArray).map((row) => row.id)).toEqual(["a", "b"])
      yield* permission.update("repo", (row) => {
        row.show = false
      })
      // Read in the same Effect: no microtask, timer or network completion may be needed for an incremental removal.
      const withdrawn = yield* display.toArray
      expect(withdrawn).toHaveLength(remaining)
      expect(yield* source.toArray).toHaveLength(2)
    })
    await run(mode === undefined ? program : program.pipe(Effect.provideService(LiveQuery.Publication, { mode })))
  }
)

test.each(["deny", "remove owner", "retain access"] as const)(
  "incremental queries fail closed and recover current rows after %s",
  async (change) =>
    run(
      Effect.gen(function*() {
        const source = yield* notes([note("a", 1, "repo"), note("b", 2, "repo")])
        const permission = yield* Collection.local({
          id: id("permission"),
          schema: Schema.Struct({ id: Schema.String, show: Schema.Boolean }),
          getKey: (row) => row.id,
          initialData: [{ id: "repo", show: true }]
        })
        let fail: () => void = () => {
          throw new Error("source not started")
        }
        let recover: () => void = () => {
          throw new Error("source not started")
        }
        const dependency = yield* Collection.make(Note, {
          id: id("dependency"),
          getKey: (row) => row.id,
          sync: {
            sync: ({ begin, commit, markReady, markError }) => {
              fail = () => markError(new Error("read failed"))
              recover = markReady
              begin()
              commit()
              markReady()
            }
          }
        })
        const gate = yield* LiveQuery.make((q) =>
          q.from({ row: source.tanstack })
            .innerJoin({ permission: permission.tanstack }, ({ row, permission }) => Query.eq(row.text, permission.id))
            .where(({ permission }) => Query.eq(permission.show, true)).select(({ row }) => row), {
          getKey: (row) => row.id
        })
        const joined = yield* LiveQuery.make((q) =>
          q.from({ row: gate.tanstack })
            .leftJoin({ dependency: dependency.tanstack }, ({ row, dependency }) => Query.eq(row.id, dependency.id))
            .select(({ row }) => row)
        )
        const display = yield* LiveQuery.make((q) => q.from({ row: joined.tanstack }).orderBy(({ row }) => row.n))
        yield* display.preload
        expect(ids(yield* display.toArray)).toEqual(["a", "b"])
        yield* Effect.sync(fail)
        expect(yield* joined.toArray).toEqual([])
        expect(yield* display.toArray).toEqual([])
        expect(display.tanstack.status).toBe("error")
        if (change === "deny") {
          yield* permission.update("repo", (row) => {
            row.show = false
          })
        }
        if (change === "remove owner") yield* permission.delete("repo")
        yield* source.update("a", (row) => {
          row.n = 3
        })
        yield* source.delete("b")
        yield* source.insert(note("c", 0, "repo"))
        expect(yield* display.toArray).toEqual([])
        yield* Effect.sync(recover)
        expect(display.tanstack.status).toBe("ready")
        expect(ids(yield* display.toArray)).toEqual(change === "retain access" ? ["c", "a"] : [])
        if (change === "deny") {
          yield* permission.update("repo", (row) => {
            row.show = true
          })
        }
        if (change === "remove owner") yield* permission.insert({ id: "repo", show: true })
        expect(ids(yield* display.toArray)).toEqual(["c", "a"])
      }).pipe(Effect.provide(LiveQuery.incremental))
    )
)

test("a failed lazy demand withdraws the downstream display until its read scope is reopened", async () => {
  await run(
    Effect.gen(function*() {
      const rows = yield* notes([note("a", 1, "repo")])
      const permission = yield* Collection.local({
        id: id("permission"),
        schema: Schema.Struct({ id: Schema.String, show: Schema.Boolean }),
        getKey: (row) => row.id,
        initialData: [{ id: "repo", show: true }]
      })
      let fail = false
      const view = Effect.gen(function*() {
        const dependency = yield* onDemand([note("a", 1)], () => fail ? "fail" : "rows")
        const gate = yield* LiveQuery.make((q) =>
          q.from({ row: rows.tanstack })
            .innerJoin({ permission: permission.tanstack }, ({ row, permission }) => Query.eq(row.text, permission.id))
            .where(({ permission }) => Query.eq(permission.show, true)).select(({ row }) => row)
        )
        const joined = yield* LiveQuery.make((q) =>
          q.from({ row: gate.tanstack })
            .leftJoin({ dependency: dependency.tanstack }, ({ row, dependency }) => Query.eq(row.id, dependency.id))
            .select(({ row }) => row)
        )
        const display = yield* LiveQuery.make((q) => q.from({ row: joined.tanstack }).orderBy(({ row }) => row.n))
        return { gate, joined, display }
      })
      const firstScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const first = yield* Scope.provide(view, firstScope)
      yield* first.display.preload
      expect(ids(yield* first.display.toArray)).toEqual(["a"])
      fail = true
      yield* rows.insert(note("b", 2, "repo"))
      yield* Effect.callback<void>((resume) => {
        const check = () => {
          if (first.display.tanstack.status === "error") resume(Effect.void)
        }
        const off = first.display.tanstack.on("status:change", check)
        check()
        return Effect.sync(off)
      })
      expect(yield* first.joined.toArray).toEqual([])
      expect(yield* first.display.toArray).toEqual([])
      expect(first.display.tanstack.status).toBe("error")
      expect(first.joined.tanstack.utils.lastSubsetError).toBeInstanceOf(Error)
      yield* permission.update("repo", (row) => {
        row.show = false
      })
      expect(yield* first.gate.toArray).toEqual([])
      expect(yield* first.display.toArray).toEqual([])
      yield* Scope.close(firstScope, Exit.void)
      fail = false
      const reopened = yield* view
      yield* reopened.display.preload
      expect(yield* reopened.display.toArray).toEqual([])
      yield* permission.update("repo", (row) => {
        row.show = true
      })
      yield* reopened.display.rows.pipe(Stream.filter((found) => found.length === 2), Stream.take(1), Stream.runDrain)
      expect(ids(yield* reopened.display.toArray)).toEqual(["a", "b"])
    }).pipe(Effect.provide(LiveQuery.incremental))
  )
})


test("synchronous observation records publications in its captured context and stops at scope close", async () => {
  class Receipt extends Context.Service<Receipt, { readonly prefix: string }>()("test/LiveQuery/Receipt") {}
  await run(Effect.gen(function*() {
    const source = yield* notes([note("a", 1)])
    const query = yield* LiveQuery.make((q) => q.from({ note: source.tanstack }).orderBy(({ note }) => note.n))
    yield* query.preload
    const scope = yield* Scope.make()
    const receipts: string[] = []
    yield* LiveQuery.observeSync(query, (rows) => Effect.gen(function*() {
      const receipt = yield* Receipt
      receipts.push(`${receipt.prefix}:${ids(rows).join(",")}`)
    })).pipe(Effect.provideService(Receipt, { prefix: "tab" }), Scope.provide(scope))
    expect(receipts.at(-1)).toBe("tab:a")
    yield* source.insert(note("b", 2))
    expect(ids(query.tanstack.toArray)).toEqual(["a", "b"])
    expect(receipts.at(-1)).toBe("tab:a,b")
    yield* source.delete("a")
    expect(receipts.at(-1)).toBe("tab:b")
    yield* Scope.close(scope, Exit.void)
    const count = receipts.length
    yield* source.insert(note("c", 3))
    expect(ids(query.tanstack.toArray)).toEqual(["b", "c"])
    expect(receipts).toHaveLength(count)
  }))
})
