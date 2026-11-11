import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main } from "../../examples/07-sync-follower.vibe"

it.effect("catches up on durable history, then follows live commits", () =>
  Effect.gen(function*() {
    const summary = yield* main
    expect(summary.caughtUp).toEqual(["run.started", "step.recorded"])
    expect(summary.followed).toEqual(["run.completed"])
  }))
