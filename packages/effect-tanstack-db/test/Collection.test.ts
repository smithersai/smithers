import { type SyncConfig, whenSyncAccepted } from "@tanstack/db"
import { Cause, Effect, Exit, Fiber, Option, Schema, Scope, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { Collection } from "../src/index.ts"
import { id, Note, note, withLogs } from "./fixtures.ts"

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

const notes = (initialData: ReadonlyArray<Note> = []) =>
  Collection.local({ id: id("notes"), schema: Note, getKey: (row) => row.id, initialData })

const texts = (rows: ReadonlyArray<Note>) => rows.map(({ id, text }) => `${id}:${text}`)

describe("local", () => {
  test("lives until its scope closes, then is cleaned up", async () => {
    const statuses = await Effect.runPromise(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const collection = yield* Scope.provide(notes([note("a", 1)]), scope)
      yield* collection.preload
      const before = collection.tanstack.status
      yield* Scope.close(scope, Exit.void)
      return [before, collection.tanstack.status]
    }))
    expect(statuses).toEqual(["ready", "cleaned-up"])
  })

  test("decodes its initial rows, and a row that doesn't decode is a defect", async () => {
    const rows = await run(Effect.flatMap(notes([note("a", 1), note("b", 2)]), (collection) => collection.toArray))
    expect(texts(rows)).toEqual(["a:a", "b:b"])
    const exit = await Effect.runPromiseExit(
      Effect.scoped(notes([{ id: "a", text: "one", n: "1" } as unknown as Note]))
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })

  test("starts empty without initial rows", async () => {
    const rows = await run(Effect.flatMap(
      Collection.local({ id: id("notes"), schema: Note, getKey: (row) => row.id }),
      (collection) => collection.toArray
    ))
    expect(rows).toEqual([])
  })
})

describe("reads", () => {
  test("toArray and get read the rows as they are now", async () => {
    const [all, found, missing] = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1), note("b", 2)])
      return [yield* collection.toArray, yield* collection.get("b"), yield* collection.get("z")] as const
    }))
    expect(texts(all)).toEqual(["a:a", "b:b"])
    expect(Option.map(found, ({ n }) => n)).toEqual(Option.some(2))
    expect(missing).toEqual(Option.none())
  })
})

describe("installed sync receipts", () => {
  test("observes committed metadata and rows only after a held transaction becomes visible", async () => {
    await run(Effect.gen(function*() {
      let source!: Parameters<SyncConfig<Note, string>["sync"]>[0]
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      const seen: Array<{ cursor: unknown; rows: string[] }> = []
      const collection = yield* Collection.make(Note, {
        id: id("receipts"),
        getKey: (row) => row.id,
        sync: {
          sync: (params) => {
            source = params
            params.markReady()
          }
        },
        onInsert: () => held,
        onSyncCommit: ({ getMetadata }) =>
          seen.push({
            cursor: getMetadata("cursor"),
            rows: [...collection.tanstack.keys()]
          })
      })
      yield* collection.preload
      source.begin()
      source.metadata!.collection.set("cursor", 1)
      expect(source.commit()).toBe(true)
      expect(seen).toEqual([{ cursor: 1, rows: [] }])
      const transaction = yield* collection.insert(note("a", 1))
      source.begin()
      source.write({ type: "insert", value: note("a", 1) })
      source.metadata!.collection.set("cursor", 2)
      const receipt = source.commit()
      expect(receipt).not.toBe(true)
      expect(whenSyncAccepted(receipt)).toBe(true)
      expect(seen).toHaveLength(1)
      source.begin()
      source.metadata!.collection.set("cursor", 3)
      release()
      yield* transaction.persisted
      yield* Effect.promise(() => Promise.resolve(receipt))
      expect(seen).toEqual([{ cursor: 1, rows: [] }, { cursor: 2, rows: ["a"] }])
      const aborted = new AbortController()
      aborted.abort()
      yield* Effect.promise(() => Promise.resolve(source.commit(aborted.signal)).catch(() => undefined))
      expect(seen).toHaveLength(2)
    }))
  })
})

