import { describe, expect, test } from "vitest"
import { detailsOf, jobStateOf } from "./details"
import { graphOf } from "./graph"
import type { Inspection, RunPage } from "./schema"

// A run opened in place on the Runs page (src/features/runs/details.ts, ruling FLOW-13): its jobs and steps, regrouped
// from the graph the run page draws.

const value = (text: string, clipped = false) => ({ text, bytes: text.length, clipped })

const run: Inspection["run"] = {
  runId: "r",
  flowName: "todo",
  status: "completed",
  createdAtMs: 1000,
  startedAtMs: 1000,
  finishedAtMs: 2000,
  parentRunId: null,
  cancelRequestedAtMs: null,
  waiting: null,
  lastSeq: 9,
  origin: null,
  input: value("{}"),
  result: value("{\"state\":\"failed\"}"),
}

const event = (runId: string, seq: number, eventType: string, payload: unknown) => ({
  seq,
  eventType,
  emittedAtMs: 1000 + seq * 100,
  payload: value(JSON.stringify(payload)),
  runId,
})

const plan = (runId: string, nodes: ReadonlyArray<Record<string, unknown>>) =>
  event(runId, 1, "flows.engine.plan-recorded", { generation: 0, graph: { nodes } })

const rootEvents = [
  plan("r", [
    { id: "plan", kind: "ActionCall", tier: "sealed", action: "todo/Plan", dependsOn: [] },
    { id: "publish", kind: "ActionCall", tier: "sealed", action: "todo/Publish", dependsOn: ["plan"] },
    { id: "job", kind: "FlowCall", tier: "sealed", action: "ci/job", dependsOn: ["publish"] },
  ]),
  event("r", 2, "flows.engine.node-scheduled", { nodeId: "plan", kind: "ActionCall", attempt: 1 }),
  event("r", 3, "flows.engine.node-settled", { nodeId: "plan", outcome: "built", attempts: 1, stepKeyDigests: ["a".repeat(64)] }),
  event("r", 4, "telemetry.log", {
    level: "Info",
    message: "todo.plan",
    annotations: { runId: "r", stepKey: `key1_${"a".repeat(64)}`, stepKeyDigest: "a".repeat(64), outcome: "planned" },
  }),
  event("r", 5, "flows.engine.node-scheduled", { nodeId: "publish", kind: "ActionCall", attempt: 1 }),
  event("r", 6, "flows.engine.node-settled", { nodeId: "publish", outcome: "failed", attempts: 2 }),
  // A durable sleep: the run page's timeline shows it, a job's steps don't.
  event("r", 7, "flows.engine.v2.state-event", {
    version: 2,
    executionId: "r",
    lineage: { kind: "root", runId: "r", rootRunId: "r", lineageId: "r", round: 0, parentRunId: null },
    event: { _tag: "ClockScheduled", clockId: "clock", waitId: "sleep", dueAtMs: 9000 },
  }),
].map(({ runId: _, ...rest }) => rest)

const child: Inspection = {
  run: { ...run, runId: "child", parentRunId: "r", flowName: "ci/job", status: "cancelled", result: null },
  children: [],
  steps: [],
  journal: {
    events: [
      plan("child", [{ id: "step", kind: "ActionCall", tier: "sealed", action: "ci/step", dependsOn: [] }]),
      event("child", 2, "flows.engine.node-scheduled", { nodeId: "step", kind: "ActionCall", attempt: 1 }),
    ].map(({ runId: _, ...rest }) => rest),
    afterSeq: -1,
    nextSeq: 2,
    hasMore: false,
  },
}

const page = (overrides: Partial<RunPage> = {}): RunPage => ({
  id: "r",
  state: "read",
  inspection: {
    run,
    steps: [{
      nodeId: "publish",
      action: "todo/Publish",
      kind: "ActionCall",
      status: "failed",
      scheduledAtMs: 1500,
      settledAtMs: 1600,
      seq: 5,
      output: null,
      attempts: [
        { attempt: 1, state: "failed", startedAtMs: 1500, finishedAtMs: 1550, outcome: null, error: "unavailable" },
        { attempt: 2, state: "failed", startedAtMs: 1560, finishedAtMs: 1600, outcome: null, error: "GitHubRefused" },
      ],
    }],
    children: [{ ...child.run }],
    journal: { events: rootEvents, afterSeq: -1, nextSeq: 7, hasMore: false },
  },
  more: [],
  descendants: [child],
  hasMore: false,
  ...overrides,
})

describe("detailsOf", () => {
  test("the run and each run it started as jobs, their steps in order, a failure's last code, and each step's logs", () => {
    const details = detailsOf(page(), 3000)
    expect(details.jobs.map((job) => [job.id, job.label, job.state, job.href])).toEqual([
      // A TODO whose work failed reads failed, as its header does, though its engine completed.
      ["r", "todo", "failed", null],
      // A stopped job reads as skipped work, never as a failure.
      ["child", "ci/job", "skipped", "/app/runs/child"],
    ])
    expect(details.jobs[0]!.steps.map((step) => [step.label, step.state, step.error])).toEqual([
      ["todo/Plan", "completed", null],
      ["todo/Publish", "failed", "GitHubRefused"],
      ["ci/job", "pending", null],
    ])
    expect(details.jobs[1]!.steps.map((step) => [step.label, step.state])).toEqual([["ci/step", "cancelled"]])
    // The sleep is the graph's, never a job's step.
    expect(graphOf(page(), null, 3000).steps.some((step) => step.row.kind === "sleep")).toBe(true)
    expect(details.jobs.flatMap((job) => job.steps).some((step) => step.label.includes("sleep"))).toBe(false)
    // The logs are the graph's own, by step.
    const graph = graphOf(page(), null, 3000)
    for (const job of details.jobs) {
      for (const step of job.steps) {
        const drawn = graph.steps.find((candidate) => candidate.row.id === step.id)!
        expect(details.logs.get(step.id)).toEqual(drawn.logs)
        expect(step.logs).toBe(drawn.logs.length)
      }
    }
  })

  test("a page read before its children lists the run alone", () => {
    const { descendants: _, ...bare } = page()
    expect(detailsOf(bare, 3000).jobs.map((job) => job.id)).toEqual(["r"])
  })

  test("a job's links follow the page's own paths; a page with no run lists nothing", () => {
    expect(detailsOf(page(), 3000, (id) => `/octo/hello/actions/runs/${id}`).jobs[1]!.href).toBe("/octo/hello/actions/runs/child")
    expect(detailsOf(page({ state: "not_found", inspection: null }), 3000)).toEqual({ jobs: [], logs: new Map() })
  })

  test("a run's state as a job's line reads it", () => {
    expect(["completed", "failed", "cancelled", "suspended", "pending", "running"].map((status) =>
      jobStateOf(status as Inspection["run"]["status"])
    )).toEqual(["completed", "failed", "skipped", "waiting", "pending", "running"])
  })
})
