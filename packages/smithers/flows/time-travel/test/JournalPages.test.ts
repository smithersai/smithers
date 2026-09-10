/**
 * The shared journal pager fails closed on the two malformed page shapes and
 * honors a caller's early stop.
 *
 * Every time-travel read used to carry its own copy of this loop, and the
 * copies disagreed on what an empty page that still claims more means. These
 * cases pin the one policy the copies now share.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as JournalPages from "../src/internal/JournalPages.ts"

const entry = (seq: number): JournalEvent.Entry =>
  ({
    runId: "run",
    seq,
    eventId: `e${seq}`,
    sourceId: "test",
    sourceSeq: seq,
    emittedAtMs: 0,
    eventType: "noise",
    payload: {},
    meta: {}
  }) as unknown as JournalEvent.Entry

const options = { runId: "run", pageSize: 1, label: "journal probe", readFailure: "could not read run" } as const

describe("JournalPages.forEachPage", () => {
  it.effect("refuses an empty page that claims more instead of ending the read", () =>
    Effect.gen(function*() {
      let pages = 0
      const journal = Journal.makeNoop({
        entries: () =>
          Effect.sync(() => {
            pages += 1
            return { entries: [], hasMore: true }
          })
      })
      const seen: Array<number> = []

      const failure = yield* Effect.flip(
        JournalPages.forEachPage(journal, options, (entries) =>
          Effect.sync(() => {
            for (const item of entries) seen.push(item.seq)
          }))
      )

      expect(pages).toBe(1)
      expect(seen).toEqual([])
      expect(failure).toMatchObject({
        code: "invalid",
        message: "journal probe returned an empty continuation page for run"
      })
    }))

  it.effect("refuses a page whose tail does not move the cursor instead of spinning", () =>
    Effect.gen(function*() {
      let pages = 0
      const journal = Journal.makeNoop({
        entries: () =>
          Effect.sync(() => {
            pages += 1
            return { entries: [entry(1)], hasMore: true }
          })
      })

      const failure = yield* Effect.flip(
        JournalPages.forEachPage(journal, { ...options, after: 1 }, () => Effect.void)
      )

      expect(pages).toBe(1)
      expect(failure).toMatchObject({
        code: "invalid",
        message: "journal probe pagination did not advance for run"
      })
    }))

  it.effect("advances the cursor to the page's highest seq and ends on the last page", () =>
    Effect.gen(function*() {
      const cursors: Array<number | undefined> = []
      const journal = Journal.makeNoop({
        entries: ({ after }) =>
          Effect.sync(() => {
            cursors.push(after)
            // Out of order within the page: the cursor is the max, not the last.
            return after === undefined
              ? { entries: [entry(2), entry(1)], hasMore: true }
              : { entries: [entry(3)], hasMore: false }
          })
      })
      const seen: Array<number> = []

      yield* JournalPages.forEachPage(journal, { ...options, pageSize: 2 }, (entries) =>
        Effect.sync(() => {
          for (const item of entries) seen.push(item.seq)
        }))

      expect(cursors).toEqual([undefined, 2])
      expect(seen).toEqual([2, 1, 3])
    }))

  it.effect("stops when the page callback says so, before reading the next page", () =>
    Effect.gen(function*() {
      let pages = 0
      const journal = Journal.makeNoop({
        entries: () =>
          Effect.sync(() => {
            pages += 1
            return { entries: [entry(pages)], hasMore: true }
          })
      })

      yield* JournalPages.forEachPage(journal, options, (entries) =>
        Effect.succeed(entries[0]?.seq === 2 ? JournalPages.Stop : undefined))

      expect(pages).toBe(2)
    }))

  it.effect("reports a failed journal read under the caller's message", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        JournalPages.forEachPage(Journal.makeNoop(), options, () => Effect.void)
      )

      expect(failure).toMatchObject({ code: "unknown", message: "could not read run" })
    }))
})