describe("mutations", () => {
  test("insert, update and delete apply at once, one row or many, and each transaction is persisted", async () => {
    const seen = await run(Effect.gen(function*() {
      const collection = yield* notes()
      const now = () => texts(collection.tanstack.toArray)
      const states: Array<Array<string>> = []
      const transactions = [
        yield* collection.insert(note("a", 1)),
        yield* collection.insert([note("b", 2), note("c", 3)])
      ]
      states.push(now())
      transactions.push(
        yield* collection.update("a", (draft) => {
          draft.text = "uno"
        })
      )
      states.push(now())
      transactions.push(yield* collection.delete("b"), yield* collection.delete(["c"]))
      states.push(now())
      yield* Effect.forEach(transactions, (transaction) => transaction.persisted)
      expect(new Set(transactions.map(({ id }) => id)).size).toBe(transactions.length)
      return states
    }))
    expect(seen).toEqual([["a:a", "b:b", "c:c"], ["a:uno", "b:b", "c:c"], ["a:uno"]])
  })

  test("refuses a duplicate key, a missing key, and a row or change the schema refuses, with what was refused", async () => {
    const refused = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1)])
      const errors = [
        yield* Effect.flip(collection.insert(note("a", 2))),
        yield* Effect.flip(collection.insert({ id: "b", text: "two" } as unknown as Note)),
        yield* Effect.flip(collection.update("z", () => {})),
        yield* Effect.flip(collection.update("a", (draft) => {
          ;(draft as { n: unknown }).n = "not a number"
        })),
        yield* Effect.flip(collection.delete("z"))
      ]
      return { errors, rows: yield* collection.toArray }
    }))
    expect(refused.errors.map(({ _tag, operation }) => `${_tag}:${operation}`)).toEqual([
      "MutationRefused:insert",
      "MutationRefused:insert",
      "MutationRefused:update",
      "MutationRefused:update",
      "MutationRefused:delete"
    ])
    expect(refused.errors.every(({ cause }) => cause instanceof Error)).toBe(true)
    expect(texts(refused.rows)).toEqual(["a:a"])
  })
})

describe("changes", () => {
  test("streams every change from when the stream starts, in order, and unsubscribes when it ends", async () => {
    const { batches, subscribers } = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1)])
      const fiber = yield* collection.changes().pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* collection.insert(note("b", 2))
      yield* collection.update("a", (draft) => {
        draft.n = 10
      })
      yield* collection.delete("b")
      const batches = yield* Fiber.join(fiber)
      return { batches, subscribers: collection.tanstack.subscriberCount }
    }))
    expect(batches.map((batch) => batch.map(({ type, key }) => `${type}:${key}`))).toEqual([
      ["insert:b"],
      ["update:a"],
      ["delete:b"]
    ])
    expect(batches[1]?.[0]).toMatchObject({ value: { id: "a", n: 10 }, previousValue: { id: "a", n: 1 } })
    expect(subscribers).toBe(0)
  })

  test("with initial, the current rows are the first batch", async () => {
    const first = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1), note("b", 2)])
      return yield* Stream.runHead(collection.changes({ initial: true }))
    }))
    expect(Option.map(first, (batch) => batch.map(({ type, key }) => `${type}:${key}`))).toEqual(
      Option.some(["insert:a", "insert:b"])
    )
  })
})

describe("awaitRow", () => {
  // A predicate that counts the rows it is asked about, so a test sees whether anything still listens.
  const counting = (accept: (row: Note) => boolean) => {
    const asked = { count: 0 }
    return { asked, match: (row: Note) => (asked.count++, accept(row)) }
  }

  test("answers a row there now at once, and one that shows later once it does; other changes and deletes don't count", async () => {
    const seen = await run(Effect.gen(function*() {
      const collection = yield* notes([note("a", 1)])
      yield* collection.preload
      const now = counting((row) => row.id === "a")
      const there = yield* collection.awaitRow(now.match, "1 second")
      const soon = counting((row) => row.n === 3)
      const later = yield* Effect.forkChild(collection.awaitRow(soon.match, "5 seconds"), { startImmediately: true })
      yield* collection.insert(note("b", 2))
      yield* collection.delete("a")
      yield* collection.update("b", (draft) => void (draft.n = 3))
      const shown = yield* Fiber.join(later)
      // Once each has its row, neither listens: a later change isn't even looked at.
      const before = [now.asked.count, soon.asked.count]
      yield* collection.insert(note("c", 3))
      return { there: there.id, shown: shown.id, before, after: [now.asked.count, soon.asked.count] }
    }))
    expect({ there: seen.there, shown: seen.shown }).toEqual({ there: "a", shown: "b" })
    expect(seen.after).toEqual(seen.before)
  })

  test("fails with TimeoutError when no row shows in time, and stops listening", async () => {
    const seen = await run(Effect.gen(function*() {
      const collection = yield* notes()
      const never = counting((row) => row.id === "never")
      const waited = yield* Effect.exit(collection.awaitRow(never.match, "20 millis"))
      const asked = never.asked.count
      yield* collection.insert(note("never", 1))
      return { waited, after: never.asked.count - asked }
    }))
    expect(Exit.isFailure(seen.waited) && Cause.squash(seen.waited.cause)).toMatchObject({ _tag: "TimeoutError" })
    expect(seen.after).toBe(0)
  })
})

