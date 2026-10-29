import { FetchError } from "@electric-sql/client"
import { Collection, LiveQuery, Persistence } from "@smthrs/effect-tanstack-db"
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Logger,
  Metric,
  Option,
  References,
  Schedule,
  Schema,
  Scope,
  Stream,
  Tracer
} from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import { ElectricCollection, ShapeSource } from "../src/index.ts"
import {
  databaseFile,
  ELECTRIC_URL,
  electricUp,
  eventually,
  faulty,
  persistenceOn,
  postgres,
  type Row,
  scratchTable,
  storedRows
} from "./fixtures.ts"

// The Electric collection against the real Postgres and Electric (test/fixtures.ts). Faults are injected only on
// Electric's network.

const Note = Schema.Struct({ id: Schema.String, text: Schema.String, n: Schema.Number })

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(postgres)))

type Options = Partial<Omit<ElectricCollection.Options<Row, unknown, never>, "persist">>

const notesOf = (table: string, options: Options = {}) =>
  ElectricCollection.make<Row, unknown>({
    id: `notes-${crypto.randomUUID()}`,
    schema: Note,
    getKey: (row) => row.id,
    shape: { url: `${ELECTRIC_URL}/v1/shape`, params: { table }, parser: { int8: (value: string) => Number(value) } },
    retry: Schedule.spaced("10 millis"),
    ...options
  })

const changeTo = (id: string) => (change: ElectricCollection.Delivered<Row>) => change.value.id === id
const ids = (rows: ReadonlyArray<Row>) => rows.map(({ id }) => id)

/** Collects every sync event from when it runs, until the scope closes. */
const record = (collection: ElectricCollection.ElectricCollection<Row>) =>
  Effect.gen(function*() {
    const events: Array<string> = []
    yield* collection.sync.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(
            event._tag === "Failed"
              ? `Failed:${event.status ?? "network"}`
              : event._tag === "Stopped"
              ? `Stopped:${event.error.status ?? "none"}`
              : event._tag
          )
        })
      ),
      Effect.forkScoped({ startImmediately: true })
    )
    return events
  })

