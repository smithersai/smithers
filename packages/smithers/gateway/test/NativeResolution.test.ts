/**
 * The committed native result and the binding that authorizes it.
 *
 * `Diagnosis` folds these through `digest` and `combine`, so the happy paths
 * are proven there. This suite asks the questions a happy path never produces:
 * an event with no run id, a binding whose payload does not bind, a legacy
 * baseline, an exit value JSON cannot encode, and two windows that disagree
 * about what one root returned.
 */
import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as NativeResolution from "../src/internal/nativeResolution.ts"

let sequence = 0

const event = (kind: string, payload: unknown, runId: string | null = "run-1"): ControlSchema.ControlEvent =>
  ({
    sequence: (sequence += 1),
    kind,
    ...(runId === null ? {} : { runId }),
    occurredAt: 0,
    payload: payload as ControlSchema.ControlEvent["payload"]
  }) as ControlSchema.ControlEvent

/** The payload a completed `agent/run` root commits, with one exit substituted. */
const committed = (exit: unknown, baseline: string = "created") => ({
  version: 1,
  executionId: "exec-1",
  generation: 0,
  sequence: 0,
  eventType: "flows.engine.run-decision",
  payload: {
    decision: "transitioned",
    status: "completed",
    executionFact: {
      version: 1,
      baseline,
      observation: { executionId: "exec-1", status: "completed", flowName: "agent/run" }
    },
    state: {
      version: 1,
      flowName: "agent/run",
      payload: { runId: "run-1", planId: "plan-1" },
      result: { _tag: "Complete", exit }
    }
  }
})

describe("NativeResolution.fromEvent", () => {
  it("reads nothing from an event that names no run", () => {
    expect(NativeResolution.fromEvent(event("control.engine.bound", { version: 1 }, null))).toBeUndefined()
    expect(NativeResolution.fromEvent(event("control.engine.bound", { version: 1 }, ""))).toBeUndefined()
  })

  it("reports a binding that does not bind this run as a conflict", () => {
    // Every field of the bridge payload has to agree; a binding that names
    // another run, another version or no execution cannot authorize output.
    for (
      const payload of [
        { version: 2, controlRunId: "run-1", executionId: "exec-1" },
        { version: 1, controlRunId: "run-2", executionId: "exec-1" },
        { version: 1, controlRunId: "run-1", executionId: "" },
        { version: 1, controlRunId: "run-1" }
      ]
    ) {
      expect(NativeResolution.fromEvent(event("control.engine.bound", payload))).toEqual({ conflict: true })
    }
    expect(NativeResolution.fromEvent(event("control.engine.bound", {
      version: 1,
      controlRunId: "run-1",
      executionId: "exec-1"
    }))).toEqual({ binding: { runId: "run-1", executionId: "exec-1" } })
  })

  it("accepts a legacy baseline and keeps a string exit verbatim", () => {
    // `legacy` is the baseline a fact recorded before the created-baseline
    // producer landed, and it commits a result exactly as `created` does.
    expect(
      NativeResolution.fromEvent(event("control.engine.event", committed({ _tag: "Success", value: "done" }, "legacy")))
    )
      .toEqual({ result: { runId: "run-1", executionId: "exec-1", text: "done" } })
    expect(
      NativeResolution.fromEvent(
        event("control.engine.event", committed({ _tag: "Success", value: "done" }, "adopted"))
      )
    )
      .toBeUndefined()
  })

  it("encodes a non-string exit and reads nothing from one JSON cannot encode", () => {
    expect(NativeResolution.fromEvent(event("control.engine.event", committed({ _tag: "Success", value: { ok: 1 } }))))
      .toEqual({ result: { runId: "run-1", executionId: "exec-1", text: "{\"ok\":1}" } })
    // `JSON.stringify` answers `undefined` for these and throws for a BigInt.
    // Neither is a committed result, and neither may reach a reader as text.
    expect(NativeResolution.fromEvent(event("control.engine.event", committed({ _tag: "Success", value: undefined }))))
      .toBeUndefined()
    expect(NativeResolution.fromEvent(event("control.engine.event", committed({ _tag: "Success", value: 1n }))))
      .toBeUndefined()
  })
})

describe("NativeResolution.combine", () => {
  const binding = { runId: "run-1", executionId: "exec-1" }

  it("keeps one agreed result across adjacent windows", () => {
    const earlier = { binding, result: { ...binding, text: "done" } }
    const later = { result: { ...binding, text: "done" } }
    expect(NativeResolution.combine(earlier, later)).toEqual({
      binding,
      result: { ...binding, text: "done" }
    })
  })

  it("reports two windows that disagree about one root's output as a conflict", () => {
    const earlier = { binding, result: { ...binding, text: "first" } }
    // The same execution cannot have returned two different texts.
    expect(NativeResolution.combine(earlier, { result: { ...binding, text: "second" } })?.conflict).toBe(true)
    // Nor can two executions both be this run's committed result.
    expect(
      NativeResolution.combine(earlier, { result: { runId: "run-1", executionId: "exec-2", text: "first" } })?.conflict
    ).toBe(true)
  })

  it("refuses output for a conflicted or unbound resolution", () => {
    expect(NativeResolution.output({ binding, result: { ...binding, text: "done" } })).toBe("done")
    expect(NativeResolution.output({ binding, result: { ...binding, text: "done" }, conflict: true })).toBeUndefined()
    expect(NativeResolution.output({ result: { ...binding, text: "done" } })).toBeUndefined()
  })
})
