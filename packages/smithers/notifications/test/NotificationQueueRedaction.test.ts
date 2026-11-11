import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationEvent from "../src/NotificationEvent.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

// The journal redacts every admission record on write: a credential-named key
// becomes `[REDACTED]` and every other string runs through the textual rules.
// These cases pin that the queue never treats that copy as the caller's value.

const steer = (body: string, attribution: Readonly<Record<string, string>> = {}): Notification => ({
  _tag: "human-steer",
  delivery: "steer",
  id: "steer",
  targetLineageId: "run",
  provenance: {
    sourceRunId: "operator",
    sourceLineageId: "operator/root",
    sourceTurn: 0,
    sourceActor: "human:will",
    attribution: { login: "will", ...attribution }
  },
  payload: { body }
})

const systemEvent = (id: string, coalescingKey: string): Notification => ({
  _tag: "system-event",
  delivery: "queue",
  id,
  targetLineageId: "run",
  coalescingKey,
  provenance: { sourceRunId: "ci", sourceLineageId: "ci", sourceTurn: 0, sourceActor: "system:ci" },
  payload: { status: "failed" }
})

const boundary = { runId: "run", targetLineageId: "run", boundary: "turn", wouldIdle: true }
const runId = JournalEvent.RunId.make("run")

// An admission written before the identity fingerprint existed.
const legacyRow = new JournalEvent.Input({
  runId,
  sourceId: NotificationEvent.admissionSourceId("steer"),
  sourceSeq: JournalEvent.SourceSeq.make(1),
  dedupe: "identity",
  eventType: NotificationEvent.AdmittedEventType,
  payload: { notification: steer("legacy"), decision: "admitted", version: 1 }
})

const withQueue = <A, E>(
  journal: Journal.Service,
  effect: Effect.Effect<A, E, NotificationQueue.NotificationQueue>
) => effect.pipe(Effect.provide(NotificationQueue.layer.pipe(Layer.provide(Layer.succeed(Journal.Journal, journal)))))

const run = <A, E>(
  effect: Effect.Effect<A, E, Journal.Journal>,
  options?: TestJournal.TestJournalOptions
) => Effect.runPromise(effect.pipe(Effect.provide(TestJournal.layer(options)), Effect.scoped))

describe("notification envelopes the journal redacts", () => {
  it("edits a steer whose attribution the journal redacts, before and after a restart", async () => {
    const attributed = (body: string) => steer(body, { session: "abc123" })
    await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      yield* withQueue(
        journal,
        Effect.gen(function*() {
          const queue = yield* NotificationQueue.NotificationQueue
          yield* queue.admit("run", attributed("first"), 1)
          expect(JSON.stringify((yield* queue.pending("run"))[0])).not.toContain("abc123")
          expect(yield* queue.admit("run", attributed("second"), 2)).toMatchObject({ duplicate: false })
        })
      )
      yield* withQueue(
        journal,
        Effect.gen(function*() {
          const queue = yield* NotificationQueue.NotificationQueue
          expect(yield* queue.admit("run", attributed("third"), 3)).toMatchObject({ duplicate: false })
          // The redacted copy hides the session, so only the identity
          // fingerprint can tell a changed one apart.
          const otherSession = steer("fourth", { session: "def456" })
          const refused = yield* queue.admit("run", otherSession, 4).pipe(Effect.flip)
          expect(refused).toMatchObject({ code: "notification_id_reused", notificationId: "steer" })
          const delivered = (yield* queue.drain(boundary)).notifications
          expect(delivered.map((notification) => notification.payload)).toEqual([{ body: "third" }])
        })
      )
    }))
  })

  it("edits a row journaled before the identity fingerprint by comparing its stored envelope", async () => {
    await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      yield* journal.emitDurableUnfenced(legacyRow)
      yield* withQueue(
        journal,
        Effect.gen(function*() {
          const queue = yield* NotificationQueue.NotificationQueue
          const owner = { ...steer("forged"), targetLineageId: "run/other" }
          expect((yield* queue.admit("run", owner, 2).pipe(Effect.flip)).code).toBe("notification_id_reused")
          expect(yield* queue.admit("run", steer("edited"), 2)).toMatchObject({ duplicate: false })
          expect(yield* queue.pending("run")).toEqual([steer("edited")])
        })
      )
    }))
  })

  it("refuses an edit of a legacy row whose stored envelope is unreadable", async () => {
    let hideExact = false
    await run(Effect.gen(function*() {
      const underlying = yield* Journal.Journal
      yield* underlying.emitDurableUnfenced(legacyRow)
      const journal = Journal.make({
        ...underlying,
        entries: (options) =>
          Effect.map(
            underlying.entries(options),
            (page) => hideExact && options.limit === 1 ? { entries: [], hasMore: false } : page
          )
      })
      yield* withQueue(
        journal,
        Effect.gen(function*() {
          const queue = yield* NotificationQueue.NotificationQueue
          hideExact = true
          expect(yield* queue.admit("run", steer("edited"), 2).pipe(Effect.flip)).toMatchObject({
            code: "notification_unavailable",
            notificationId: "steer"
          })
          hideExact = false
          expect(yield* queue.pending("run")).toEqual([steer("legacy")])
        })
      )
    }))
  })

  it.each(
    [
      { path: "id", notification: { ...steer("body"), id: "password=hunter2hunter2" } },
      { path: "id", notification: { ...steer("body"), id: "Bearer abcdefghijklmnopqrstuvwxyz012345" } },
      { path: "targetLineageId", notification: { ...steer("body"), targetLineageId: "token=abcdefghijklmnop" } },
      { path: "coalescingKey", notification: systemEvent("ci", "token=abcdefghijklmnop") }
    ] satisfies ReadonlyArray<{ readonly path: string; readonly notification: Notification }>
  )(
    "refuses an admission whose $path the journal rewrites, and journals nothing",
    async ({ notification, path }) => {
      await run(Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            const refused = yield* queue.admit("run", notification).pipe(Effect.flip)
            expect(refused).toMatchObject({ code: "notification_invalid", path })
            expect(refused).not.toHaveProperty("notificationId")
            expect(refused.message).not.toContain("abcdefghijklmnop")
            expect(refused.message).not.toContain("hunter2")
            expect(yield* queue.pending("run")).toEqual([])
          })
        )
        expect((yield* journal.entries({ runId, limit: 10 })).entries).toEqual([])
      }))
    }
  )

  it("refuses an admission the configured redactor stores in a form the queue cannot read", async () => {
    const redact = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value).replaceAll("\"human-steer\"", "\"rewritten\""))
    await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            const refused = yield* queue.admit("run", steer("body")).pipe(Effect.flip)
            expect(refused).toMatchObject({ code: "notification_invalid" })
            expect(refused).not.toHaveProperty("path")
          })
        )
        expect((yield* journal.entries({ runId, limit: 10 })).entries).toEqual([])
      }),
      { redact }
    )
  })
})
