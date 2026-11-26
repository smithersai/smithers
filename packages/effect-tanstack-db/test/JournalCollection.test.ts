/**
 * `JournalCollection` on the real `@tanstack/db`, fed by a node's local
 * projection of a shard: a map of rows with a cursor, as a shard client's
 * `apply` keeps them in SQLite, publishing one batch per local commit.
 */
import { Cause, Deferred, Effect, Exit, Fiber, Option, Queue, Scope, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { JournalCollection } from "../src/index.ts"
import { id, Note, note } from "./fixtures.ts"

type Change = JournalCollection.RowChange<Note, string>

/** A local projection: rows, a cursor, and a batch per commit to every subscriber. */
const projection = (initial: ReadonlyArray<Note> = []) => {
  const rows = new Map(initial.map((row) => [row.id, row]))
  let through = 0
  const subscribers = new Set<(batch: JournalCollection.Batch<Note, string>) => void>()
  const publish = (batch: JournalCollection.Batch<Note, string>) => {
    for (const subscriber of subscribers) subscriber(batch)
  }
  const apply = (changes: ReadonlyArray<Change>) => {
    for (const change of changes) {
      if (change.type === "delete") rows.delete(change.key)
      else rows.set(change.value.id, change.value)
    }
  }
  return {
    subscribers,
    through: () => through,
    commit: (changes: ReadonlyArray<Change>) => {
      apply(changes)
      publish({ snapshot: false, through: ++through, changes })
      return through
    },
    /** A resync: the projection is rebuilt from a shard snapshot. */
    reset: (next: ReadonlyArray<Note>) => {
      rows.clear()
      apply(next.map((value): Change => ({ type: "insert", value })))
      publish({ snapshot: true, through: ++through, changes: next.map((value): Change => ({ type: "insert", value })) })
    },
    batches: Stream.callback<JournalCollection.Batch<Note, string>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          Queue.offerUnsafe(queue, {
            snapshot: true,
            through,
            changes: [...rows.values()].map((value): Change => ({ type: "insert", value }))
          })
          const subscriber = (batch: JournalCollection.Batch<Note, string>) => void Queue.offerUnsafe(queue, batch)
          subscribers.add(subscriber)
          return subscriber
        }),
        (subscriber) => Effect.sync(() => subscribers.delete(subscriber))
      )
    )
  }
}

type Projection = ReturnType<typeof projection>

/** A shard that accepts every write: the answer lands in the projection, whose cursor `submit` returns. */
const accepting = (local: Projection): JournalCollection.Source<Note, string>["submit"] => (mutations) =>
  Effect.sync(() =>
    local.commit(
      mutations.map((mutation) =>
        mutation.type === "delete"
          ? { type: "delete", key: mutation.key }
          : { type: mutation.type, value: mutation.value }
      )
    )
  )

const eventually = (check: () => boolean) =>
  Effect.gen(function*() {
    while (!check()) yield* Effect.sleep(1)
  }).pipe(Effect.timeout(5_000))

const notes = (local: Projection, submit = accepting(local)) =>
  JournalCollection.make({
    id: id("journal-notes"),
    schema: Note,
    getKey: (row) => row.id,
    source: { batches: local.batches, submit }
  })

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

const texts = (rows: ReadonlyArray<Note>) => rows.map(({ id, text }) => `${id}:${text}`).sort()

