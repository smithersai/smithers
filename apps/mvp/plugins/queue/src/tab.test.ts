// The queue's cursor, ordering and snooze controls (plugins/queue/src/tab.ts).
import { Host } from "@smthrs/plugin"
import { Effect, Queue, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { clamp, follow, orderWaits, repositoryOf, tab, VIEW, type Wait } from "./tab"

const rows = (...ids: Array<string>) => ids.map((runId) => ({ runId }))

const wait = (runId: string, kind: "question" | "approval" = "question", repoId = "github/acme/widgets"): Wait => ({
  runId,
  version: 1,
  execution: `exec-${runId}`,
  kind,
  prompt: `Prompt ${runId}`,
  options: kind === "question" ? ["Yes", "No"] : [],
  question: kind === "question",
  approval: kind === "approval",
  createdAt: "2026-11-20T00:00:00Z",
  repoId,
})

describe("the queue's cursor and ordering", () => {
  test("j and k move inside the queue and stop at its ends", () => {
    expect(clamp(1, 3)).toBe(1)
    expect(clamp(3, 3)).toBe(2)
    expect(clamp(-1, 3)).toBe(0)
    expect(clamp(0, 0)).toBe(0)
    expect(clamp(5, 0)).toBe(0)
  })

  test("a wait arriving or leaving elsewhere keeps the cursor on its item", () => {
    expect(follow(rows("a", "b", "c"), "b", 1)).toBe(1)
    expect(follow(rows("x", "a", "b", "c"), "b", 1)).toBe(2)
    expect(follow(rows("b", "c"), "b", 1)).toBe(0)
  })

  test("when its item leaves, the cursor rests on the one that took its place", () => {
    expect(follow(rows("a", "c"), "b", 1)).toBe(1)
    expect(clamp(follow(rows("a"), "b", 1), 1)).toBe(0)
    expect(follow(rows(), undefined, 0)).toBe(0)
  })

  test("the item's repository reads as owner and name; a wait that names none has none", () => {
    expect(repositoryOf("github/acme/widgets")).toBe("acme/widgets")
    expect(repositoryOf("")).toBeUndefined()
  })

  test("orderWaits hides snoozed runs and sorts approvals ahead of questions when prioritized", () => {
    const items = [wait("q1", "question"), wait("a1", "approval"), wait("q2", "question"), wait("a2", "approval")]
    expect(orderWaits(items, new Set(["q1", "gone"]), "oldest")).toEqual({
      visible: [items[1], items[2], items[3]],
      snoozed: 1,
    })
    expect(orderWaits(items, new Set(), "approvals").visible.map((w) => w.runId)).toEqual(["a1", "a2", "q1", "q2"])
  })
})

describe("queue tab actions and keyboard events", () => {
  test("handles next, previous, snooze, unsnooze, sort, and open cleanly", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let list: ReadonlyArray<Wait> = [wait("q1", "question"), wait("a1", "approval", "")]
          const listeners = new Set<() => void>()
          const selected: Array<string> = []
          const opened: Array<string> = []
          const events = yield* Queue.unbounded<Host.Delivered>()
          const host: Effect.Success<typeof Host.PluginHost> = {
            query: () =>
              Effect.succeed({
                current: () => list as never,
                subscribe: (fn) => {
                  listeners.add(fn)
                  return () => void listeners.delete(fn)
                },
              }),
            select: (item) => Effect.sync(() => void selected.push(item.key)),
            open: (view) => Effect.sync(() => void opened.push(view)),
            dispatch: () => Effect.succeed({ _tag: "Done", value: undefined } as never),
            propose: () => Effect.void,
            events: () => Stream.fromQueue(events),
          }

          const t = yield* tab.pipe(Effect.provideService(Host.PluginHost, host))
          let ticks = 0
          const unsub = t.queries.current.subscribe(() => {
            ticks++
          })
          expect(t.queries.current.current()).toMatchObject({ index: 0, total: 2, snoozed: 0, sort: "oldest", repository: "acme/widgets" })

          // Un-snooze when nothing snoozed is a no-op
          t.actions.unsnooze()

          // Priority sort moves approval a1 to index 0
          Queue.offerUnsafe(events, { name: "sort", fields: {} })
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(t.queries.current.current()).toMatchObject({ sort: "approvals", total: 2 })
          expect(t.queries.current.current().item?.runId).toBe("q1")

          // Previous moves to a1, next back to q1
          Queue.offerUnsafe(events, { name: "previous", fields: {} })
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(t.queries.current.current().item?.runId).toBe("a1")

          Queue.offerUnsafe(events, { name: "next", fields: {} })
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(t.queries.current.current().item?.runId).toBe("q1")

          // Toggle sort back to oldest
          t.actions.toggleSort()
          expect(t.queries.current.current().sort).toBe("oldest")

          // Snooze both items, then snooze when empty is a no-op
          Queue.offerUnsafe(events, { name: "snooze", fields: {} })
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(t.queries.current.current()).toMatchObject({ total: 1, snoozed: 1 })
          t.actions.snooze()
          expect(t.queries.current.current()).toMatchObject({ total: 0, snoozed: 2, item: undefined })
          t.actions.snooze()

          // Restore snoozed via keyboard event
          Queue.offerUnsafe(events, { name: "unsnooze", fields: {} })
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(t.queries.current.current()).toMatchObject({ total: 2, snoozed: 0 })

          // Live wait list update triggers subscribe callback
          list = [wait("a1", "approval")]
          for (const fn of listeners) fn()
          expect(t.queries.current.current().total).toBe(1)

          t.actions.open()
          yield* Effect.yieldNow
          expect(opened).toEqual([VIEW])
          expect(selected.length).toBeGreaterThan(0)
          expect(ticks).toBeGreaterThan(0)
          unsub()
        }),
      ),
    )
  })
})
