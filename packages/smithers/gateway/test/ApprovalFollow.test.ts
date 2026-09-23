import { describe, expect, it } from "@effect/vitest"
import type { Service as ControlService } from "@smthrs/control/Control"
import type { ControlEvent, RunSummary } from "@smthrs/control/ControlSchema"
import { Effect, Stream } from "effect"
import * as Projections from "../src/Projections.ts"

const running: RunSummary = { runId: "run-1", flowId: "fixture", status: "running", createdAt: 1, updatedAt: 1 }
const waiting: RunSummary = {
  ...running,
  status: "waiting-approval",
  pendingWaits: [{
    runId: "child-1",
    reason: "approval",
    token: "human-wait-token",
    name: "question",
    createdAt: 2,
    request: { prompt: "Continue?" }
  }]
}

describe("run-scoped approval follow", () => {
  for (
    const [name, before, after] of [
      ["shows a newly opened human wait", running, waiting],
      ["removes a human wait after its answer", waiting, running]
    ] as const
  ) {
    it.effect(name, () =>
      Effect.gen(function*() {
        let current = before
        const events: Array<ControlEvent> = []
        const control = {
          list: () => Effect.succeed({ _tag: "runs", items: [current] }),
          watch: (filter) =>
            filter.follow === false
              ? Stream.fromIterable(events)
              : Stream.fromEffect(Effect.sync(() => {
                current = after
                const event = {
                  sequence: 1,
                  kind: `control.run.${after.status}`,
                  runId: running.runId,
                  occurredAt: 2,
                  payload: null
                }
                events.push(event)
                return event
              }))
        } satisfies Pick<ControlService, "list" | "watch">
        const projections = yield* Projections.make(control as unknown as ControlService)
        const selector = { _tag: "approvals", runId: running.runId } as const
        const frames = yield* Stream.runCollect(projections.subscribe(selector))
        const delta = frames.filter((frame) => frame._tag === "delta").at(-1)
        expect(delta?._tag).toBe("delta")
        if (delta?._tag !== "delta") return
        const snapshot = yield* projections.snapshot(selector)
        expect(delta.delta).toEqual(snapshot.rows)
        expect(delta.delta).toHaveLength(after === waiting ? 1 : 0)
      }))
  }
})
