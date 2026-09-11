/**
 * The settlement vocabulary a launching verb reports its run with, pinned at
 * the module that now owns it instead of only through `Command.cli`.
 */
import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Settlement from "../src/commands/Settlement.ts"

describe("Settlement", () => {
  it("settles on a park, a declined launch, and every terminal status", () => {
    expect(
      [
        "control.run.waiting-approval",
        "control.run.pending",
        "control.run.completed",
        "control.run.failed",
        "control.run.cancelled",
        "control.run.started",
        "control.node.completed"
      ].filter(Settlement.settled)
    ).toEqual([
      "control.run.waiting-approval",
      "control.run.pending",
      "control.run.completed",
      "control.run.failed",
      "control.run.cancelled"
    ])
  })

  it("reports the launch contract's exit status for each settlement", () => {
    expect(Settlement.status({ kind: "control.run.completed" })).toBe(0)
    expect(Settlement.status({ kind: "control.run.failed" })).toBe(1)
    expect(Settlement.status({ kind: "control.run.cancelled" })).toBe(130)
    expect(Settlement.status({ kind: "control.run.waiting-approval" })).toBe(3)
    expect(Settlement.status({ kind: "control.run.pending" })).toBeUndefined()
    expect(Settlement.status(undefined)).toBeUndefined()
  })

  it("treats only a pending settlement as a declined launch", () => {
    expect(Settlement.wasDeclined({ kind: "control.run.pending" })).toBe(true)
    expect(Settlement.wasDeclined({ kind: "control.run.failed" })).toBe(false)
    expect(Settlement.wasDeclined(undefined)).toBe(false)
  })

  it("keeps the receipt and adds the failure verdict", () => {
    const receipt = { _tag: "Accepted", runId: "run-1" } as unknown as ControlSchema.Receipt

    expect(Settlement.receiptDocument(receipt, { kind: "control.run.completed" })).toBe(receipt)
    expect(Settlement.receiptDocument(receipt, { kind: "control.run.failed" })).toEqual({
      ...receipt,
      status: "failed",
      cause: "no cause recorded in the journal"
    })
  })

  it("names the run and the next commands when no executor took it", () => {
    const error = Settlement.declined("run-1", undefined)

    expect(error.message).toContain("Run run-1 was accepted but no executor took it: it is accepted")
    expect(error.message).toContain("smthrs cancel run-1")
  })
})
