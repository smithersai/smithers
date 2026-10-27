import { describe, expect, it } from "@effect/vitest"
import * as Journal from "@smthrs/journal/Journal"
import type { Entry, RunId, Seq, SourceId, SourceSeq } from "@smthrs/journal/JournalEvent"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Replay from "../src/internal/Replay.ts"
import { journalOf } from "./MemoryHarness.ts"

const entry = (seq: number, payload: string, cacheKey?: string): Entry => ({
  runId: "run" as RunId,
  seq: seq as Seq,
  eventId: `event-${seq}`,
  sourceId: "replay-test" as SourceId,
  sourceSeq: seq as SourceSeq,
  emittedAtMs: seq,
  eventType: "step.completed",
  payload,
  meta: {
    lineageId: "run/root",
    ...(cacheKey === undefined ? {} : { cacheKey })
  }
})

describe("Replay", () => {
  it.effect("re-derives an identical projection from sealed evidence without dispatching", () =>
    Effect.gen(function*() {
      const entries = [entry(0, "first"), entry(1, "second", "sealed-key"), entry(2, "after-frame")]
      const before = structuredClone(entries)
      let dispatcherCalls = 0
      const dispatcher = (): void => {
        dispatcherCalls += 1
      }
      const journal = journalOf(entries)
      const cache = CacheStore.makeNoop({
        get: (key) =>
          Effect.succeed(
            key === "sealed-key"
              ? Option.some({
                keyDigest: key,
                result: "sealed-result",
                meta: {},
                createdAtMs: 1,
                recordedRunId: "run",
                recordedEventSeq: 1
              })
              : Option.none()
          )
      })
      const replay = Replay.rederive(
        { lineageId: "run/root", seq: 1 },
        {
          initial: [] as Array<string>,
          reduce: (state, current, sealed) => [...state, `${String(current.payload)}:${String(sealed)}`]
        },
        { runId: "run", pageSize: 10 }
      ).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, journal)),
        Effect.provide(Layer.succeed(CacheStore.CacheStore, cache))
      )

      const first = yield* replay
      const second = yield* replay

      expect(first).toEqual(["first:undefined", "second:sealed-result"])
      expect(second).toEqual(first)
      expect(dispatcherCalls).toBe(0)
      expect(entries).toEqual(before)
      expect(dispatcher).toBeTypeOf("function")
    }))

  it.effect("pages through the journal and stops once the last page is consumed", () =>
    Effect.gen(function*() {
      const entries = [entry(0, "a"), entry(1, "b"), entry(2, "c"), entry(3, "d")]
      const pageSizes: Array<number | undefined> = []
      const journal = Journal.makeNoop({
        entries: ({ after, limit }) =>
          Effect.sync(() => {
            pageSizes.push(limit)
            const remaining = entries.filter((item) => item.seq > (after ?? -1))
            const page = remaining.slice(0, limit)
            return { entries: page, hasMore: remaining.length > page.length }
          })
      })

      const state = yield* (
        Replay.rederive(
          { lineageId: "run/root", seq: 3 },
          { initial: [] as Array<string>, reduce: (acc, current) => [...acc, String(current.payload)] },
          { runId: "run", pageSize: 2 }
        ).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop())
        )
      )

      expect(state).toEqual(["a", "b", "c", "d"])
      expect(pageSizes).toEqual([2, 2])
    }))

  it.effect("defaults the page size when the caller supplies none", () =>
    Effect.gen(function*() {
      const limits: Array<number | undefined> = []
      const journal = Journal.makeNoop({
        entries: ({ limit }) =>
          Effect.sync(() => {
            limits.push(limit)
            return { entries: [entry(0, "only")], hasMore: false }
          })
      })

      yield* (
        Replay.rederive(
          { lineageId: "run/root", seq: 0 },
          { initial: 0, reduce: (count: number) => count + 1 },
          { runId: "run" }
        ).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop())
        )
      )

      expect(limits).toEqual([100])
    }))

  it.effect("skips entries from a sibling lineage and rejects a frame that is absent", () =>
    Effect.gen(function*() {
      const sibling: Entry = { ...entry(0, "sibling"), meta: { lineageId: "run/other" } }
      const journal = journalOf([sibling])

      const failure = yield* (
        Effect.flip(
          Replay.rederive(
            { lineageId: "run/root", seq: 5 },
            { initial: [] as Array<string>, reduce: (acc, current) => [...acc, String(current.payload)] },
            { runId: "run" }
          ).pipe(
            Effect.provide(Layer.succeed(Journal.Journal, journal)),
            Effect.provide(CacheStore.layerNoop())
          )
        )
      )

      expect(failure).toMatchObject({
        code: "not_found",
        message: "lineage run/root is not present in run"
      })
    }))

  it.effect("fails when the journal cannot be read", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.flip(
          Replay.rederive(
            { lineageId: "run/root", seq: 1 },
            { initial: 0, reduce: (count: number) => count + 1 },
            { runId: "run" }
          ).pipe(
            Effect.provide(Journal.layerNoop()),
            Effect.provide(CacheStore.layerNoop())
          )
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "could not read journal" })
    }))

  it.effect("fails when a sealed result cannot be read rather than replaying without it", () =>
    Effect.gen(function*() {
      const journal = journalOf([entry(0, "first", "sealed-key")])

      const failure = yield* (
        Effect.flip(
          Replay.rederive(
            { lineageId: "run/root", seq: 1 },
            { initial: 0, reduce: (count: number) => count + 1 },
            { runId: "run" }
          ).pipe(
            Effect.provide(Layer.succeed(Journal.Journal, journal)),
            Effect.provide(CacheStore.layerNoop())
          )
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "could not read sealed result" })
    }))

  it.effect("passes an absent sealed cache entry to the projection as undefined", () =>
    Effect.gen(function*() {
      const journal = journalOf([entry(0, "first", "missing")])

      const values = yield* (
        Replay.rederive(
          { lineageId: "run/root", seq: 0 },
          {
            initial: [] as Array<unknown>,
            reduce: (state, _entry, sealed) => [...state, sealed]
          },
          { runId: "run" }
        ).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) }))
        )
      )

      expect(values).toEqual([undefined])
    }))

  it.effect("handles malformed additive metadata without treating it as lineage or cache evidence", () =>
    Effect.gen(function*() {
      const malformed = [
        { ...entry(0, "null"), meta: null },
        { ...entry(1, "number"), meta: 1 },
        { ...entry(2, "bad-lineage"), meta: { lineageId: 1 } },
        { ...entry(3, "bad-cache"), meta: { lineageId: "run/root", cacheKey: 1 } }
      ] as ReadonlyArray<Entry>
      const journal = journalOf(malformed)

      const values = yield* (
        Replay.rederive(
          { lineageId: "run/root", seq: 3 },
          {
            initial: [] as Array<string>,
            reduce: (state, current, sealed) => [...state, `${String(current.payload)}:${String(sealed)}`]
          },
          { runId: "run" }
        ).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop())
        )
      )

      expect(values).toEqual([
        "null:undefined",
        "number:undefined",
        "bad-lineage:undefined",
        "bad-cache:undefined"
      ])
    }))

  it.effect("terminates a malformed empty continuation page instead of spinning", () =>
    Effect.gen(function*() {
      let pages = 0
      const journal = Journal.makeNoop({
        entries: () =>
          Effect.sync(() => {
            pages += 1
            return { entries: [], hasMore: true }
          })
      })

      const failure = yield* (
        Effect.flip(
          Replay.rederive(
            { lineageId: "run/root", seq: 0 },
            { initial: 0, reduce: (count: number) => count + 1 },
            { runId: "run" }
          ).pipe(
            Effect.provide(Layer.succeed(Journal.Journal, journal)),
            Effect.provide(CacheStore.layerNoop())
          )
        )
      )

      expect(pages).toBe(1)
      expect(failure).toMatchObject({ code: "invalid" })
    }))

  it.effect("fails a repeated non-empty continuation page instead of spinning", () =>
    Effect.gen(function*() {
      let pages = 0
      const repeated = entry(0, "same")
      const journal = Journal.makeNoop({
        entries: () =>
          Effect.sync(() => {
            pages += 1
            return { entries: [repeated], hasMore: true }
          })
      })
      const failure = yield* Effect.flip(
        Replay.rederive(
          { lineageId: "run/root", seq: 0 },
          { initial: 0, reduce: (count: number) => count + 1 },
          { runId: "run" }
        ).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop())
        )
      )

      expect(pages).toBe(2)
      expect(failure).toMatchObject({ code: "invalid" })
    }))

  it.effect("preserves a projection defect without misclassifying it as a persistence failure", () =>
    Effect.gen(function*() {
      const journal = journalOf([entry(0, "first")])

      const exit = yield* (
        Effect.exit(
          Replay.rederive(
            { lineageId: "run/root", seq: 0 },
            {
              initial: 0,
              reduce: () => {
                throw new Error("projection invariant failed")
              }
            },
            { runId: "run" }
          ).pipe(
            Effect.provide(Layer.succeed(Journal.Journal, journal)),
            Effect.provide(CacheStore.layerNoop())
          )
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const defect = Cause.findDefect(exit.cause)
        expect(Result.isSuccess(defect) ? defect.success : undefined).toMatchObject({
          message: "projection invariant failed"
        })
      }
    }))
})

