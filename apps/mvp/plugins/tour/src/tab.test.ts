import { Host } from "@smthrs/plugin"
import { Effect, Layer, Queue, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { STOPS, VIEW } from "./model"
import { tab } from "./tab"

describe("tour tab", () => {
  test("moves via actions and host keymap events, notifies subscribers, and dispatches navigation", async () => {
    const dispatched: Array<{ readonly view: string; readonly name: string; readonly payload: unknown }> = []
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const queue = yield* Queue.unbounded<{ readonly name: string; readonly fields: Readonly<Record<string, unknown>> }>()
      const host = Host.PluginHost.of({
        query: () => Effect.die("unused"),
        select: () => Effect.void,
        dispatch: (event, payload) =>
          Effect.sync(() => {
            dispatched.push({ view: event.view, name: event.name, payload })
            return { runId: "run-1", settled: Effect.succeed({ _tag: "Done" as const }) }
          }),
        open: () => Effect.void, propose: () => Effect.void,
        events: () => Stream.fromQueue(queue),
      })
      const t = yield* tab.pipe(Effect.provide(Layer.succeed(Host.PluginHost, host)))
      let notifications = 0
      const unsubscribe = t.queries.state.subscribe(() => { notifications += 1 })

      expect(t.queries.state.current().index).toBe(0)
      t.actions.next()
      expect(t.queries.state.current().index).toBe(1)
      t.actions.previous()
      expect(t.queries.state.current().index).toBe(0)
      t.actions.select(3)
      expect(t.queries.state.current().index).toBe(3)
      t.actions.choose(STOPS[3]!.choices[1]!.id)
      expect(t.queries.state.current().activeChoice.id).toBe(STOPS[3]!.choices[1]!.id)
      t.actions.restart()
      expect(t.queries.state.current().index).toBe(0)

      // Host keymap events (next / previous / ignored unknown)
      yield* Queue.offer(queue, { name: "next", fields: {} })
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(t.queries.state.current().index).toBe(1)

      yield* Queue.offer(queue, { name: "previous", fields: {} })
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(t.queries.state.current().index).toBe(0)

      yield* Queue.offer(queue, { name: "unknown", fields: {} })
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(t.queries.state.current().index).toBe(0)

      // Navigation dispatches manifest `go` event
      t.actions.go("/app?agent=mock")
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(dispatched).toEqual([{ view: VIEW, name: "go", payload: { to: "/app?agent=mock" } }])

      unsubscribe()
      const before = notifications
      t.actions.next()
      expect(notifications).toBe(before)
    })))
  })
})