describe.skipIf(!electricUp)("make", () => {
  test("a source isolates client cache keys without changing the URL sent to Electric", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const source = yield* ShapeSource.ShapeSource
      const requests: Array<string> = []
      const isolated = {
        ...source,
        cacheNamespace: "separate realm & cache",
        request: (url: string, init: RequestInit) => {
          requests.push(url)
          return source.request(url, init)
        }
      }
      yield* write({ id: "a", text: "one", n: 1 })
      const notes = yield* notesOf(table).pipe(Effect.provideService(ShapeSource.ShapeSource, isolated))
      yield* notes.preload
      yield* write({ id: "b", text: "two", n: 2 })
      yield* notes.awaitMatch(changeTo("b"), "5 seconds")
      return { rows: ids(yield* notes.toArray), requests }
    }))
    expect(result.rows).toEqual(["a", "b"])
    expect(result.requests.length).toBeGreaterThan(0)
    for (const request of result.requests) {
      const url = new URL(request)
      expect(url.origin).toBe(new URL(ELECTRIC_URL).origin)
      expect(url.pathname).toBe("/v1/shape")
      expect(url.searchParams.has("smithers-cache-namespace")).toBe(false)
      expect(url.searchParams.has("table")).toBe(true)
    }
  })

  test.each([401, 403])("a fault-injected %s refusal retains cache isolation and status", async (status) => {
    const events = await run(Effect.gen(function*() {
      const { table } = yield* scratchTable
      const namespace = crypto.randomUUID()
      const { notes, retainedNamespace } = yield* Effect.gen(function*() {
        const source = yield* ShapeSource.ShapeSource
        return { notes: yield* notesOf(table), retainedNamespace: source.cacheNamespace }
      }).pipe(
        Effect.provide(ShapeSource.layerFaulty((faults) => faults.refuse(status))),
        Effect.provideService(ShapeSource.ShapeSource, { ...ShapeSource.fetchSource, cacheNamespace: namespace })
      )
      expect(retainedNamespace).toBe(namespace)
      const events = yield* record(notes)
      yield* notes.preload.pipe(Effect.forkScoped)
      yield* eventually(() => events.includes(`Stopped:${status}`))
      return events
    }))
    expect(events).toEqual(["Sent", `Stopped:${status}`])
  })

  test("a stopped shape is logged and counted by the collection's kind and status, never its id or URL", async () => {
    const lines: Array<{ readonly message: unknown; readonly level: string; readonly annotations: unknown }> = []
    const logger = Logger.make(({ message, logLevel, fiber }) =>
      void lines.push({ message, level: logLevel, annotations: fiber.getRef(References.CurrentLogAnnotations) })
    )
    const kind = `notes-${crypto.randomUUID()}`
    const counts = await run(
      Effect.gen(function*() {
        const { table } = yield* scratchTable
        const stopped = (id: string, status: number) =>
          Effect.gen(function*() {
            const notes = yield* notesOf(table, { id }).pipe(
              Effect.provide(ShapeSource.layerFaulty((faults) => faults.refuse(status)))
            )
            const events = yield* record(notes)
            yield* notes.preload.pipe(Effect.forkScoped)
            yield* eventually(() => events.includes(`Stopped:${status}`))
          })
        yield* stopped(`${kind}:conversation-1`, 400)
        yield* stopped(`${kind}:conversation-2`, 403)
        const count = (status: string) =>
          Metric.value(Metric.withAttributes(ElectricCollection.stops, { collection: kind, status })).pipe(
            Effect.map(({ count }) => count)
          )
        return [yield* count("400"), yield* count("403")]
      }).pipe(Effect.provide(Logger.layer([logger])), Effect.provideService(Metric.MetricRegistry, new Map()))
    )
    expect(counts).toEqual([1, 1])
    const stops = lines.filter(({ message }) => (message as Array<unknown>)[0] === "electric.shape.stopped")
    expect(stops.map(({ level, annotations }) => [level, annotations])).toEqual([
      ["Warn", { collection: kind, status: "400", error: "FetchError" }],
      ["Warn", { collection: kind, status: "403", error: "FetchError" }]
    ])
    expect(JSON.stringify(stops)).not.toContain("conversation-")
    expect(JSON.stringify(stops)).not.toContain("/v1/shape")
  })

  test("loads the shape, decoded by the schema with int8 parsed, and follows later writes", async () => {
    const rows = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      yield* write({ id: "a", text: "one", n: 9_007_199_254 })
      const notes = yield* notesOf(table)
      yield* notes.preload
      const loaded = yield* notes.toArray
      yield* write({ id: "b", text: "two", n: 2 })
      yield* notes.awaitMatch(changeTo("b"), "5 seconds")
      return { loaded: loaded.map(({ id, n }) => ({ id, n })), later: ids(yield* notes.toArray) }
    }))
    expect(rows).toEqual({ loaded: [{ id: "a", n: 9_007_199_254 }], later: ["a", "b"] })
  })

  test("maps snake_case columns to camelCase fields with snakeCamelMapper", async () => {
    const Camel = Schema.Struct({ id: Schema.String, createdBy: Schema.String })
    const row = await run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const schema = `effect_electric_${crypto.randomUUID().replaceAll("-", "")}`
      yield* Effect.acquireRelease(
        sql.unsafe(`create schema ${schema}`).pipe(
          Effect.andThen(sql.unsafe(`create table ${schema}.items (id text primary key, created_by text not null)`)),
          Effect.andThen(sql.unsafe(`insert into ${schema}.items values ('a', 'someone')`))
        ),
        () => sql.unsafe(`drop schema ${schema} cascade`).pipe(Effect.ignore)
      )
      const items = yield* ElectricCollection.make({
        id: `items-${crypto.randomUUID()}`,
        schema: Camel,
        getKey: (row) => row.id,
        shape: {
          url: `${ELECTRIC_URL}/v1/shape`,
          params: { table: `${schema}.items` },
          columnMapper: ElectricCollection.snakeCamelMapper()
        }
      })
      yield* items.preload
      return yield* items.get("a")
    }))
    expect(Option.map(row, ({ createdBy }) => createdBy)).toEqual(Option.some("someone"))
  })

  test("applied receipts follow installed rows and never report an invalid recovered batch", async () => {
    const Strict = Schema.Struct({ id: Schema.String, text: Schema.Literal("one"), n: Schema.Number })
    const result = await run(Effect.gen(function*() {
      const { table, write, rename } = yield* scratchTable
      yield* write({ id: "a", text: "one", n: 1 })
      const { faults, collection: notes } = yield* faulty(notesOf(table, { schema: Strict }))
      const installed: string[][] = []
      yield* notes.applied.pipe(
        Stream.runForEach(() =>
          Effect.flatMap(notes.toArray, (rows) =>
            Effect.sync(() => {
              installed.push(ids(rows))
            }))
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      const firstInstalled = yield* notes.currentApplied.pipe(Effect.forkScoped({ startImmediately: true }))
      yield* notes.preload
      yield* Fiber.join(firstInstalled)
      yield* eventually(() => installed.length > 0)
      const before = installed.length
      yield* faults.refuse(503)
      const events = yield* record(notes)
      yield* rename("a", "invalid")
      yield* eventually(() => events.includes("Failed:503"))
      yield* faults.heal
      yield* eventually(() => events.includes("Stopped:none"))
      const afterRefusal = yield* Effect.result(notes.currentApplied.pipe(Effect.timeout("50 millis")))
      return { installed, before, after: installed.length, afterRefusal }
    }))
    expect(result.installed[0]).toEqual(["a"])
    expect(result.after).toBe(result.before)
    expect(result.afterRefusal._tag).toBe("Failure")
  })

  test("an expired handle's metadata reset is not an applied batch before its replacement arrives", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const real = yield* ShapeSource.ShapeSource
      const replacement = yield* Latch.make(false)
      let expire = false
      let expired = false
      let requestedReplacement = false
      let beforeReset = 0
      const installed: string[][] = []
      // A faulty source sends one expired handle to the real Electric server, then holds the replacement.
      const source = ShapeSource.ShapeSource.of({
        request: (url, init) =>
          Effect.gen(function*() {
            if (expired) {
              requestedReplacement = true
              yield* replacement.await
            }
            const target = new URL(url)
            if (expire && !expired) {
              target.searchParams.set("handle", "expired-shape-recovery")
              const response = yield* real.request(target.href, init)
              expect(response.status).toBe(409)
              beforeReset = installed.length
              expired = true
              return response
            }
            return yield* real.request(url, init)
          })
      })
      yield* write({ id: "a", text: "one", n: 1 })
      const notes = yield* notesOf(table).pipe(Effect.provideService(ShapeSource.ShapeSource, source))
      yield* notes.applied.pipe(
        Stream.runForEach(() =>
          Effect.flatMap(notes.toArray, (rows) =>
            Effect.sync(() => {
              installed.push(ids(rows))
            }))
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* notes.preload
      yield* eventually(() => installed.length > 0)
      expire = true
      yield* write({ id: "b", text: "two", n: 2 })
      yield* eventually(() => requestedReplacement)
      expect(installed).toHaveLength(beforeReset)
      yield* replacement.open
      yield* eventually(() => installed.length > beforeReset && installed.at(-1)!.includes("b"))
      return installed.at(-1)
    }))
    expect(result?.sort()).toEqual(["a", "b"])
  })

  test("a synced row the schema refuses stops the shape, with no status", async () => {
    const Strict = Schema.Struct({ id: Schema.String, text: Schema.Literals(["one", "two"]), n: Schema.Number })
    const stop = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      yield* write({ id: "a", text: "three", n: 1 })
      const notes = yield* ElectricCollection.make({
        id: `strict-${crypto.randomUUID()}`,
        schema: Strict,
        getKey: (row) => row.id,
        shape: { url: `${ELECTRIC_URL}/v1/shape`, params: { table }, parser: { int8: Number } }
      })
      const stopped = yield* notes.sync.pipe(
        Stream.filter((event) => event._tag === "Stopped"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* notes.preload.pipe(Effect.ignore, Effect.forkScoped)
      return yield* Fiber.join(stopped)
    }))
    expect(stop).toMatchObject(Option.some({ _tag: "Stopped", error: { _tag: "SyncFailed" } }))
    expect(Option.getOrThrow(stop)._tag === "Stopped" && Option.getOrThrow(stop).error.status).toBe(undefined)
  })

  test("closes the shape when its scope closes", async () => {
    const status = await run(Effect.gen(function*() {
      const { table } = yield* scratchTable
      const scope = yield* Scope.make()
      const notes = yield* Scope.provide(notesOf(table), scope)
      yield* notes.preload
      yield* Scope.close(scope, Exit.void)
      return notes.tanstack.status
    }))
    expect(status).toBe("cleaned-up")
  })
})

