import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cascade, contained, deployRunId } from "../../examples/19-cancel-and-child-cleanup.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.live("cancels a parent and carries the cancellation onto its linked child", () =>
  Effect.gen(function*() {
    const summary = yield* cascade(join(directory, "cancel.sqlite"))

    const [parentBefore, childBefore] = summary.before
    expect(parentBefore?.runId).toBe(deployRunId)
    expect(childBefore?.runId).not.toBe(deployRunId)
    // Both runs were open, and neither carried a cancellation.
    expect(parentBefore?.cancelRequested).toBe(false)
    expect(childBefore?.cancelRequested).toBe(false)

    const [parentAfter, childAfter] = summary.after
    expect(parentAfter?.status).toBe("cancelled")
    // The parent writes a REQUEST on the child; the child's own driver settles
    // it, so either state is the contract being kept.
    expect(childAfter?.cancelRequested || childAfter?.status === "cancelled").toBe(true)

    // And the parent journalled the cascade, naming the run it reached.
    expect(summary.cascadedTo).toEqual([childBefore?.runId])
    // The spawn that created the link is itself a recorded effect boundary.
    expect(summary.spawned).toEqual(["flows/engine-store/child-spawn"])
  }), { timeout: 60_000 })

it.live("kills the process group a cancelled step was holding", () =>
  Effect.gen(function*() {
    const summary = yield* contained(join(directory, "contained.sqlite"))

    expect(summary.pgid).toBeGreaterThan(0)
    // The group really existed while the step ran, so its absence afterwards is
    // the cancellation's doing and not a spawn that never happened.
    expect(summary.aliveDuringRun).toBe(true)
    expect(summary.survivedCancel).toBe(false)
  }), { timeout: 60_000 })
