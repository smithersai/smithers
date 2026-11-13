import type { ControlSchema } from "@smthrs/control"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { signalDelivery } from "./signalDelivery.ts"

const admission = (index: number, sequence = index + 2): ControlSchema.ControlEvent => ({
  runId: "run-1",
  sequence,
  occurredAt: sequence,
  kind: "control.signal.admitted",
  payload: { commandId: `tick:run-1:${index}`, runId: "run-1", name: "tick" }
})

describe("subscriber workload boundary", () => {
  it("rejects the old false positive: one launch and 499 admissions are not 500 signals", () => {
    const delivery = signalDelivery("run-1", 500)
    delivery.observe({ ...admission(0, 1), kind: "control.run.accepted" })
    for (let index = 0; index < 499; index++) delivery.observe(admission(index))
    expect(delivery.complete()).toBe(false)
    expect(delivery.snapshot().identities).toHaveLength(499)
    delivery.observe(admission(499))
    expect(delivery.complete()).toBe(true)
    expect(delivery.snapshot()).toEqual({ identities: delivery.expected, cursor: 501 })
  })

  it("never substitutes unrelated history for a missing signal, at any position", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), fc.nat(), (count, seed) => {
      const missing = seed % count
      const delivery = signalDelivery("run-1", count)
      for (let index = 0; index < count; index++) {
        if (index !== missing) delivery.observe(admission(index))
        delivery.observe({ ...admission(index, count + index + 2), kind: "control.run.accepted" })
        delivery.observe({ ...admission(index), runId: "another-run" })
      }
      expect(delivery.complete()).toBe(false)
      expect(delivery.snapshot().identities).not.toContain(`tick:run-1:${missing}`)
    }))
  })

  it("accepts every complete workload, including actor-scoped identities", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), (count) => {
      const delivery = signalDelivery("run-1", count)
      for (let index = 0; index < count; index++) {
        delivery.observe({
          ...admission(index),
          payload: { commandId: `signal:actor:${"a".repeat(64)}:tick:run-1:${index}`, runId: "run-1", name: "tick" }
        })
      }
      expect(delivery.complete()).toBe(true)
      expect(delivery.snapshot()).toEqual({ identities: delivery.expected, cursor: count + 1 })
    }))
  })

  it("refuses duplicates, unexpected identities and regressing cursors", () => {
    const delivery = signalDelivery("run-1", 2)
    delivery.observe(admission(0))
    expect(() => delivery.observe(admission(0, 3))).toThrow("Duplicate")
    expect(() => delivery.observe(admission(2, 4))).toThrow("Unexpected")
    expect(() => delivery.observe(admission(1, 1))).toThrow("cursor")
    expect(() => delivery.observe({ ...admission(1), payload: { commandId: "tick:run-1:1", name: "different" } }))
      .toThrow("identity")
    expect(delivery.complete()).toBe(false)
  })
})
