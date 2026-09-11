/**
 * Multi-subscriber consistency and retained-state budgets.
 *
 * Every other sync test collects a handful of frames from one subscriber and
 * terminates immediately, so per-subscriber state that is never released — the
 * unbounded in-process-index class that has already produced two findings —
 * leaves the whole suite green. These tests observe the release side directly:
 * how many journal streams stay open after their subscriptions end, and how
 * much heap a long fan-out soak retains.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestEntry from "./fixtures/entry.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (id: string, sequence: number) =>
  TestEntry.entry(id, sequence, { payload: { index: sequence, text: "x".repeat(256) } })

interface Tracker {
  open: number
  peak: number
  opened: number
}

/**
 * A journal whose per-run reads report when they are open, so both shapes of
 * per-subscription state are observable: the run streams a run-scoped
 * subscription attaches, and the paged reads a workspace subscription's tail
 * keeps open. Both are what the fan-out bound bounds. The tracked read yields
 * once before it answers so concurrent reads of one round genuinely overlap;
 * a read that resolved synchronously would report a peak of one however wide
 * the fan-out was.
 */
const trackedJournal = (byRun: Record<string, ReadonlyArray<JournalEvent.Entry>>, tracker: Tracker) => {
  const opened = Effect.sync(() => {
    tracker.open += 1
    tracker.opened += 1
    tracker.peak = Math.max(tracker.peak, tracker.open)
  })
  const closed = Effect.sync(() => {
    tracker.open -= 1
  })
  return Journal.layerNoop({
    entries: ({ after, limit, runId: id }: any) =>
      Effect.gen(function*() {
        yield* opened
        yield* Effect.yieldNow
        const all = (byRun[id] ?? []).filter((value) => after === undefined || value.seq > after)
        const page = all.slice(0, limit)
        return { entries: page, hasMore: page.length < all.length }
      }).pipe(Effect.ensuring(closed)),
    stream: ({ afterSequence, runId: id }: any) =>
      Stream.fromIterable(
        (byRun[id] ?? []).filter((value) => afterSequence === undefined || value.seq > afterSequence)
      ).pipe(Stream.onStart(opened), Stream.ensuring(closed))
  } as any)
}

const workspace = (runs: number, perRun: number) => {
  const byRun: Record<string, ReadonlyArray<JournalEvent.Entry>> = {}
  const ids: Array<JournalEvent.RunId> = []
  for (let run = 0; run < runs; run++) {
    const id = `run-${run}`
    byRun[id] = Array.from({ length: perRun }, (_, index) => entry(id, index))
    ids.push(runId(id))
  }
  return { byRun, ids }
}