describe("JournalCollection", () => {
  test("hydrates from the projection's rows and is ready", async () => {
    const local = projection([note("a", 1), note("b", 2)])
    const [rows, status] = await run(Effect.gen(function*() {
      const collection = yield* notes(local)
      yield* collection.preload
      return [yield* collection.toArray, collection.tanstack.status] as const
    }))
    expect(texts(rows)).toEqual(["a:a", "b:b"])
    expect(status).toBe("ready")
  })

  test("shows each local commit: insert, update and delete, and a resync's snapshot", async () => {
    const local = projection([note("a", 1), note("b", 2)])
    await run(Effect.gen(function*() {
      const collection = yield* notes(local)
      yield* collection.preload
      local.commit([
        { type: "insert", value: note("c", 3) },
        { type: "update", value: note("a", 10, "A") },
        { type: "delete", key: "b" }
      ])
      yield* eventually(() => collection.tanstack.get("b") === undefined)
      expect(texts(yield* collection.toArray)).toEqual(["a:A", "c:c"])
      expect(yield* collection.isSynced("c")).toBe(true)
      local.reset([note("z", 26)])
      yield* eventually(() => collection.tanstack.get("a") === undefined)
      expect(texts(yield* collection.toArray)).toEqual(["z:z"])
    }))
  })

  test("shows a write at once and settles it once the shard's answer is applied", async () => {
    const local = projection([note("a", 1)])
    let open!: () => void
    const gate = new Promise<void>((resolve) => void (open = resolve))
    // The shard answers when the gate opens; until then the write is optimistic.
    const submit: JournalCollection.Source<Note, string>["submit"] = (mutations) =>
      Effect.andThen(Effect.promise(() => gate), accepting(local)(mutations))
    await run(Effect.gen(function*() {
      const collection = yield* notes(local, submit)
      yield* collection.preload
      const inserted = yield* collection.insert(note("b", 2))
      expect(Option.isSome(yield* collection.get("b"))).toBe(true)
      expect(yield* collection.isSynced("b")).toBe(false)
      expect(yield* collection.pendingWrites("b")).toHaveLength(1)
      open()
      yield* inserted.persisted
      expect(yield* collection.isSynced("b")).toBe(true)
      expect(yield* collection.pendingWrites("b")).toEqual([])
      expect(local.through()).toBe(1)

      const updated = yield* collection.update("a", (draft) => void (draft.text = "A"))
      yield* updated.persisted
      expect(Option.map(yield* collection.get("a"), (row) => row.text)).toEqual(Option.some("A"))
      const deleted = yield* collection.delete("a")
      yield* deleted.persisted
      expect(yield* collection.get("a")).toEqual(Option.none())
      expect(local.through()).toBe(3)
    }))
  })

  test("settles at once when the collection already holds the answer", async () => {
    const local = projection()
    // The shard's answer is applied and the collection's source has read it before `submit` returns, as for a
    // duplicate whose entry the node pulled earlier.
    const submit: JournalCollection.Source<Note, string>["submit"] = (mutations) =>
      Effect.tap(accepting(local)(mutations), () => Effect.sleep(25))
    await run(Effect.gen(function*() {
      const collection = yield* notes(local, submit)
      yield* collection.preload
      const written = yield* collection.insert(note("x", 1))
      yield* written.persisted
      expect(yield* collection.isSynced("x")).toBe(true)
    }))
  })

  test("rolls a write back when the shard refuses it", async () => {
    const local = projection([note("a", 1)])
    await run(Effect.gen(function*() {
      const collection = yield* notes(local, () => Effect.fail("refused"))
      yield* collection.preload
      const written = yield* collection.insert(note("b", 2))
      const settled = yield* Effect.exit(written.persisted)
      expect(Exit.isFailure(settled)).toBe(true)
      expect(yield* collection.get("b")).toEqual(Option.none())
      expect(local.through()).toBe(0)
    }))
  })

  test("fails preload when the projection dies before its first batch", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      const collection = yield* JournalCollection.make({
        id: id("journal-notes"),
        schema: Note,
        getKey: (row) => row.id,
        source: { batches: Stream.die(new Error("projection unreadable")), submit: () => Effect.succeed(0) }
      })
      return yield* collection.preload
    })))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("LoadFailed")
  })

  describe("what the collection has committed", () => {
    type Batch = JournalCollection.Batch<Note, string>
    /** A source whose batches the test sends and ends. Nothing is sent before the test sends it. */
    const sent = Effect.fnUntraced(function*() {
      const queue = yield* Queue.make<Batch, Cause.Done>()
      const collection = yield* JournalCollection.make({
        id: id("journal-committed"),
        schema: Note,
        getKey: (row) => row.id,
        source: { batches: Stream.fromQueue(queue), submit: () => Effect.succeed(0) }
      })
      const send = (through: number, rows: ReadonlyArray<Note>, snapshot = false) =>
        Queue.offer(queue, { snapshot, through, changes: rows.map((value): Change => ({ type: "insert", value })) })
      return { queue, collection, send }
    })
    const settled = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.exit(effect).pipe(
        Effect.timeoutOption(50),
        Effect.map(Option.map((exit) => Exit.isSuccess(exit) ? "done" : "stopped"))
      )

    test("has committed nothing before the first batch, and the initial sync completes with it", async () => {
      await run(Effect.gen(function*() {
        const { collection, send } = yield* sent()
        collection.tanstack.startSyncImmediate()
        expect(yield* collection.committed).toBeUndefined()
        // Neither the initial sync nor any cursor, however low, is reached before a batch is committed.
        expect(yield* settled(collection.initialSync)).toEqual(Option.none())
        expect(yield* settled(collection.reached(0))).toEqual(Option.none())
        expect(yield* settled(collection.reached(-5))).toEqual(Option.none())
        const initial = yield* Effect.forkChild(collection.initialSync)
        yield* send(7, [note("a", 1), note("b", 2)], true)
        yield* Fiber.join(initial)
        // Whole at that moment: the rows the first batch carried are the collection's, with no further wait.
        expect(texts(yield* collection.toArray)).toEqual(["a:a", "b:b"])
        expect(yield* collection.committed).toBe(7)
        expect(collection.tanstack.status).toBe("ready")
        // An empty first batch completes it as well: a conversation with no rows has synced.
        const empty = yield* sent()
        empty.collection.tanstack.startSyncImmediate()
        yield* empty.send(0, [], true)
        yield* empty.collection.initialSync
        expect(yield* empty.collection.committed).toBe(0)
        expect(yield* empty.collection.toArray).toEqual([])
      }))
    })

    test("reaches a cursor only once the batch that carries it is committed, and at once when it already is", async () => {
      await run(Effect.gen(function*() {
        const { collection, send } = yield* sent()
        yield* send(1, [note("a", 1)], true)
        yield* collection.preload
        yield* collection.reached(1)
        yield* collection.reached(0)
        expect(yield* settled(collection.reached(3))).toEqual(Option.none())
        const third = yield* Effect.forkChild(collection.reached(3))
        const fifth = yield* Effect.forkChild(collection.reached(5))
        yield* send(2, [note("b", 2)])
        yield* collection.reached(2)
        expect(third.pollUnsafe()).toBeUndefined()
        // A batch past the cursor reaches it: the rows it waited for are committed with it.
        yield* send(4, [note("c", 3)])
        yield* Fiber.join(third)
        expect(texts(yield* collection.toArray)).toEqual(["a:a", "b:b", "c:c"])
        expect(yield* collection.committed).toBe(4)
        expect(fifth.pollUnsafe()).toBeUndefined()
        // A batch that changes no row still moves the cursor: an empty sync is a commit too.
        yield* send(5, [])
        yield* Fiber.join(fifth)
        expect(yield* collection.committed).toBe(5)
      }))
    })

    test("a wait that is interrupted waits no longer, and one still waiting when the source stops fails", async () => {
      await run(Effect.gen(function*() {
        const { collection, send, queue } = yield* sent()
        yield* send(1, [], true)
        yield* collection.preload
        const given = yield* Effect.forkChild(collection.reached(2))
        yield* Effect.sleep(5)
        yield* Fiber.interrupt(given)
        const waiting = yield* Effect.forkChild(Effect.flip(collection.reached(9)))
        yield* send(2, [])
        yield* collection.reached(2)
        yield* Queue.end(queue)
        const stopped = yield* Fiber.join(waiting)
        expect(stopped).toBeInstanceOf(JournalCollection.JournalStopped)
        expect(stopped.reason).toBe("ended")
        // The run that stopped keeps what it committed, and fails every later wait the same way.
        expect(yield* collection.committed).toBe(2)
        yield* collection.reached(2)
        expect((yield* Effect.flip(collection.reached(3))).reason).toBe("ended")
      }))
    })

    test("speaks of the run going on: a collection that starts again has committed nothing until its new first batch", async () => {
      const local = projection([note("a", 1)])
      await run(Effect.gen(function*() {
        const collection = yield* notes(local)
        yield* collection.preload
        local.commit([{ type: "insert", value: note("b", 2) }])
        yield* collection.reached(1)
        expect(yield* collection.committed).toBe(1)
        yield* Effect.promise(() => collection.tanstack.cleanup())
        expect((yield* Effect.flip(collection.reached(2))).reason).toBe("closed")
        yield* collection.preload
        yield* collection.initialSync
        // The new run's first batch is the projection's snapshot, at the projection's cursor.
        expect(yield* collection.committed).toBe(1)
        expect(texts(yield* collection.toArray)).toEqual(["a:a", "b:b"])
      }))
    })
  })

  test("unsubscribes from the projection and cleans up when its scope closes", async () => {
    const local = projection([note("a", 1)])
    const [during, after, status] = await Effect.runPromise(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const collection = yield* Scope.provide(notes(local), scope)
      yield* collection.preload
      const during = local.subscribers.size
      yield* Scope.close(scope, Exit.void)
      yield* eventually(() => local.subscribers.size === 0)
      return [during, local.subscribers.size, collection.tanstack.status] as const
    }))
    expect([during, after, status]).toEqual([1, 0, "cleaned-up"])
  })

  // Regressions for the Codex Astra review of W2-C: each test fails on the code the review read.
  describe("review regressions", () => {
    type Batch = JournalCollection.Batch<Note, string>
    /** A source whose batches the test sends, ends, or fails, and whose submits it answers. */
    const controlled = Effect.fnUntraced(function*() {
      const queue = yield* Queue.make<Batch, Cause.Done>()
      yield* Queue.offer(queue, { snapshot: true, through: 0, changes: [] })
      return {
        queue,
        batches: Stream.fromQueue(queue)
      }
    })
    const stoppedReason = (exit: Exit.Exit<unknown, unknown>) => {
      if (Exit.isSuccess(exit)) return "settled"
      // TanStack DB and `persisted` wrap the handler's error; find the `JournalStopped` inside.
      let error: unknown = Cause.squash(exit.cause)
      while (
        !(error instanceof JournalCollection.JournalStopped) && error instanceof Error && error.cause !== undefined
      ) {
        error = error.cause
      }
      return error instanceof JournalCollection.JournalStopped ? error.reason : String(error)
    }
    const journal = (
      batches: Stream.Stream<Batch>,
      submit: JournalCollection.Source<Note, string>["submit"]
    ) =>
      JournalCollection.make({
        id: id("journal-review"),
        schema: Note,
        getKey: (row) => row.id,
        source: { batches, submit }
      })

    test("H1: closing the scope interrupts an in-flight submit and rolls its write back", async () => {
      const result = await Effect.runPromise(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        let interrupted = false
        const local = projection()
        const scope = yield* Scope.make()
        const collection = yield* Scope.provide(
          journal(local.batches, () =>
            Deferred.succeed(started, void 0).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))
            )),
          scope
        )
        yield* collection.preload
        const written = yield* collection.insert(note("b", 2))
        yield* Deferred.await(started)
        yield* Scope.close(scope, Exit.void)
        const settled = yield* Effect.exit(written.persisted).pipe(Effect.timeout(2_000))
        return { reason: stoppedReason(settled), interrupted }
      }))
      expect(result).toEqual({ reason: "closed", interrupted: true })
    })

    test("H1: a write waiting for a cursor rolls back when the stream fails", async () => {
      const reasons = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const source = yield* controlled()
        const collection = yield* journal(source.batches, () => Effect.succeed(5))
        yield* collection.preload
        const waiting = yield* collection.insert(note("a", 1))
        // A batch short of the write's cursor leaves it waiting.
        yield* Queue.offer(source.queue, { snapshot: false, through: 1, changes: [] })
        yield* Queue.failCause(source.queue, Cause.die(new Error("projection unreadable")))
        return [
          stoppedReason(yield* Effect.exit(waiting.persisted).pipe(Effect.timeout(2_000))),
          collection.tanstack.status
        ]
      })))
      expect(reasons).toEqual(["failed", "error"])
    })

    test("H1: writes roll back when the stream ends before their cursor: answered later, or begun after", async () => {
      const reasons = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const source = yield* controlled()
        const answer = yield* Deferred.make<number>()
        const collection = yield* journal(source.batches, () => Deferred.await(answer))
        yield* collection.preload
        const waiting = yield* collection.insert(note("a", 1))
        yield* Queue.end(source.queue)
        yield* Effect.sleep(10)
        yield* Deferred.succeed(answer, 7)
        const first = stoppedReason(yield* Effect.exit(waiting.persisted).pipe(Effect.timeout(2_000)))
        const later = yield* collection.insert(note("b", 2))
        return [first, stoppedReason(yield* Effect.exit(later.persisted).pipe(Effect.timeout(2_000)))]
      })))
      expect(reasons).toEqual(["ended", "ended"])
    })

    test("starts a fresh run after a cleanup and restart, and settles writes on it", async () => {
      const local = projection()
      const reason = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const collection = yield* notes(local)
        yield* collection.preload
        yield* Effect.promise(() => collection.tanstack.cleanup())
        yield* collection.preload
        const written = yield* collection.insert(note("b", 2))
        return stoppedReason(yield* Effect.exit(written.persisted).pipe(Effect.timeout(2_000)))
      })))
      expect(reason).toBe("settled")
    })

    test("M4: closing the scope waits for the source's finalizer to unsubscribe", async () => {
      const local = projection([note("a", 1)])
      let released = false
      const slow: Stream.Stream<Batch> = Stream.ensuring(
        local.batches,
        Effect.sleep(50).pipe(Effect.andThen(Effect.sync(() => void (released = true))))
      )
      const [during, after] = await Effect.runPromise(Effect.gen(function*() {
        const scope = yield* Scope.make()
        const collection = yield* Scope.provide(journal(slow, accepting(local)), scope)
        yield* collection.preload
        const during = released
        yield* Scope.close(scope, Exit.void)
        return [during, { released, subscribers: local.subscribers.size, status: collection.tanstack.status }] as const
      }))
      expect(during).toBe(false)
      expect(after).toEqual({ released: true, subscribers: 0, status: "cleaned-up" })
    })
  })
})