// A service an onInsert handler reads from the services of the fiber that made the collection.
class Server extends Context.Service<Server, { readonly persist: (row: Row) => Effect.Effect<number> }>()(
  "test/Server"
) {}

describe.skipIf(!electricUp)("mutation handlers", () => {
  test("a held installation receipt cannot certify a later failed request", async () => {
    await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const acknowledged = yield* Latch.make(false)
      const release = yield* Latch.make(false)
      const { faults, collection: notes } = yield* faulty(notesOf(table, {
        onInsert: ({ rows, collection }) =>
          Effect.gen(function*() {
            const txid = yield* write(rows[0]!)
            yield* collection.awaitTxId(txid, "5 seconds")
            yield* acknowledged.open
            yield* release.await
          })
      }))
      let applied = 0
      yield* notes.applied.pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            applied++
          })
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      const events = yield* record(notes)
      yield* notes.preload
      yield* eventually(() => applied > 0)
      const before = applied
      const transaction = yield* notes.insert({ id: "a", text: "one", n: 1 })
      yield* acknowledged.await
      yield* faults.refuse(503)
      // Release any long poll already at Electric; its next request fails while installation is held.
      yield* write({ id: "b", text: "two", n: 2 })
      yield* eventually(() => events.includes("Failed:503"))
      yield* release.open
      yield* transaction.persisted
      yield* notes.awaitMatch(changeTo("b"), "5 seconds")
      expect(applied).toBe(before)
      expect(ids(yield* notes.toArray).sort()).toEqual(["a", "b"])
    }))
  })

  test("onInsert runs with the maker's services and tracer: the row shows at once, then synced once awaited", async () => {
    const spans: Array<string> = []
    const tracer = Tracer.make({
      span(options) {
        spans.push(options.name)
        return new Tracer.NativeSpan(options)
      }
    })
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const notes = yield* notesOf(table, {
        onInsert: ({ rows, collection }) =>
          Effect.gen(function*() {
            const server = yield* Server
            const txid = yield* server.persist(rows[0]!)
            yield* collection.awaitTxId(txid, "5 seconds")
          }).pipe(Effect.withSpan("persist note")) as never
      }).pipe(
        Effect.provideService(Server, Server.of({ persist: write })),
        Effect.provideService(Tracer.Tracer, tracer)
      )
      yield* notes.preload
      const transaction = yield* notes.insert({ id: "a", text: "one", n: 1 })
      const before = notes.tanstack.get("a")?.$synced
      yield* transaction.persisted
      return { before, after: notes.tanstack.get("a")?.$synced }
    }))
    expect(result).toEqual({ before: false, after: true })
    expect(spans).toContain("persist note")
  })

  test("a handler that fails rolls the rows back, and persisted fails with its error", async () => {
    const result = await run(Effect.gen(function*() {
      const { table } = yield* scratchTable
      const notes = yield* notesOf(table, { onInsert: () => Effect.fail("the server said no") })
      yield* notes.preload
      const transaction = yield* notes.insert({ id: "a", text: "one", n: 1 })
      const shown = notes.tanstack.has("a")
      const error = yield* Effect.flip(transaction.persisted)
      return { shown, error, after: notes.tanstack.has("a") }
    }))
    expect(result).toMatchObject({ shown: true, error: { _tag: "TransactionFailed" }, after: false })
  })

  test("onUpdate receives the changed rows and onDelete the deleted ones", async () => {
    const seen = await run(Effect.gen(function*() {
      const { table, write, rename, remove } = yield* scratchTable
      const seen: Array<string> = []
      yield* write({ id: "a", text: "one", n: 1 })
      const notes = yield* notesOf(table, {
        onUpdate: ({ rows, collection }) =>
          Effect.gen(function*() {
            seen.push(`update:${rows.map(({ text }) => text).join()}`)
            yield* rename(rows[0]!.id, rows[0]!.text)
            yield* collection.awaitMatch((change) => change.value.text === rows[0]!.text, "5 seconds")
          }),
        onDelete: ({ rows, collection }) =>
          Effect.gen(function*() {
            seen.push(`delete:${rows.map(({ id }) => id).join()}`)
            yield* remove(rows[0]!.id)
            yield* collection.awaitMatch((change) => change.operation === "delete", "5 seconds")
          })
      })
      yield* notes.preload
      yield* Effect.flatMap(
        notes.update("a", (draft) => {
          draft.text = "uno"
        }),
        (transaction) => transaction.persisted
      )
      yield* Effect.flatMap(notes.delete("a"), (transaction) => transaction.persisted)
      return { seen, rows: yield* notes.toArray }
    }))
    expect(seen).toEqual({ seen: ["update:uno", "delete:a"], rows: [] })
  })
})

