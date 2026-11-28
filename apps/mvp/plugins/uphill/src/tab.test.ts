import { Host } from "@smthrs/plugin"
import { Uphill } from "@smthrs/rpc"
import { Deferred, Effect, Queue, Stream } from "effect"
import { describe, expect, test } from "vitest"
import type { FeedDocument } from "./model"
import { hrefOf, make, type PluginHostShape, tab, VIEW } from "./tab"

const REPO = { owner: "Acme", name: "Widgets" }

const CANONICAL_DOC: FeedDocument = {
  id: "1",
  repo: "acme/widgets",
  name: "uphill",
  updatedAt: "2026-11-26T18:00:00Z",
  body: {
    commit: "deadbeef",
    branch: "main",
    report: {
      categories: [
        { name: "footprint", title: "Footprint", score: 80, metrics: [] },
        { name: "speed", title: "Speed", score: 96, metrics: [] },
      ],
      opportunities: [
        { category: "footprint", metric: "bundle", value: 9_000, target: 5_000, gain: 12 },
      ],
    },
  },
}

const PREVIEW_DOC = (score: number, commit = "1dd29e1c4a0f8b2d"): FeedDocument => ({
  id: "acme/widgets:uphill/untrusted-roninjin10",
  repo: "acme/widgets",
  name: "uphill/untrusted-roninjin10",
  visibility: "public",
  updatedAt: "2026-11-27T18:00:00Z",
  body: {
    commit,
    branch: "pr-2",
    provenance: {
      trust: "untrusted_contributor",
      gateEligible: false,
      cacheWriteAllowed: false,
      actor: "roninjin10",
      runner: "Community runner (roninjin10)",
    },
    report: {
      categories: [{ id: "correctness", title: "Correctness", score, metrics: [] }],
      opportunities: [],
    },
  },
})

const HISTORY_DOC: FeedDocument = {
  id: "acme/widgets:uphill/history",
  repo: "acme/widgets",
  name: "uphill/history",
  visibility: "public",
  updatedAt: "2026-11-27T18:00:00Z",
  body: {
    history: [
      { commit: "aaa1111", overall: 75, scores: { footprint: 75 } },
      { commit: "bbb2222", overall: 88, scores: { footprint: 88 } },
    ],
  },
}

interface FeedChannel {
  rows: ReadonlyArray<FeedDocument>
  readonly listeners: Set<() => void>
  opens: number
  closes: number
}

const harness = (options: {
  readonly refuse?: boolean
  readonly deferredIndex?: Deferred.Deferred<Host.Live<FeedDocument>, Host.PluginRefused>
  readonly initialIndex?: ReadonlyArray<FeedDocument>
  readonly refuseFeeds?: ReadonlySet<string>
  readonly deferredFeeds?: ReadonlyMap<string, Deferred.Deferred<Host.Live<FeedDocument>, Host.PluginRefused>>
} = {}) =>
  Effect.gen(function* () {
    let indexRows: ReadonlyArray<FeedDocument> = options.initialIndex ?? [CANONICAL_DOC]
    const indexListeners = new Set<() => void>()
    const channels = new Map<string, FeedChannel>()
    const queriedFeeds: Array<string> = []
    const opened: Array<unknown> = []
    const queue = yield* Queue.unbounded<Host.Delivered>()

    const channelOf = (name: string): FeedChannel => {
      let ch = channels.get(name)
      if (ch === undefined) {
        ch = { rows: [], listeners: new Set(), opens: 0, closes: 0 }
        channels.set(name, ch)
      }
      return ch
    }

    const host: PluginHostShape = {
      query: (queryName, params) => {
        if (queryName === "core/feeds") {
          if (options.deferredIndex !== undefined) return Deferred.await(options.deferredIndex) as never
          return options.refuse === true
            ? Effect.fail(new Host.PluginRefused({ plugin: "uphill", reason: "not_in_reads", detail: "core/feeds" }))
            : Effect.succeed({
              current: () => indexRows as never,
              subscribe: (listener: () => void) => {
                indexListeners.add(listener)
                return () => void indexListeners.delete(listener)
              },
            })
        }
        const docName = params?.name ?? ""
        queriedFeeds.push(docName)
        const deferred = options.deferredFeeds?.get(docName)
        if (deferred !== undefined) {
          return Deferred.await(deferred) as never
        }
        if (options.refuseFeeds?.has(docName)) {
          return Effect.fail(new Host.PluginRefused({ plugin: "uphill", reason: "not_in_reads", detail: docName }))
        }
        const ch = channelOf(docName)
        return Effect.succeed({
          current: () => ch.rows as never,
          subscribe: (listener: () => void) => {
            ch.opens += 1
            ch.listeners.add(listener)
            return () => {
              if (ch.listeners.delete(listener)) ch.closes += 1
            }
          },
        })
      },
      select: () => Effect.void,
      propose: () => Effect.void,
      dispatch: () => Effect.succeed({ _tag: "Done", value: undefined } as never),
      open: (view, repo) => Effect.sync(() => void opened.push({ view, repo })),
      events: () => Stream.fromQueue(queue),
    }
    const built = yield* make(host)
    return {
      tab: built,
      opened,
      queriedFeeds,
      channelOf,
      emit: (event: Host.Delivered) => Queue.offer(queue, event),
      push: (next: ReadonlyArray<FeedDocument>) =>
        Effect.sync(() => {
          indexRows = next
          for (const listener of indexListeners) listener()
        }),
      pushFeed: (name: string, next: ReadonlyArray<FeedDocument>) =>
        Effect.sync(() => {
          const ch = channelOf(name)
          ch.rows = next
          for (const listener of ch.listeners) listener()
        }),
    }
  })