describe("make, over a sync adapter", () => {
  // A sync adapter that serves `rows`, writes back what its handler persists, and fails the way a test asks.
  const adapter = (options: {
    readonly rows?: ReadonlyArray<Note>
    readonly failFirstSync?: unknown
    readonly failCleanup?: unknown
    readonly refuse?: () => boolean
  }) => {
    let echo: (rows: ReadonlyArray<Note>) => void = () => {}
    return Collection.make(Note, {
      id: id("synced"),
      getKey: (row: Note) => row.id,
      sync: {
        sync: ({ begin, write, commit, markReady, markError }) => {
          if (options.failFirstSync !== undefined) {
            markError(options.failFirstSync)
            return
          }
          echo = (rows) => {
            begin()
            for (const value of rows) write({ type: "insert", value })
            commit()
          }
          echo(options.rows ?? [])
          markReady()
          return () => {
            if (options.failCleanup !== undefined) throw options.failCleanup
          }
        }
      },
      onInsert: async ({ transaction }) => {
        if (options.refuse?.() === true) throw new Error("refused")
        echo(transaction.mutations.map(({ modified }) => modified))
      }
    })
  }

  test("loads the adapter's rows, checked by the schema", async () => {
    const rows = await run(Effect.gen(function*() {
      const collection = yield* adapter({ rows: [note("a", 1)] })
      yield* collection.preload
      return yield* collection.toArray
    }))
    expect(texts(rows)).toEqual(["a:a"])
  })

  test("preload fails with LoadFailed, carrying the adapter's error, when the first sync fails", async () => {
    const failure = new Error("source down")
    const error = await run(
      Effect.flatMap(adapter({ failFirstSync: failure }), (collection) => Effect.flip(collection.preload))
    )
    expect(error).toMatchObject({ _tag: "LoadFailed", cause: failure })
  })

  test("a mutation the handler persists succeeds; one it fails rolls back with TransactionFailed", async () => {
    const result = await run(Effect.gen(function*() {
      let fail = false
      const collection = yield* adapter({ refuse: () => fail })
      yield* collection.preload
      yield* Effect.flatMap(collection.insert(note("a", 1)), (transaction) => transaction.persisted)
      fail = true
      const synced = yield* collection.isSynced("a")
      const transaction = yield* collection.insert(note("b", 2))
      const shown = Option.isSome(yield* collection.get("b"))
      const pending = yield* collection.isSynced("b")
      const error = yield* Effect.flip(transaction.persisted)
      return {
        synced,
        shown,
        pending,
        error,
        rows: texts(yield* collection.toArray),
        gone: yield* collection.isSynced("b")
      }
    }))
    expect(result).toMatchObject({ synced: true, shown: true, pending: false, gone: false })
    expect(result.error).toMatchObject({ _tag: "TransactionFailed", cause: new Error("refused") })
    expect(result.rows).toEqual(["a:a"])
  })

  test("logs a failed cleanup by its error's name and the collection's id, and still closes its scope", async () => {
    const { result, logs } = await withLogs(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const collection = yield* Scope.provide(
        adapter({ failCleanup: new RangeError("a message that stays out") }),
        scope
      )
      yield* collection.preload
      yield* Scope.close(scope, Exit.void)
      return collection.id
    }))
    expect(logs).toEqual([
      {
        message: ["collection cleanup failed"],
        level: "Warn",
        annotations: { collection: result, error: "SyncCleanupError" }
      }
    ])
  })
})

