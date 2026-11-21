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
        name: "wiki",
        updatedAt: "2026-11-20T00:00:00Z",
        body: {
          notes: [
            { path: "Alpha.md", title: "Alpha", markdown: "See [[Beta]]" },
            { path: "Beta.md", title: "Beta", markdown: "Back to [[Alpha]]" },
          ],
        },
      },
    ]
    const listeners = new Set<() => void>()
    const opened: Array<unknown> = []
    const queue = yield* Queue.unbounded<Host.Delivered>()
    const host: PluginHostShape = {
      query: () =>
        options.refuse === true
          ? Effect.fail(new Host.PluginRefused({ plugin: "wiki", reason: "not_in_reads", detail: "core/feeds" }))
          : Effect.succeed({
            current: () => rows as never,
            subscribe: (fn) => {
              listeners.add(fn)
              return () => void listeners.delete(fn)
            },
          }),
      select: () => Effect.void,
      open: (view, repo) => Effect.sync(() => void opened.push([view, repo])),
      dispatch: () => Effect.succeed({ _tag: "Done", value: undefined } as never),
      propose: () => Effect.void,
      events: () => Stream.fromQueue(queue),
    }
    return {
      host,
      opened,
      emit: (name: string) => Queue.offerUnsafe(queue, { name, fields: {} }),
      push: (next: ReadonlyArray<FeedDocument>) => {
        rows = next
        for (const fn of listeners) fn()
      },
    }
  })

describe("wiki tab", () => {
  test("loads repository wiki feeds, supports search, select, j/k keyboard stepping, and open", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness()
          const t = yield* tab.pipe(Effect.provideService(Host.PluginHost, h.host))
          h.emit("next")
          yield* Effect.yieldNow
          const watched = t.queries.state(REPO)
          const hasFeed = t.queries.hasFeed(REPO)
          let changes = 0
          const unsub = watched.subscribe(() => {
            changes++
          })
          yield* Effect.yieldNow
          expect(hrefOf(REPO)).toBe("/Acme/Widgets/-/wiki")
          expect(t.actions.href(REPO)).toBe("/Acme/Widgets/-/wiki")
          expect(hasFeed.current()).toBe(true)
          expect(watched.current().status).toBe("ready")
          expect(watched.current().selectedPath).toBe("Alpha.md")

          t.actions.select(REPO, "Beta.md")
          expect(watched.current().selectedPath).toBe("Beta.md")

          h.emit("previous")
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(watched.current().selectedPath).toBe("Alpha.md")

          h.emit("next")
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(watched.current().selectedPath).toBe("Beta.md")

          t.actions.search(REPO, "nonexistent")
          expect(watched.current().filtered).toEqual([])
          t.actions.step(REPO, 1)
          t.actions.search(REPO, "")
          expect(watched.current().filtered).toHaveLength(2)

          t.actions.open(REPO)
          yield* Effect.yieldNow
          expect(h.opened).toEqual([[VIEW, REPO]])
          expect(changes).toBeGreaterThan(0)
          unsub()
        }),
      ),
    )
  })

  test("marks state as refused when core/feeds query is refused", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ refuse: true })
          const t = yield* make(h.host)
          const watched = t.queries.state(REPO)
          yield* Effect.yieldNow
          expect(watched.current().status).toBe("refused")
          expect(t.queries.hasFeed(REPO).current()).toBe(false)
        }),
      ),
    )
  })
})