/**
 * The fold streams and stops at the frame, so what it reads is bounded by the
 * frame and by `maxEntries`, never by the run's whole history.
 */
describe("Replay bounds", () => {
  const fold = {
    initial: [] as Array<string>,
    reduce: (acc: Array<string>, current: Entry) => [...acc, String(current.payload)]
  }

  const pagingJournal = (entries: ReadonlyArray<Entry>, requests: Array<number | undefined>) =>
    Journal.makeNoop({
      entries: ({ after, limit }) =>
        Effect.sync(() => {
          requests.push(after)
          const remaining = entries.filter((item) => item.seq > (after ?? -1))
          const page = remaining.slice(0, limit)
          return { entries: page, hasMore: remaining.length > page.length }
        })
    })

  it.effect("stops reading once the first record past the frame arrives", () =>
    Effect.gen(function*() {
      const requests: Array<number | undefined> = []
      const entries = [entry(0, "a"), entry(1, "b"), entry(2, "c"), entry(3, "d"), entry(4, "e"), entry(5, "f")]

      const state = yield* Replay.rederive({ lineageId: "run/root", seq: 1 }, fold, { runId: "run", pageSize: 2 }).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, pagingJournal(entries, requests))),
        Effect.provide(CacheStore.layerNoop())
      )

      expect(state).toEqual(["a", "b"])
      // The page holding seq 2 proves the frame is behind; the third page is
      // never asked for.
      expect(requests).toEqual([undefined, 1])
    }))

  it.effect("folds up to maxEntries at or below the frame and refuses one more", () =>
    Effect.gen(function*() {
      const entries = [entry(0, "a"), entry(1, "b"), entry(2, "c"), entry(3, "past-the-frame")]
      const replay = (maxEntries: number) =>
        Replay.rederive({ lineageId: "run/root", seq: 2 }, fold, { runId: "run", maxEntries }).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, pagingJournal(entries, []))),
          Effect.provide(CacheStore.layerNoop())
        )

      expect(yield* replay(4)).toEqual(["a", "b", "c"])
      // Exactly at the cap: the record past the frame is not read against it.
      expect(yield* replay(3)).toEqual(["a", "b", "c"])
      expect(yield* Effect.flip(replay(2))).toMatchObject({
        code: "limit_exceeded",
        message: "replay of run would read more than 2 journal entries; raise maxHistoryEntries to allow it"
      })
    }))

  it.effect("skips a record a later page repeats", () =>
    Effect.gen(function*() {
      const pages = [
        { entries: [entry(0, "a"), entry(1, "b")], hasMore: true },
        { entries: [entry(1, "b"), entry(2, "c")], hasMore: false }
      ]
      let served = 0
      const journal = Journal.makeNoop({ entries: () => Effect.sync(() => pages[served++]!) })

      const state = yield* Replay.rederive({ lineageId: "run/root", seq: 2 }, fold, { runId: "run" }).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, journal)),
        Effect.provide(CacheStore.layerNoop())
      )

      expect(state).toEqual(["a", "b", "c"])
    }))

  it.effect("refuses two different records at one coordinate in either order", () =>
    Effect.gen(function*() {
      // A repeat of the SAME record is a duplicate; a different event at a
      // folded coordinate is corrupt evidence. Keeping whichever one sorted
      // first would make the projection depend on how the page was ordered.
      const rival = { ...entry(1, "rival"), eventId: "event-1-rival" }
      for (const entries of [[entry(0, "a"), entry(1, "b"), rival], [entry(0, "a"), rival, entry(1, "b")]]) {
        const failure = yield* Effect.flip(
          Replay.rederive({ lineageId: "run/root", seq: 5 }, fold, { runId: "run" }).pipe(
            Effect.provide(Layer.succeed(Journal.Journal, journalOf(entries))),
            Effect.provide(CacheStore.layerNoop())
          )
        )
        expect(failure).toMatchObject({ code: "invalid" })
        expect(failure.message).toContain("seq 1")
      }
    }))

  it.effect("refuses a later page that reaches below a coordinate the fold has passed", () =>
    Effect.gen(function*() {
      // Sequence order is the journal contract across pages; a page that
      // introduces seq 1 after seq 2 was folded is corrupt evidence, not a
      // record to slot in quietly.
      const pages = [
        { entries: [entry(0, "a"), entry(2, "c")], hasMore: true },
        { entries: [entry(1, "b"), entry(3, "d")], hasMore: false }
      ]
      let served = 0
      const journal = Journal.makeNoop({ entries: () => Effect.sync(() => pages[served++]!) })

      const failure = yield* Effect.flip(
        Replay.rederive({ lineageId: "run/root", seq: 5 }, fold, { runId: "run" }).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop())
        )
      )

      expect(failure).toMatchObject({
        code: "invalid",
        message: "journal replay returned seq 1 after seq 2 for run"
      })
    }))
})