describe.skipIf(!electricUp)("awaiting Electric", () => {
  test("awaitTxId waits for a transaction, and times out on one that never comes", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const notes = yield* notesOf(table)
      yield* notes.preload
      const txid = yield* write({ id: "a", text: "one", n: 1 })
      yield* notes.awaitTxId(txid, "5 seconds")
      const shown = notes.tanstack.has("a")
      const never = yield* Effect.flip(notes.awaitTxId(txid + 1_000_000, "100 millis"))
      return { shown, never: never._tag }
    }))
    expect(result).toEqual({ shown: true, never: "AwaitTimeout" })
  })

  test("awaitMatch counts a change already applied, and times out on one that never comes", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const notes = yield* notesOf(table)
      yield* notes.preload
      yield* write({ id: "a", text: "one", n: 1 })
      yield* notes.awaitMatch(changeTo("a"), "5 seconds")
      yield* notes.awaitMatch(changeTo("a"), "10 millis")
      return (yield* Effect.flip(notes.awaitMatch(changeTo("z"), "100 millis")))._tag
    }))
    expect(result).toBe("AwaitTimeout")
  })

  test("a wait the collection's cleanup ends fails with SyncFailed", async () => {
    const error = await run(Effect.gen(function*() {
      const { table } = yield* scratchTable
      const scope = yield* Scope.make()
      const notes = yield* Scope.provide(notesOf(table), scope)
      yield* notes.preload
      const waiting = yield* notes.awaitMatch(changeTo("z"), "10 seconds").pipe(
        Effect.flip,
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Scope.close(scope, Exit.void)
      return yield* Fiber.join(waiting)
    }))
    expect(error._tag).toBe("SyncFailed")
  })
})

describe.skipIf(!electricUp)("sync status and the sync policy", () => {
  test("reports each request, retries a network failure or a 5xx under the policy, and reconnect retries now", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const { faults, collection: notes } = yield* faulty(notesOf(table, { retry: Schedule.spaced("30 seconds") }))
      const events = yield* record(notes)
      yield* notes.preload
      yield* faults.down()
      yield* write({ id: "a", text: "one", n: 1 })
      yield* eventually(() => events.includes("Failed:network"))
      yield* faults.refuse(503)
      yield* notes.reconnect
      yield* eventually(() => events.includes("Failed:503"))
      yield* faults.heal
      const healedAt = Date.now()
      yield* notes.reconnect
      yield* notes.awaitMatch(changeTo("a"), "5 seconds")
      return { events, waited: Date.now() - healedAt }
    }))
    expect(result.events.slice(0, 2)).toEqual(["Sent", "Succeeded"])
    expect(result.events).not.toContain("Stopped:none")
    expect(result.events.at(-1)).toBe("Succeeded")
    expect(result.waited).toBeLessThan(2_000)
  })

  test.each([400, 403])(
    "a %s stops the shape with its status until reconnect, which restarts it where it stopped",
    async (status) => {
      const result = await run(Effect.gen(function*() {
        const { table, write } = yield* scratchTable
        const { faults, collection: notes } = yield* faulty(notesOf(table))
        const events = yield* record(notes)
        yield* write({ id: "a", text: "one", n: 1 })
        yield* notes.preload
        yield* faults.refuse(status)
        yield* write({ id: "b", text: "two", n: 2 })
        yield* eventually(() => events.includes(`Stopped:${status}`))
        yield* faults.heal
        const before = (yield* faults.sent).length
        // A healthy collection on the same shape sees the next write; the stopped one sends nothing meanwhile.
        const healthy = yield* notesOf(table)
        yield* healthy.preload
        yield* write({ id: "c", text: "three", n: 3 })
        yield* healthy.awaitMatch(changeTo("c"), "5 seconds")
        const quiet = (yield* faults.sent).length === before
        yield* notes.reconnect
        yield* notes.awaitMatch(changeTo("c"), "5 seconds")
        return {
          quiet,
          rows: ids(yield* notes.toArray).sort(),
          resumedFrom: (yield* faults.sent)[before]?.searchParams.get("offset")
        }
      }))
      expect(result.quiet).toBe(true)
      expect(result.rows).toEqual(["a", "b", "c"])
      expect(result.resumedFrom).not.toBe("-1")
    }
  )

  test("a subscriber that starts after the shape stopped still hears it stopped", async () => {
    const events = await run(Effect.gen(function*() {
      const { table } = yield* scratchTable
      const { faults, collection: notes } = yield* faulty(notesOf(table))
      const early = yield* record(notes)
      yield* faults.refuse(400)
      yield* notes.preload.pipe(Effect.ignore, Effect.forkScoped)
      yield* eventually(() => early.includes("Stopped:400"))
      const late = yield* record(notes)
      yield* eventually(() => late.length > 0)
      return late
    }))
    expect(events).toEqual(["Stopped:400"])
  })

  test.each([
    ["a network failure", (faults: ShapeSource.Switches) => faults.down(), "Stopped:none"],
    ["a 503", (faults: ShapeSource.Switches) => faults.refuse(503), "Stopped:503"]
  ])("a policy that ends hands %s to Electric, which stops the shape", async (_, fault, stopped) => {
    const events = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const { faults, collection: notes } = yield* faulty(notesOf(table, { retry: Schedule.recurs(1) }))
      const events = yield* record(notes)
      yield* notes.preload
      yield* fault(faults)
      yield* write({ id: "a", text: "one", n: 1 })
      yield* eventually(() => events.includes(stopped))
      return events
    }))
    expect(events.filter((event) => event.startsWith("Failed")).length).toBeGreaterThanOrEqual(2)
  })

  test("a shape stopped when its scope closes releases its wait", async () => {
    await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const scope = yield* Scope.make()
      const { faults, collection: notes } = yield* Scope.provide(faulty(notesOf(table)), scope)
      const events = yield* record(notes)
      yield* notes.preload
      yield* faults.refuse(400)
      yield* write({ id: "a", text: "one", n: 1 })
      yield* eventually(() => events.includes("Stopped:400"))
      yield* Scope.close(scope, Exit.void)
    }))
  })
})