// Every soak is bounded by cycle count; a wall-clock limit only measures
// machine load, which the package-wide `testTimeout` budgets for.
describe("SyncServer fan-out budgets", () => {
  it.effect("delivers the identical frame sequence to every concurrent subscriber", () =>
    Effect.gen(function*() {
      const { byRun, ids } = workspace(3, 4)
      const tracker: Tracker = { open: 0, opened: 0, peak: 0 }
      const collected = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* Effect.all(
            Array.from({ length: 5 }, () =>
              Stream.runCollect(
                server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 12 })
              )),
            { concurrency: "unbounded" }
          )
        }).pipe(
          Effect.provide(Layer.mergeAll(
            trackedJournal(byRun, tracker),
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("soak-suite")
          )),
          Effect.scoped
        )
      )

      const shapes = collected.map((frames) =>
        Array.from(frames)
          .map((frame) => frame._tag === "Entries" ? `${frame.runId}:${frame.toSeq}` : frame._tag)
          .sort()
      )
      // Every subscriber sees the whole workspace, and sees exactly the same
      // thing: no subscriber may be starved or served a divergent view.
      expect(shapes[0]).toHaveLength(12)
      for (const shape of shapes) {
        expect(shape).toEqual(shapes[0])
      }
      // Five subscribers really did hold five independent fan-outs open.
      expect(tracker.peak).toBeGreaterThanOrEqual(5)
    }))

  it.effect("releases every per-subscriber journal stream when its subscription ends", () =>
    Effect.gen(function*() {
      const { byRun, ids } = workspace(4, 3)
      const tracker: Tracker = { open: 0, opened: 0, peak: 0 }
      yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          // Two hundred subscribe/complete cycles: any per-subscription state
          // that is never released shows up as a monotonically rising `open`.
          for (let cycle = 0; cycle < 200; cycle++) {
            yield* Stream.runDrain(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 6 })
            )
          }
        }).pipe(
          Effect.provide(Layer.mergeAll(
            trackedJournal(byRun, tracker),
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("soak-suite")
          )),
          Effect.scoped
        )
      )

      expect(tracker.opened).toBeGreaterThanOrEqual(200)
      expect(tracker.open).toBe(0)
      expect(tracker.peak).toBeLessThanOrEqual(2 * ids.length)
    }))

  it.effect("bounds concurrently open run streams when a subscriber stalls", () =>
    Effect.gen(function*() {
      // A thousand-run workspace is the shape that made the unbounded fan-out
      // visible: `Stream.flatMap(..., { concurrency: "unbounded" })` attaches a
      // journal stream per run the moment a subscription starts, so one
      // follower costs one open stream per run in the workspace regardless of
      // how fast it reads. The bound is what keeps a slow follower from
      // holding the whole workspace open at once.
      const { byRun, ids } = workspace(1_000, 1)
      const tracker: Tracker = { open: 0, opened: 0, peak: 0 }
      const concurrency = 8
      const release = yield* Deferred.make<void>()
      const stalled = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ concurrency })
          // The permanently slow subscriber: it accepts its first frame and
          // then never pulls again until the case releases it.
          const slow = yield* Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1_000 }).pipe(
              Stream.tap(() => Deferred.await(release))
            )
          ).pipe(Effect.forkChild)
          // A second follower drains the same workspace to completion, so the
          // fan-out is known to have run in full before the peak is read.
          yield* Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1_000 })
          )
          const peakWhileStalled = tracker.peak
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(slow)
          return peakWhileStalled
        }).pipe(
          Effect.provide(Layer.mergeAll(
            trackedJournal(byRun, tracker),
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("soak-suite")
          )),
          Effect.scoped
        )
      )

      // Two subscribers, each bounded by the configured concurrency. Unbounded
      // fan-out puts this in the thousands.
      expect(stalled).toBeLessThanOrEqual(2 * concurrency)
      expect(tracker.opened).toBeGreaterThanOrEqual(2 * ids.length)
      expect(tracker.open).toBe(0)
    }))

  it.effect("defaults the fan-out bound without an explicit policy", () =>
    Effect.gen(function*() {
      const { byRun, ids } = workspace(SyncServer.defaultConcurrency * 2, 1)
      const tracker: Tracker = { open: 0, opened: 0, peak: 0 }
      yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          yield* Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: ids.length })
          )
        }).pipe(
          Effect.provide(Layer.mergeAll(
            trackedJournal(byRun, tracker),
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("soak-suite")
          )),
          Effect.scoped
        )
      )

      expect(tracker.peak).toBeLessThanOrEqual(SyncServer.defaultConcurrency)
      expect(tracker.opened).toBe(ids.length)
    }))

  it.effect("keeps retained heap bounded across a subscriber soak", () =>
    Effect.gen(function*() {
      const { byRun, ids } = workspace(4, 25)
      const tracker: Tracker = { open: 0, opened: 0, peak: 0 }
      const layers = Layer.mergeAll(
        trackedJournal(byRun, tracker),
        RunCatalog.layerStatic(ids),
        SyncPrincipal.layerWorkspace("soak-suite")
      )
      const soak = (cycles: number) =>
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          for (let cycle = 0; cycle < cycles; cycle++) {
            yield* Effect.all(
              Array.from({ length: 5 }, () =>
                Stream.runDrain(
                  server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 40 })
                )),
              { concurrency: "unbounded" }
            )
          }
        }).pipe(Effect.provide(layers), Effect.scoped)

      // Warm up first so the measurement excludes one-time allocation.
      yield* (soak(20))
      const gc = (globalThis as { gc?: () => void }).gc
      if (gc === undefined) {
        // Without a real collection on both sides the delta measures allocator
        // noise, not retention; refuse rather than flake.
        throw new Error(
          "ServerSoak needs --expose-gc; run through packages/smithers/flows/sync's vitest config, which sets it"
        )
      }
      gc()
      const before = process.memoryUsage().heapUsed
      yield* (soak(200))
      gc()
      const after = process.memoryUsage().heapUsed

      // 200 cycles x 5 subscribers x 4 runs x 25 entries: per-subscriber state
      // that is retained rather than released grows this by tens of megabytes.
      // The budget is deliberately loose — it fails on a leak, not on noise.
      expect(after - before).toBeLessThan(64 * 1024 * 1024)
      expect(tracker.open).toBe(0)
    }))
})
