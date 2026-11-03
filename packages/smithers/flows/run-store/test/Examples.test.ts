import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Cancellation from "../examples/cancellation.vibe"
import * as Quickstart from "../examples/quickstart.vibe"

describe("examples", () => {
  it.effect("quickstart settles the run as completed with the final state and owner cleared", () =>
    Effect.gen(function*() {
      const row = yield* Quickstart.main
      expect(row).toMatchObject({
        runId: "quickstart-1",
        status: "completed",
        owner: null,
        heartbeatAtMs: null,
        claim: null,
        claimedAtMs: null,
        stateJson: "{\"cursor\":1}"
      })
      expect(row.startedAtMs).not.toBeNull()
      expect(row.finishedAtMs).toBeGreaterThanOrEqual(row.startedAtMs!)
    }))

  it.effect("cancellation refuses guarded progress after the request and settles as cancelled", () =>
    Effect.gen(function*() {
      const result = yield* Cancellation.main
      expect(result.requested._tag).toBe("CancelRequested")
      expect(result.repeated).toEqual({
        _tag: "AlreadyRequested",
        requestedAtMs: result.requested._tag === "CancelRequested" ? result.requested.requestedAtMs : -1
      })
      expect(result.progress._tag).toBe("GuardFailed")
      expect(result.acknowledged).toBe(true)
      expect(result.settled._tag).toBe("Transitioned")
      expect(result.afterSettle).toEqual({ _tag: "Terminal", status: "cancelled" })
      expect(result.row).toMatchObject({ status: "cancelled", owner: null, stateJson: "{\"cursor\":0}" })
    }))
})
