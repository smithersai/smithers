import { Host } from "@smthrs/plugin"
import { Effect, Queue, Stream } from "effect"
import { describe, expect, test } from "vitest"
import type { FeedDocument } from "./model"
import { hrefOf, make, type PluginHostShape, tab, VIEW } from "./tab"

const REPO = { owner: "Acme", name: "Widgets" }

const harness = (options: { readonly refuse?: boolean } = {}) =>
  Effect.gen(function* () {
    let rows: ReadonlyArray<FeedDocument> = [
      {
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
      },
    ]
    const listeners = new Set<() => void>()
    const opened: Array<unknown> = []
    const queue = yield* Queue.unbounded<Host.Delivered>()
    const host: PluginHostShape = {
      query: () =>
        options.refuse === true
          ? Effect.fail(new Host.PluginRefused({ plugin: "uphill", reason: "not_in_reads", detail: "core/feeds" }))
          : Effect.succeed({
            current: () => rows as never,
            subscribe: (listener: () => void) => {
              listeners.add(listener)
              return () => void listeners.delete(listener)
            },
          }),
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
      emit: (event: Host.Delivered) => Queue.offer(queue, event),
      push: (next: ReadonlyArray<FeedDocument>) =>
        Effect.sync(() => {
          rows = next
          for (const listener of listeners) listener()
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

          h.tab.actions.open(REPO)
          yield* Effect.yieldNow
          expect(h.opened).toEqual([{ view: VIEW, repo: REPO }])
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

  test("tab effect resolves PluginHost from context", async () => {
    const built = await Effect.runPromise(
      Effect.scoped(
        tab.pipe(
          Effect.provideService(Host.PluginHost, {
            query: () => Effect.succeed({ current: () => [], subscribe: () => () => {} }),
            select: () => Effect.void,
            propose: () => Effect.void,
            dispatch: () => Effect.succeed({ _tag: "Done", value: undefined } as never),
            open: () => Effect.void,
            events: () => Stream.empty,
          }),
        ),
      ),
    )
    expect(built.actions.href(REPO)).toBe("/Acme/Widgets/-/uphill")
  })
})