test("a schema's refinements apply to every row", async () => {
  const Positive = Schema.Struct({ id: Schema.String, n: Schema.Number.check(Schema.isGreaterThan(0)) })
  const error = await run(Effect.gen(function*() {
    const collection = yield* Collection.local({ id: id("positive"), schema: Positive, getKey: (row) => row.id })
    return yield* Effect.flip(collection.insert({ id: "a", n: -1 }))
  }))
  expect(error).toMatchObject({ _tag: "MutationRefused", operation: "insert" })
})

describe("pending write receipts", () => {
  for (const operation of ["insert", "update", "delete"] as const) {
    test(`${operation} exposes its actual receipt even when its row is optimistically absent`, async () => {
      await run(Effect.gen(function*() {
        let resolve!: () => void
        const gate = new Promise<void>((done) => {
          resolve = done
        })
        const collection = yield* Collection.make(Note, {
          id: id("pending"),
          getKey: (row) => row.id,
          sync: {
            sync: (source) => {
              source.begin()
              source.write({ type: "insert", value: note("a", 1) })
              source.commit()
              source.markReady()
            }
          },
          onInsert: () => gate,
          onUpdate: () => gate,
          onDelete: () => gate
        })
        yield* collection.preload
        const write = yield* operation === "insert" ?
          collection.insert([note("b", 2), note("c", 3)])
          : operation === "update"
          ? collection.update("a", (row) => {
            row.n = 2
          })
          : collection.delete("a")
        const key = operation === "insert" ? "b" : "a"
        expect((yield* collection.pendingWrites(key)).map((row) => row.id)).toEqual([write.id])
        expect(yield* collection.pendingWrites("absent")).toEqual([])
        if (operation === "insert") {
          expect((yield* collection.pendingWrites("c")).map((row) => row.id)).toEqual([write.id])
        }
        if (operation === "delete") expect(yield* collection.get(key)).toEqual(Option.none())
        const waiter = yield* write.persisted.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Fiber.interrupt(waiter)
        expect((yield* collection.pendingWrites(key)).map((row) => row.id)).toEqual([write.id])
        resolve()
        yield* write.persisted
        expect(yield* collection.pendingWrites(key)).toEqual([])
      }))
    })
  }

  test("a failed actual receipt releases pending state and retains its typed failure", async () => {
    await run(Effect.gen(function*() {
      let reject!: (error: Error) => void
      const gate = new Promise<void>((_, fail) => {
        reject = fail
      })
      const collection = yield* Collection.make(Note, {
        id: id("pending-failure"),
        getKey: (row) => row.id,
        sync: {
          sync: (source) => {
            source.markReady()
          }
        },
        onInsert: () => gate
      })
      const write = yield* collection.insert(note("a", 1))
      expect((yield* collection.pendingWrites("a")).map((row) => row.id)).toEqual([write.id])
      reject(new Error("refused"))
      const failed = yield* Effect.flip(write.persisted)
      expect(failed._tag).toBe("TransactionFailed")
      expect(yield* collection.pendingWrites("a")).toEqual([])
    }))
  })

  test("a transaction across collections reports only the queried collection's keys", async () => {
    const { createTransaction } = await import("@tanstack/db")
    await run(Effect.gen(function*() {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const left = yield* notes()
      const right = yield* notes()
      const transaction = createTransaction({ autoCommit: false, mutationFn: () => gate })
      transaction.mutate(() => {
        Effect.runSync(left.insert(note("left", 1)))
        Effect.runSync(right.insert(note("right", 2)))
      })
      expect((yield* left.pendingWrites("left")).map((row) => row.id)).toEqual([transaction.id])
      expect(yield* left.pendingWrites("right")).toEqual([])
      expect((yield* right.pendingWrites("right")).map((row) => row.id)).toEqual([transaction.id])
      const commit = transaction.commit()
      release()
      yield* Effect.promise(() => commit)
      expect(yield* left.pendingWrites("left")).toEqual([])
    }))
  })
})