// A live batch Electric's client can't read. It takes the response's offset from its headers before it parses the
// body (@electric-sql/client 1.5.28, electric-client-offset-bug.md), so a batch handed to it cut short was skipped when
// the shape restarted: the row in it never reached the device.
describe.skipIf(!electricUp)("a live batch that isn't whole", () => {
  const offsets = (urls: ReadonlyArray<URL>) => urls.map((url) => url.searchParams.get("offset"))

  test("cut short, it stops the shape before Electric takes its offset, and reconnect asks for that batch again", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const { faults, collection: notes } = yield* faulty(notesOf(table))
      const events = yield* record(notes)
      yield* write({ id: "a", text: "one", n: 1 })
      yield* notes.preload
      const mark = events.length
      yield* faults.corrupt("live")
      yield* write({ id: "b", text: "two", n: 2 })
      yield* eventually(() => events.includes("Stopped:none"))
      yield* faults.heal
      const cut = (yield* faults.sent).at(-1)!
      const before = (yield* faults.sent).length
      yield* notes.reconnect
      yield* write({ id: "c", text: "three", n: 3 })
      yield* notes.awaitMatch(changeTo("c"), "5 seconds")
      return {
        rows: ids(yield* notes.toArray).sort(),
        events: events.slice(mark),
        resumed: offsets(yield* faults.sent)[before],
        cut: cut.searchParams.get("offset")
      }
    }))
    expect(result.rows).toEqual(["a", "b", "c"])
    expect(result.events.filter((event) => event !== "Sent")[0]).toBe("Stopped:none")
    expect(result.resumed).toBe(result.cut)
  })

  test("broken off, it failed on the network: the policy sends the same request again, with no stop", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const { faults, collection: notes } = yield* faulty(notesOf(table))
      const events = yield* record(notes)
      yield* notes.preload
      const mark = events.length
      const before = (yield* faults.sent).length
      yield* faults.drop(40, "live")
      yield* write({ id: "a", text: "one", n: 1 })
      yield* eventually(() => events.slice(mark).includes("Failed:network"))
      yield* faults.heal
      yield* notes.awaitMatch(changeTo("a"), "5 seconds")
      return {
        events: events.slice(mark).filter((event) => event !== "Sent"),
        asked: (yield* faults.sent).slice(before)
      }
    }))
    expect(result.events.at(-1)).toBe("Succeeded")
    expect(new Set(result.events.slice(0, -1))).toEqual(new Set(["Failed:network"]))
    // Every request from the fault to the one that brought the row asked from one offset.
    expect(new Set(offsets(result.asked.slice(0, -1))).size).toBe(1)
  })

  // A seeded fuzz over where a live batch of one row (about 365 bytes here) is cut or breaks off: every point falls
  // inside it, and a negative one counts back from its end. Set CUT_SEED to explore other points; a failure names them.
  const seed = Number(process.env.CUT_SEED ?? 20_261_020)
  const random = (() => {
    let state = seed
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), state | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
    }
  })()
  const points = [0, 1, 2, -1, -2, ...Array.from({ length: 15 }, () => Math.floor(random() * 720) - 360)]
  const cases = points.flatMap((bytes) => [["cut", bytes], ["drop", bytes]] as const)

  test(
    `wherever a live batch is cut or breaks off, every row reaches the device exactly once (seed ${seed})`,
    async () => {
      const result = await run(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const { table, write } = yield* scratchTable
        const { faults, collection: notes } = yield* faulty(notesOf(table))
        const events = yield* record(notes)
        const inserts = new Map<string, number>()
        const watching = notes.tanstack.subscribeChanges((changes) => {
          for (const change of changes) {
            if (change.type === "insert") inserts.set(String(change.key), (inserts.get(String(change.key)) ?? 0) + 1)
          }
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => watching.unsubscribe()))
        yield* notes.preload
        const lost: Array<string> = []
        for (const [index, [how, bytes]] of cases.entries()) {
          const id = `r${index}`
          const mark = events.length
          yield* faults[how](bytes, "live")
          yield* write({ id, text: `${how} at ${bytes}`, n: index })
          // The fault has met the batch: the shape stopped, the request failed or, had the batch been taken, succeeded.
          yield* eventually(() => events.slice(mark).some((event) => event !== "Sent"))
          yield* faults.heal
          yield* notes.reconnect
          const arrived = yield* notes.awaitMatch(changeTo(id), "3 seconds").pipe(
            Effect.as(true),
            Effect.catchTag("AwaitTimeout", () => Effect.succeed(false))
          )
          if (!arrived) lost.push(`${how} at ${bytes}`)
        }
        const stored = yield* sql<{ id: string }>`select id from ${sql(table)}`
        return {
          lost,
          device: ids(yield* notes.toArray).sort(),
          postgres: stored.map(({ id }) => id).sort(),
          duplicated: [...inserts].filter(([, count]) => count > 1).map(([key]) => key)
        }
      }))
      expect(result.lost).toEqual([])
      expect(result.duplicated).toEqual([])
      expect(result.device).toEqual(result.postgres)
      expect(result.device).toHaveLength(cases.length)
    },
    120_000
  )

  // A source that answers the first live response its own way, then is the real source; `answered` says it has.
  const firstLive = (answer: (response: Response, url: URL) => Response) => {
    const state = { answered: false }
    const source: ShapeSource.Source = {
      request: (url, init) =>
        Effect.map(ShapeSource.fetchSource.request(url, init), (response) => {
          const parsed = new URL(url)
          if (state.answered || parsed.searchParams.get("live") !== "true") return response
          state.answered = true
          return answer(response, parsed)
        })
    }
    return { source, answered: () => state.answered }
  }

  test("a 2xx that isn't Electric's, such as a portal's page, stops the shape before Electric takes an offset", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const notes = yield* notesOf(table).pipe(
        Effect.provideService(
          ShapeSource.ShapeSource,
          firstLive(() => new Response("<html>signed out</html>", { status: 200 })).source
        )
      )
      const events = yield* record(notes)
      yield* notes.preload
      yield* write({ id: "a", text: "one", n: 1 })
      const stop = yield* notes.sync.pipe(Stream.filter((event) => event._tag === "Stopped"), Stream.runHead)
      yield* notes.reconnect
      yield* notes.awaitMatch(changeTo("a"), "5 seconds")
      return { stop, events }
    }))
    expect(result.stop).toMatchObject(
      Option.some({ _tag: "Stopped", error: { _tag: "SyncFailed", cause: { _tag: "Unreadable", status: 200 } } })
    )
    expect(Option.getOrThrow(result.stop)._tag === "Stopped" && Option.getOrThrow(result.stop).error.status)
      .toBeUndefined()
    expect(result.events).not.toContain("Failed:network")
  })

  test("a JSON body that isn't a batch stops the shape too", async () => {
    const stop = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const notes = yield* notesOf(table).pipe(
        Effect.provideService(
          ShapeSource.ShapeSource,
          firstLive((response) => new Response(`{"rows":[]}`, response)).source
        )
      )
      yield* notes.preload
      yield* write({ id: "a", text: "one", n: 1 })
      return yield* notes.sync.pipe(Stream.filter((event) => event._tag === "Stopped"), Stream.runHead)
    }))
    expect(stop).toMatchObject(Option.some({ _tag: "Stopped", error: { cause: { _tag: "Unreadable" } } }))
  })

  test("a 204, which older Electric servers sent when nothing was new, goes to Electric as it is", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      // Nothing new: the 204 says the offset the poll asked from.
      const older = firstLive((response, url) => {
        const headers = new Headers(response.headers)
        headers.set("electric-offset", url.searchParams.get("offset")!)
        return new Response(null, { status: 204, headers })
      })
      const notes = yield* notesOf(table).pipe(Effect.provideService(ShapeSource.ShapeSource, older.source))
      const events = yield* record(notes)
      yield* notes.preload
      yield* write({ id: "a", text: "one", n: 1 })
      yield* notes.awaitMatch(changeTo("a"), "5 seconds")
      return { answered: older.answered(), events }
    }))
    expect(result.answered).toBe(true)
    expect(new Set(result.events)).toEqual(new Set(["Sent", "Succeeded"]))
  })

  test("each request records the shape's handle, offset and row count on a span, and no row content", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        if (options.name === "electric.shape.request") spans.push(span)
        return span
      }
    })
    const id = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      const { faults, collection: notes } = yield* faulty(notesOf(table)).pipe(
        Effect.provideService(Tracer.Tracer, tracer)
      )
      yield* notes.preload
      yield* write({ id: "a", text: "words of one note", n: 1 })
      yield* notes.awaitMatch(changeTo("a"), "5 seconds")
      yield* faults.corrupt("live")
      yield* write({ id: "b", text: "words of another", n: 2 })
      yield* eventually(() => spans.some((span) => span.attributes.get("electric.shape.complete") === false))
      return notes.id
    }))
    const attributes = spans.map((span) => Object.fromEntries(span.attributes))
    const live = attributes.filter((span) => span["electric.shape.live"] === true)
    expect(live[0]).toEqual({
      "electric.collection": id,
      "electric.shape.live": true,
      "electric.shape.request_offset": expect.any(String),
      "http.response.status_code": 200,
      "electric.shape.handle": expect.any(String),
      "electric.shape.offset": expect.any(String),
      "electric.shape.bytes": expect.any(Number),
      "electric.shape.complete": true,
      "electric.shape.rows": 1
    })
    // The next live request asks from the offset the batch brought.
    expect(live[1]!["electric.shape.request_offset"]).toBe(live[0]!["electric.shape.offset"])
    expect(live.at(-1)).toMatchObject({ "electric.shape.complete": false })
    expect(live.at(-1)).not.toHaveProperty("electric.shape.rows")
    expect(JSON.stringify(attributes)).not.toMatch(/words of|"a"|"b"/)
  })
})

