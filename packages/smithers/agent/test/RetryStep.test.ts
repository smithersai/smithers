/**
 * Which engine node a retry of a settled module run starts from, read from the
 * run's recorded steps.
 */
import type * as RunInspection from "@smthrs/engine-store/RunInspection"
import { describe, expect, it } from "vitest"
import * as RetryStep from "../src/internal/RetryStep.ts"

const attempt: RunInspection.Attempt = {
  attempt: 1,
  state: "finished",
  startedAtMs: 1,
  finishedAtMs: 2,
  outcome: null,
  error: null
}

const step = (
  nodeId: string,
  action: string | null,
  status: RunInspection.Step["status"] = "completed",
  options: { readonly kind?: string; readonly ran?: boolean } = {}
): RunInspection.Step => ({
  nodeId,
  action,
  kind: options.kind ?? "ActionCall",
  status,
  scheduledAtMs: 1,
  settledAtMs: 2,
  seq: 1,
  output: null,
  attempts: options.ran === false ? [] : [attempt]
})

const inspection = (steps: ReadonlyArray<RunInspection.Step>): RunInspection.Inspection =>
  ({
    run: { runId: "native" },
    steps,
    children: [],
    journal: { events: [], afterSeq: -1, nextSeq: -1, hasMore: false }
  }) as unknown as RunInspection.Inspection

const ran = inspection([
  step("root.load", "app/Load"),
  step("root.flow", null, "completed", { kind: "Flow" }),
  step("root.child", "app/Child", "failed", { kind: "FlowCall" }),
  step("root.work", "app/Work", "failed"),
  step("root.finish.a", "app/Finish"),
  step("root.finish.b", "app/Finish"),
  step("root.never", "app/Never", "skipped", { ran: false })
])

describe("RetryStep.select", () => {
  it("starts from the last action step that failed when no step is named", () => {
    expect(RetryStep.select("run-1", ran, undefined)).toEqual({ _tag: "Step", nodeId: "root.work" })
  })

  it("refuses a run with no failed action step when no step is named", () => {
    expect(RetryStep.select("run-1", inspection([step("root.load", "app/Load")]), undefined)).toEqual({
      _tag: "Refused",
      reason: "run run-1 has no failed step; name the step to retry from"
    })
  })

  it("starts from the step an action name or a node id names", () => {
    expect(RetryStep.select("run-1", ran, "app/Load")).toEqual({ _tag: "Step", nodeId: "root.load" })
    expect(RetryStep.select("run-1", ran, "root.finish.b")).toEqual({ _tag: "Step", nodeId: "root.finish.b" })
  })

  it("refuses a step that did not run, listing each action that did once", () => {
    for (const named of ["app/Nope", "app/Never", "root.flow", "app/Child"]) {
      expect(RetryStep.select("run-1", ran, named)).toEqual({
        _tag: "Refused",
        reason: `run run-1 ran no step ${named}; its steps are app/Load, app/Work, app/Finish`
      })
    }
  })

  it("refuses an action that ran more than once, listing its node ids", () => {
    expect(RetryStep.select("run-1", ran, "app/Finish")).toEqual({
      _tag: "Refused",
      reason: "run run-1 ran app/Finish 2 times; name one node: root.finish.a, root.finish.b"
    })
  })
})