describe("uphill plugin tab", () => {
  test("computes repository href", () => {
    expect(hrefOf(REPO)).toBe("/Acme/Widgets/-/uphill")
  })

  test("reads uphill feed, exposes live summary and steps categories via keyboard events", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness()
          // Event before any repository is active is a clean no-op.
          yield* h.emit({ name: "next", fields: {} })
          yield* Effect.yieldNow
          const state = h.tab.queries.state(REPO)
          const summary = h.tab.queries.summary(REPO)
          yield* Effect.yieldNow
          expect(state.current().status).toBe("ready")
          expect(state.current().overall).toBe(88)
          expect(summary.current().hasFeed).toBe(true)
          expect(summary.current().overall).toBe(88)
          expect(summary.current().opportunities).toBe(1)

          h.tab.actions.selectCategory(REPO, "footprint")
          expect(state.current().selectedCategory).toBe("footprint")

          yield* h.emit({ name: "next", fields: {} })
          yield* Effect.yieldNow
          expect(state.current().selectedCategory).toBe("speed")

          yield* h.emit({ name: "previous", fields: {} })
          yield* Effect.yieldNow
          expect(state.current().selectedCategory).toBe("footprint")

          yield* h.push([])
          expect(state.current().selectedCategory).toBeNull()
          h.tab.actions.step(REPO, 1)
          expect(state.current().selectedCategory).toBeNull()

          expect(h.tab.actions.href(REPO)).toBe("/Acme/Widgets/-/uphill")
          h.tab.actions.open(REPO)
          yield* Effect.yieldNow
          expect(h.opened).toEqual([{ view: VIEW, repo: REPO }])
        }),
      ),
    )
  })

  test("discovers previews and history from uphill-index, subscribes via core/feed only while viewed, streams live updates, and closes on leave", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const indexDoc: FeedDocument = {
            id: "acme/widgets:uphill-index",
            repo: "acme/widgets",
            name: Uphill.UPHILL_INDEX_PUBLIC,
            visibility: "public",
            updatedAt: "2026-11-27T18:00:00Z",
            body: {
              version: 1,
              previews: [{ name: "uphill/untrusted-roninjin10", updatedAt: "2026-11-27T18:00:00Z" }],
              history: { name: "uphill/history", updatedAt: "2026-11-27T18:00:00Z" },
            },
          }
          const h = yield* harness({ initialIndex: [indexDoc] })

          const stopSummary = h.tab.queries.summary(REPO).subscribe(() => {})
          yield* Effect.yieldNow
          expect(h.tab.queries.summary(REPO).current()).toMatchObject({
            hasFeed: true,
            overall: null,
            previewCount: 1,
          })
          expect(h.queriedFeeds).toEqual([])
          stopSummary()

          const state = h.tab.queries.state(REPO)
          const stopState = state.subscribe(() => {})
          yield* Effect.yieldNow
          expect(h.queriedFeeds).toEqual(["uphill/untrusted-roninjin10", "uphill/history"])
          expect(state.current().pendingPreviews).toEqual(["uphill/untrusted-roninjin10"])
          expect(state.current().loadingHistory).toBe(true)

          yield* h.pushFeed("uphill/untrusted-roninjin10", [PREVIEW_DOC(82)])
          expect(state.current().pendingPreviews).toEqual([])
          expect(state.current().envelope).toBeUndefined()
          expect(state.current().untrustedRuns).toHaveLength(1)
          expect(state.current().untrustedRuns[0]).toMatchObject({ actor: "roninjin10", overall: 82 })

          yield* h.pushFeed("uphill/untrusted-roninjin10", [PREVIEW_DOC(91, "2ee39f2d")])
          expect(state.current().untrustedRuns[0]).toMatchObject({ overall: 91 })
          expect(h.queriedFeeds).toHaveLength(2)

          yield* h.push([CANONICAL_DOC, indexDoc])
          yield* h.pushFeed("uphill/history", [HISTORY_DOC])
          expect(state.current().loadingHistory).toBe(false)
          expect(state.current().history.map((p) => p.commit)).toEqual(["aaa1111", "bbb2222"])

          yield* h.pushFeed("uphill/untrusted-roninjin10", [])
          expect(state.current().untrustedRuns).toEqual([])
          expect(state.current().pendingPreviews).toEqual(["uphill/untrusted-roninjin10"])

          yield* h.push([CANONICAL_DOC])
          expect(h.channelOf("uphill/untrusted-roninjin10").closes).toBe(1)
          expect(h.channelOf("uphill/history").closes).toBe(1)
          expect(state.current().pendingPreviews).toEqual([])

          yield* h.push([indexDoc])
          yield* Effect.yieldNow
          expect(h.channelOf("uphill/untrusted-roninjin10").opens).toBe(2)
          stopState()
          stopState()
          expect(h.channelOf("uphill/untrusted-roninjin10").closes).toBe(2)
        }),
      ),
    )
  })

  test("surfaces refused on-demand core/feed documents cleanly and cancels in-flight queries on unmount", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deferredOk = yield* Deferred.make<Host.Live<FeedDocument>, Host.PluginRefused>()
          const deferredFail = yield* Deferred.make<Host.Live<FeedDocument>, Host.PluginRefused>()
          const indexDoc: FeedDocument = {
            id: "acme/widgets:uphill-index",
            repo: "acme/widgets",
            name: Uphill.UPHILL_INDEX_PUBLIC,
            visibility: "public",
            updatedAt: "2026-11-27T18:00:00Z",
            body: {
              version: 1,
              previews: [
                { name: "uphill/untrusted-refused", updatedAt: "2026-11-27T18:00:00Z" },
                { name: "uphill/untrusted-race-ok", updatedAt: "2026-11-27T17:00:00Z" },
                { name: "uphill/untrusted-race-fail", updatedAt: "2026-11-27T16:00:00Z" },
              ],
              history: { name: "uphill/history", updatedAt: "2026-11-27T18:00:00Z" },
            },
          }
          const h = yield* harness({
            initialIndex: [indexDoc],
            refuseFeeds: new Set(["uphill/untrusted-refused", "uphill/history"]),
            deferredFeeds: new Map([
              ["uphill/untrusted-race-ok", deferredOk],
              ["uphill/untrusted-race-fail", deferredFail],
            ]),
          })
          const state = h.tab.queries.state(REPO)
          const earlyStop = state.subscribe(() => {})
          earlyStop()

          const stop = state.subscribe(() => {})
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(state.current().failedPreviews).toEqual(["uphill/untrusted-refused"])
          expect(state.current().historyFailed).toBe(true)
          expect(state.current().pendingPreviews).toEqual(["uphill/untrusted-race-ok", "uphill/untrusted-race-fail"])

          stop()
          let subscribedAfterCancel = false
          yield* Deferred.succeed(deferredOk, {
            current: () => [PREVIEW_DOC(80)],
            subscribe: () => {
              subscribedAfterCancel = true
              return () => {}
            },
          })
          yield* Deferred.fail(
            deferredFail,
            new Host.PluginRefused({ plugin: "uphill", reason: "not_in_reads", detail: "race" }),
          )
          yield* Effect.yieldNow
          expect(subscribedAfterCancel).toBe(false)
        }),
      ),
    )
  })

  test("handles subscribing to state before core/feeds finishes initial sync", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deferredIndex = yield* Deferred.make<Host.Live<FeedDocument>, Host.PluginRefused>()
          const h = yield* harness({ deferredIndex })
          const state = h.tab.queries.state(REPO)
          // Subscribe and unsubscribe while index is still loading (status === "loading").
          const stop = state.subscribe(() => {})
          expect(state.current().status).toBe("loading")
          stop()
          const stopAgain = state.subscribe(() => {})
          yield* Deferred.succeed(deferredIndex, {
            current: () => [CANONICAL_DOC],
            subscribe: () => () => {},
          })
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(state.current().status).toBe("ready")
          expect(state.current().overall).toBe(88)
          stopAgain()
        }),
      ),
    )
  })

  test("handles refused core/feeds cleanly", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ refuse: true })
          const state = h.tab.queries.state(REPO)
          yield* Effect.yieldNow
          expect(state.current().status).toBe("refused")
          expect(h.tab.queries.summary(REPO).current().hasFeed).toBe(false)
        }),
      ),
    )
  })

  test("constructs via PluginHost service and closes active core/feed handles when scope ends", async () => {
    let closed = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const indexDoc: FeedDocument = {
            id: "acme/widgets:uphill-index",
            repo: "acme/widgets",
            name: Uphill.UPHILL_INDEX_PUBLIC,
            visibility: "public",
            updatedAt: "2026-11-27T18:00:00Z",
            body: {
              version: 1,
              previews: [{ name: "uphill/untrusted-roninjin10", updatedAt: "2026-11-27T18:00:00Z" }],
              history: null,
            },
          }
          const host: PluginHostShape = {
            query: (name) =>
              Effect.succeed({
                current: () => (name === "core/feeds" ? [indexDoc] : [PREVIEW_DOC(82)]) as never,
                subscribe: () => () => {
                  if (name === "core/feed") closed += 1
                },
              }),
            select: () => Effect.void,
            propose: () => Effect.void,
            dispatch: () => Effect.succeed({ _tag: "Done", value: undefined } as never),
            open: () => Effect.void,
            events: () => Stream.empty,
          }
          const built = yield* tab.pipe(Effect.provideService(Host.PluginHost, host))
          built.queries.state(REPO).subscribe(() => {})
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(built.queries.state(REPO).current().untrustedRuns).toHaveLength(1)
        }),
      ),
    )
    expect(closed).toBe(1)
  })
})