describe.skipIf(!electricUp)("progressive", () => {
  test("loads what a query asks for first, then the whole shape, and follows later writes", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      for (const n of [1, 2, 3, 4]) yield* write({ id: `r${n}`, text: "x", n })
      const notes = yield* notesOf(table, { syncMode: "progressive" })
      const newest = yield* LiveQuery.make((q) =>
        q.from({ note: notes.tanstack }).orderBy(({ note }) => note.n, "desc").limit(2)
      )
      yield* newest.preload
      const first = ids(yield* newest.toArray)
      yield* notes.preload
      yield* write({ id: "r5", text: "x", n: 5 })
      yield* notes.awaitMatch(changeTo("r5"), "5 seconds")
      return { first, all: ids(yield* notes.toArray).sort() }
    }))
    expect(result).toEqual({ first: ["r4", "r3"], all: ["r1", "r2", "r3", "r4", "r5"] })
  })
})

describe.skipIf(!electricUp)("persisted", () => {
  // Each program is a scope of its own over one SQLite file: closing one and opening the next is a reload.
  const persisted = (table: string, id: string, schemaVersion = 1) =>
    ElectricCollection.make<Row, unknown>({
      id,
      schema: Note,
      getKey: (row) => row.id,
      shape: { url: `${ELECTRIC_URL}/v1/shape`, params: { table }, parser: { int8: (value: string) => Number(value) } },
      retry: Schedule.spaced("10 millis"),
      persist: { schemaVersion }
    })

  test.each([false, true])(
    "a persisted writer certifies the first current batch, including empty (%s)",
    async (empty) => {
      await run(Effect.gen(function*() {
        const { table, write } = yield* scratchTable
        if (!empty) yield* write({ id: "a", text: "one", n: 1 })
        const path = databaseFile()
        const device = `device-${crypto.randomUUID()}`
        const result = yield* Effect.gen(function*() {
          const notes = yield* persisted(table, `notes-${crypto.randomUUID()}`)
          yield* notes.restored
          const waiting = yield* notes.currentApplied.pipe(Effect.forkScoped({ startImmediately: true }))
          yield* notes.preload
          yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"))
          yield* notes.currentApplied.pipe(Effect.timeout("5 seconds"))
          return ids(yield* notes.toArray)
        }).pipe(Effect.provide(persistenceOn(path, device)))
        expect(result).toEqual(empty ? [] : ["a"])
      }))
    }
  )

  // A program on `path`, its shape requests through the faulty source, which `start` switches before it syncs.
  const program = <A, E>(
    path: string,
    effect: Effect.Effect<A, E, Scope.Scope | Persistence.Persistence | ShapeSource.Faults>,
    start?: (switches: ShapeSource.Switches) => Effect.Effect<void>
  ) => Effect.scoped(effect).pipe(Effect.provide(persistenceOn(path)), Effect.provide(ShapeSource.layerFaulty(start)))

  test.each([false, true])(
    "a watcher waits for installed coordinator receipts, including an empty shape (%s)",
    async (empty) => {
      await run(Effect.gen(function*() {
        const { table, write } = yield* scratchTable
        if (!empty) yield* write({ id: "a", text: "one", n: 1 })
        const path = databaseFile()
        const device = `device-${crypto.randomUUID()}`
        const id = `notes-${crypto.randomUUID()}`
        const writerPersistence = yield* Layer.build(persistenceOn(path, device))
        const writer = yield* Effect.gen(function*() {
          const faults = yield* ShapeSource.Faults
          const notes = yield* persisted(table, id)
          yield* notes.restored
          const events = yield* record(notes)
          yield* eventually(() => events.includes("Sent"))
          return { notes, faults }
        }).pipe(
          Effect.provide(writerPersistence),
          Effect.provide(ShapeSource.layerFaulty((switches) => switches.stall()))
        )
        // The writer owns the lock but cannot install its first response. The watcher's own source succeeds.
        yield* eventually(() => writer.notes.tanstack.status === "loading")
        const watcherPersistence = yield* Layer.build(persistenceOn(path, device))
        const watcher = yield* Effect.gen(function*() {
          const faults = yield* ShapeSource.Faults
          const notes = yield* persisted(table, id)
          const installed: string[][] = []
          yield* notes.applied.pipe(
            Stream.runForEach(() =>
              Effect.flatMap(notes.toArray, (rows) =>
                Effect.sync(() => {
                  installed.push(ids(rows))
                }))
            ),
            Effect.forkScoped({ startImmediately: true })
          )
          yield* notes.preload
          yield* eventually(() => notes.tanstack.status === "ready")
          return { notes, faults, installed }
        }).pipe(
          Effect.provide(watcherPersistence),
          Effect.provide(ShapeSource.layerFaulty())
        )
        expect(watcher.installed).toEqual([])
        expect(yield* watcher.notes.toArray).toEqual([])
        yield* writer.faults.heal
        yield* writer.notes.preload
        yield* eventually(() => watcher.installed.length > 0)
        expect(watcher.installed.at(-1)).toEqual(empty ? [] : ["a"])
      }))
    }
  )

  test("a second coordinator installation of the same accepted cursor emits no duplicate applied receipt", async () => {
    await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      yield* write({ id: "a", text: "one", n: 1 })
      const path = databaseFile()
      const device = `device-${crypto.randomUUID()}`
      const id = `notes-${crypto.randomUUID()}`
      const writerPersistence = yield* Layer.build(persistenceOn(path, device))
      const writer = yield* faulty(persisted(table, id)).pipe(Effect.provide(writerPersistence))
      yield* writer.collection.preload
      yield* writer.faults.stall()
      const watcherPersistence = yield* Layer.build(persistenceOn(path, device))
      const watcher = yield* faulty(persisted(table, id)).pipe(Effect.provide(watcherPersistence))
      const installed: string[][] = []
      yield* watcher.collection.applied.pipe(
        Stream.runForEach(() =>
          Effect.flatMap(watcher.collection.toArray, (rows) =>
            Effect.sync(() => {
              installed.push(rows.map(({ text }) => text))
            }))
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* watcher.collection.preload
      yield* eventually(() => installed.length > 0)
      yield* watcher.faults.stall()
      expect(installed).toEqual([["one"]])
      // Both network sources are gated. An adapter commits another real device transaction while retaining its
      // installed Electric cursor, so only coordinator hydration can account for the changed row.
      let deliver!: () => true | Promise<void>
      const peer = yield* Collection.make(Note, {
        id,
        getKey: (row) => row.id,
        sync: {
          sync: (params) => {
            deliver = () => {
              params.begin()
              params.write({ type: "update", value: { id: "a", text: "two", n: 1 } })
              return params.commit()
            }
            params.markReady()
          }
        }
      }, { persist: { schemaVersion: 1 } }).pipe(Effect.provideService(Persistence.Persistence, {
        ...Context.get(writerPersistence, Persistence.Persistence),
        lock: undefined
      }))
      yield* peer.restored
      yield* Effect.promise(() => Promise.resolve(deliver()))
      yield* watcher.collection.awaitRow((row) => row.text === "two", "5 seconds")
      // Drain the already queued stream observer after the gated coordinator commit.
      yield* Effect.yieldNow
      expect(installed).toEqual([["one"]])
    }))
  })

  test.each([false, true])(
    "a watcher certifies rows already installed before its source recovers (%s)",
    async (empty) => {
      await run(Effect.gen(function*() {
        const { table, write } = yield* scratchTable
        if (!empty) yield* write({ id: "a", text: "one", n: 1 })
        const path = databaseFile()
        const device = `device-${crypto.randomUUID()}`
        const id = `notes-${crypto.randomUUID()}`
        const writerPersistence = yield* Layer.build(persistenceOn(path, device))
        const writer = yield* Effect.gen(function*() {
          const faults = yield* ShapeSource.Faults
          const notes = yield* persisted(table, id)
          yield* notes.preload
          // No later writer commit may rescue the watcher after it recovers.
          yield* faults.stall()
          return { notes, faults }
        }).pipe(Effect.provide(writerPersistence), Effect.provide(ShapeSource.layerFaulty()))
        const watcherPersistence = yield* Layer.build(persistenceOn(path, device))
        yield* Effect.gen(function*() {
          const faults = yield* ShapeSource.Faults
          const notes = yield* persisted(table, id)
          const installed: string[][] = []
          yield* notes.applied.pipe(
            Stream.runForEach(() =>
              Effect.flatMap(notes.toArray, (rows) =>
                Effect.sync(() => {
                  installed.push(ids(rows))
                }))
            ),
            Effect.forkScoped({ startImmediately: true })
          )
          yield* notes.restored
          const events = yield* record(notes)
          yield* eventually(() => events.includes("Failed:network"))
          expect(ids(yield* notes.toArray)).toEqual(empty ? [] : ["a"])
          expect(installed).toEqual([])
          yield* faults.heal
          yield* notes.reconnect
          yield* notes.preload
          yield* eventually(() => installed.length > 0)
          expect(installed.at(-1)).toEqual(empty ? [] : ["a"])
          expect(ids(yield* writer.notes.toArray)).toEqual(empty ? [] : ["a"])
        }).pipe(
          Effect.provide(watcherPersistence),
          Effect.provide(ShapeSource.layerFaulty((switches) => switches.down()))
        )
      }))
    }
  )

  test("restores the rows before Electric answers, and resumes from the stored handle and offset", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      yield* write({ id: "a", text: "one", n: 1 })
      const path = databaseFile()
      const id = `notes-${crypto.randomUUID()}`
      // The first program syncs, and closes once the row is stored.
      yield* program(
        path,
        Effect.flatMap(persisted(table, id), (notes) => notes.preload).pipe(
          Effect.andThen(eventually(() => storedRows(path, id) === 1))
        )
      )
      // Written while no program runs.
      yield* write({ id: "b", text: "two", n: 2 })
      return yield* program(
        path,
        Effect.gen(function*() {
          const faults = yield* ShapeSource.Faults
          const notes = yield* persisted(table, id)
          yield* notes.restored
          const offline = { rows: ids(yield* notes.toArray), status: notes.tanstack.status }
          yield* faults.heal
          yield* notes.reconnect
          yield* notes.preload
          yield* eventually(() => notes.tanstack.has("b"))
          const first = (yield* faults.sent).find((url) => url.searchParams.get("live") !== "true")!
          return {
            offline,
            online: ids(yield* notes.toArray).sort(),
            resumed: { handle: first.searchParams.has("handle"), offset: first.searchParams.get("offset") }
          }
        }),
        (switches) => switches.down()
      )
    }))
    expect(result.offline).toEqual({ rows: ["a"], status: "loading" })
    expect(result.online).toEqual(["a", "b"])
    expect(result.resumed.handle).toBe(true)
    expect(result.resumed.offset).not.toBe("-1")
  })

  test("a new schemaVersion syncs the shape again from the start", async () => {
    const result = await run(Effect.gen(function*() {
      const { table, write } = yield* scratchTable
      yield* write({ id: "a", text: "one", n: 1 })
      const path = databaseFile()
      const id = `notes-${crypto.randomUUID()}`
      // The first program syncs, and closes once the row is stored.
      yield* program(
        path,
        Effect.flatMap(persisted(table, id), (notes) => notes.preload).pipe(
          Effect.andThen(eventually(() => storedRows(path, id) === 1))
        )
      )
      return yield* program(
        path,
        Effect.gen(function*() {
          const faults = yield* ShapeSource.Faults
          const notes = yield* persisted(table, id, 2)
          yield* notes.restored
          const restored = ids(yield* notes.toArray)
          yield* notes.preload
          return {
            restored,
            synced: ids(yield* notes.toArray),
            offset: (yield* faults.sent)[0]!.searchParams.get("offset")
          }
        })
      )
    }))
    expect(result).toEqual({ restored: [], synced: ["a"], offset: "-1" })
  })
})

test("statusOf reads a status from an Electric error or a SyncFailed, anywhere in a cause chain", () => {
  const refused = new FetchError(400, "refused", undefined, {}, `${ELECTRIC_URL}/v1/shape`)
  expect(ElectricCollection.statusOf(new Error("outer", { cause: refused }))).toEqual(Option.some(400))
  const failed = new ElectricCollection.SyncFailed({ cause: new Error("x"), status: 409 })
  expect(ElectricCollection.statusOf(failed)).toEqual(Option.some(409))
  expect(ElectricCollection.statusOf(new Error("outer", { cause: failed }))).toEqual(Option.some(409))
  expect(ElectricCollection.statusOf(new ElectricCollection.SyncFailed({ cause: "no status" }))).toEqual(Option.none())
  expect(ElectricCollection.statusOf("a string")).toEqual(Option.none())
  let deep: unknown = failed
  for (let depth = 0; depth < 8; depth++) deep = new Error("wrap", { cause: deep })
  expect(ElectricCollection.statusOf(deep)).toEqual(Option.none())
})
