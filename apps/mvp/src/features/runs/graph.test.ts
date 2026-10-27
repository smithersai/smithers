import { describe, expect, test } from "vitest"
import { graphOf, runTitle } from "./graph"
import type { Inspection, RunPage } from "./schema"
const value = (text: string, clipped = false) => ({ text, bytes: text.length, clipped })
const run: Inspection["run"] = {
  runId: "r",
  flowName: "flow/run",
  status: "running",
  createdAtMs: 1000,
  startedAtMs: 1000,
  finishedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  waiting: null,
  lastSeq: 4,
  origin: null,
  input: value("{\"name\":\"daily\"}"),
  result: null
}
const event = (seq: number, eventType: string, payload: unknown) => ({
  seq,
  eventType,
  emittedAtMs: 1000 + seq * 100,
  payload: value(JSON.stringify(payload))
})
const events = [
  event(1, "flows.engine.plan-recorded", {
    generation: 0,
    graph: {
      nodes: [
        { id: "root", kind: "FlowCall", tier: "sealed", action: "flow/run", dependsOn: [] },
        { id: "a", kind: "ActionCall", tier: "sealed", action: "flow/run/load", dependsOn: ["root"] },
        { id: "b", kind: "FlowCall", tier: "sealed", action: "flow/run/prompt", dependsOn: ["a"] }
      ],
      edges: [{ from: "root", to: "a", reason: "value" }, { from: "a", to: "b", reason: "continuation" }]
    }
  }),
  event(2, "flows.engine.node-scheduled", { nodeId: "a", kind: "ActionCall", attempt: 1 }),
  event(3, "flows.engine.node-settled", {
    nodeId: "a",
    outcome: "built",
    attempts: 1,
    result: { preview: "{\"loaded\":true}", bytes: 15, truncated: false }
  }),
  event(4, "flows.engine.node-scheduled", { nodeId: "b", kind: "FlowCall", attempt: 1 })
]
const page = (changes: Partial<Inspection> = {}, more: typeof events = []): RunPage => ({
  id: "r",
  state: "read",
  inspection: {
    run,
    steps: [],
    children: [],
    journal: { events, hasMore: false, nextSeq: 4, afterSeq: -1 },
    ...changes
  },
  more,
  hasMore: false
})
describe("read-only run graph", () => {
  test("a stopped run closes active steps and timers without rewriting historical replay", () => {
    const stopped = page({ run: { ...run, status: "cancelled", finishedAtMs: 1500 } })
    const live = graphOf(stopped, null, 100_000)
    expect(live.nodes.map((node) => node.state)).toEqual(["done", "cancelled"])
    expect(live.steps[1]!.row).toMatchObject({ state: "cancelled", endedAtMs: 1500 })
    expect(live.steps[1]!.attempts[0]).toMatchObject({ state: "cancelled", finishedAtMs: 1500 })
    expect(live.segments.at(-1)).toMatchObject({ state: "cancelled", endedAtMs: 1500 })
    expect(graphOf(stopped, 4, 100_000).steps[1]!.row).toMatchObject({ state: "running", endedAtMs: null })
    const noFinish = page({ run: { ...run, status: "failed" } })
    expect(graphOf(noFinish, null, 100_000).steps[1]!.row.endedAtMs).toBe(1400)
    const empty = page({ run: { ...run, status: "cancelled" }, journal: { events: [], afterSeq: -1, nextSeq: -1, hasMore: false } })
    expect(graphOf(empty, null, 100_000).steps).toEqual([])
    const retried = page({ run: { ...run, status: "cancelled", finishedAtMs: 1500 }, steps: [{
      nodeId: "b", action: "flow/run/prompt", kind: "FlowCall", status: "running", scheduledAtMs: 1400,
      settledAtMs: null, seq: 4, output: null, attempts: [
        { attempt: 1, state: "failed", startedAtMs: 1400, finishedAtMs: 1450, outcome: null, error: "unavailable" },
        { attempt: 2, state: "running", startedAtMs: 1460, finishedAtMs: null, outcome: null, error: null },
      ],
    }] })
    expect(graphOf(retried, null, 100_000).steps[1]!.attempts.map((a) => [a.state, a.finishedAtMs])).toEqual([
      ["failed", 1450], ["cancelled", 1500],
    ])
  })
  test("a personal flow names its reference; invalid, clipped and non-personal inputs keep their tag", () => {
    expect(runTitle(run)).toBe("daily")
    for (const text of ["bad", "null", "[]", "{}", "{\"name\":5}", "{\"name\":\"\"}"]) {
      expect(runTitle({ ...run, input: value(text) })).toBe("flow/run")
    }
    expect(runTitle({ ...run, input: value("{\"name\":\"secret\"}", true) })).toBe("flow/run")
    expect(runTitle({ ...run, flowName: "example" })).toBe("example")
  })
  test("one journal position drives graph states, data, edges and time without future output", () => {
    const live = graphOf(page(), null, 2000)
    expect(live.nodes.map((n) => [n.label, n.state])).toEqual([["daily/load", "done"], ["daily/prompt", "current"]])
    expect(live.edges).toEqual([{ from: "engine-node:r%3A0:a", to: "engine-node:r%3A0:b", kind: "continuation" }])
    expect(live.steps).toHaveLength(2)
    expect(live.steps[0]!.output?.text).toBe("{\"loaded\":true}")
    expect(live.time).toBe(2000)
    const replay = graphOf(page(), 2, 2000)
    expect(replay.nodes.map((n) => n.state)).toEqual(["current", "next"])
    expect(replay.steps[0]!.output).toBeNull()
    expect(replay.time).toBe(1200)
    expect(graphOf(page(), 0, 2000).nodes).toEqual([])
    expect(graphOf(page(), 0, 2000).time).toBe(1000)
  })
  test("same-named children keep their own recorded identity and data", () => {
    const child = (id: string, answer: string): Inspection => ({
      run: { ...run, runId: id, parentRunId: "r", flowName: "flow/run/prompt" },
      children: [],
      steps: [],
      journal: {
        events: [
          event(1, "flows.engine.plan-recorded", {
            graph: {
              nodes: [{ id: "work", kind: "ActionCall", tier: "sealed", action: "flow/run/agent", dependsOn: [] }]
            }
          }),
          event(2, "flows.engine.node-scheduled", { nodeId: "work", kind: "ActionCall", attempt: 1 }),
          event(3, "flows.engine.node-settled", {
            nodeId: "work",
            outcome: "built",
            attempts: 1,
            result: { preview: answer, bytes: answer.length, truncated: false }
          })
        ],
        afterSeq: -1,
        nextSeq: 3,
        hasMore: false
      }
    })
    const data = { ...page(), descendants: [child("child-a", "A"), child("child-b", "B")] }
    const live = graphOf(data, null, 2000)
    const children = live.steps.filter((step) => step.row.depth === 1)
    expect(children.map((step) => [step.href, step.output?.text])).toEqual([["/app/runs/child-a", "A"], [
      "/app/runs/child-b",
      "B"
    ]])
    expect(live.steps.find((step) => step.row.label === "daily/prompt")!.href).toBeNull()
    expect(graphOf(data, 1, 2000).steps.every((step) => step.output === null)).toBe(true)
  })
  test("More adds later events once; missing edge reasons remain unknown", () => {
    const last = event(5, "flows.engine.node-settled", { nodeId: "b", outcome: "failed", attempts: 1 })
    expect(graphOf(page({}, [last]), null, 2000).nodes[1]!.state).toBe("failed")
    expect(graphOf(page({}, [last, last]), 5, 2000).steps[1]!.attempts).toHaveLength(1)
    const corrupt = { ...events[0]!, payload: value("not-json") }
    const unreadable = page({ journal: { events: [corrupt], afterSeq: -1, hasMore: false, nextSeq: 1 } })
    expect(graphOf(unreadable, null, 2000).nodes).toEqual([])
  })
})

test("recorded attempt boundaries, wait metadata, clipped output and node logs honor replay time", () => {
  const waits = event(5, "flows.engine.node-settled", {
    nodeId: "b",
    outcome: "deferred",
    attempts: 1,
    stepKeyDigests: ["a".repeat(64)]
  })
  // The engine journals an attempt body's records annotated with the dispatch digest the node settles with.
  const log = event(6, "telemetry.log", {
    annotations: { runId: "r", stepKeyDigest: "a".repeat(64), attempt: 1 },
    message: "waiting"
  })
  const unrelated = event(7, "telemetry.log", {
    annotations: { runId: "r", stepKeyDigest: "b".repeat(64) },
    message: "other"
  })
  const fullOutput = value(JSON.stringify({ history: "x".repeat(3000), memoryDebug: { inserted: 1 } }))
  const clipped = event(8, "flows.engine.node-settled", {
    nodeId: "a",
    outcome: "built",
    attempts: 1,
    result: { preview: "{", bytes: fullOutput.bytes, truncated: true }
  })
  const inspection: Partial<Inspection> = {
    steps: [{
      nodeId: "a",
      action: "flow/run/load",
      kind: "ActionCall",
      status: "completed" as const,
      scheduledAtMs: 1200,
      settledAtMs: 1800,
      seq: 2,
      output: fullOutput,
      attempts: [
        { attempt: 1, state: "failed", startedAtMs: 1200, finishedAtMs: 1250, outcome: null, error: "unavailable" },
        { attempt: 2, state: "succeeded", startedAtMs: 1260, finishedAtMs: 1800, outcome: fullOutput, error: null }
      ]
    }],
    children: [{
      ...run,
      runId: "child",
      flowName: "flow/run/prompt",
      createdAtMs: 1350,
      input: value("\"in\""),
      result: null,
      waiting: { kind: "human", reason: "human", wakeAtMs: 4000 }
    }]
  }
  const live = graphOf(page(inspection, [waits, log, unrelated, clipped]), null, 2000)
  expect(live.steps[0]!.output).toEqual(inspection.steps![0]!.output)
  expect(JSON.parse(live.steps[0]!.output!.text).memoryDebug.inserted).toBe(1)
  expect(graphOf(page(inspection, [waits, log, unrelated, clipped]), 8, 2000).steps[0]!.output).toEqual({ text: "{", bytes: fullOutput.bytes, clipped: true })
  expect(live.steps[0]!.attempts.map((a) => a.state)).toEqual(["failed", "succeeded"])
  expect(live.steps[1]!.wait).toBeNull() // No current wait metadata leaks into a replayed node.
  expect(live.steps[1]!.logs).toEqual([log.payload])
  const repeated = event(9, "telemetry.log", {
    annotations: { runId: "r", stepKeyDigest: "a".repeat(64), attempt: 2 },
    message: "still waiting"
  })
  const invalid = event(10, "telemetry.log", {
    annotations: { runId: "r", stepKeyDigest: "" },
    message: "unattributed"
  })
  // A stored key is not the digest a node settles with, so it attributes nothing.
  const keyed = event(12, "telemetry.log", {
    annotations: { runId: "r", stepKey: `key1_${"a".repeat(64)}`, stepKeyDigest: 7 },
    message: "keyed"
  })
  const foreign = event(11, "telemetry.log", {
    annotations: { runId: "foreign", stepKeyDigest: "a".repeat(64) },
    message: "foreign"
  })
  expect(graphOf(page(inspection, [waits, log, repeated, invalid, foreign, keyed]), null, 3000).steps[1]!.logs).toEqual([
    log.payload,
    repeated.payload
  ])
  const replay = graphOf(page(inspection, [waits, log, unrelated, clipped]), 3, 2000)
  expect(replay.steps[0]!.attempts).toHaveLength(1) // Later attempt rows are not journal evidence at this cursor.
  expect(replay.steps[1]!.logs).toEqual([])
  const noGraph = event(9, "flows.engine.subgraph-appended", {
    graph: { edges: [{ from: "a", to: "b", reason: "bogus" }] }
  })
  expect(graphOf(page({ run: { ...run, flowName: "custom" } }, [noGraph]), null, 2000).nodes[0]!.label).toBe(
    "flow/run/load"
  )
  const plain = event(1, "flows.engine.plan-recorded", {
    graph: {
      nodes: [{ id: "x", kind: "ActionCall", tier: "sealed", dependsOn: [] }],
      edges: [{ from: "x", to: "x", reason: "failure" }]
    }
  })
  expect(
    graphOf(page({ journal: { events: [plain], afterSeq: -1, nextSeq: 1, hasMore: false } }), 1, 2000).nodes[0]!.state
  ).toBe("next")
})

test("a queued step is distinct from a branch the journal skipped", () => {
  expect(graphOf(page(), 2, 2000).steps[1]!.row.state).toBe("pending")
  const skipped = event(5, "flows.engine.node-settled", { nodeId: "b", outcome: "skipped", attempts: 1 })
  expect(graphOf(page({}, [skipped]), null, 2000).steps[1]!.row.state).toBe("skipped")
})

test("recorded sleep segments retain historical waits after the current run has moved on", () => {
  const state = (seq: number, eventBody: unknown) =>
    event(seq, "flows.engine.v2.state-event", {
      version: 2,
      executionId: "r",
      lineage: { kind: "root", runId: "r", rootRunId: "r", lineageId: "r", round: 0, parentRunId: null },
      event: eventBody
    })
  const clock = state(5, { _tag: "ClockScheduled", clockId: "clock", waitId: "sleep", dueAtMs: 9000 })
  const settled = state(6, { _tag: "DeferredCompleted", waitId: "sleep", result: { _tag: "Success", value: null } })
  const data = page({}, [clock, settled])
  const live = graphOf(data, null, 3000)
  expect(live.timeline.at(-1)!.row).toMatchObject({ kind: "sleep", startedAtMs: 1500, endedAtMs: 1600, depth: 1 })
  expect(live.segments.at(-1)!.state).toBe("waiting")
  const historical = graphOf(data, 5, 3000)
  expect(historical.timeline.at(-1)!.row).toMatchObject({ state: "waiting", endedAtMs: null })
  expect(graphOf(data, 4, 3000).timeline.some((step) => step.row.kind === "sleep")).toBe(false)
  const stopped = graphOf(page({ run: { ...run, status: "cancelled", finishedAtMs: 1700 } }, [clock]), null, 100_000)
  expect(stopped.timeline.at(-1)!.row).toMatchObject({ state: "cancelled", endedAtMs: 1700 })
  expect(stopped.timeline.at(-1)!.wait).toBeNull()
  expect(stopped.segments.at(-1)).toMatchObject({ state: "cancelled", endedAtMs: 1700 })
})

test("same-millisecond settlements never disclose an attempt before its journal event", () => {
  const sameTime = events.map((e) => ({ ...e, emittedAtMs: 1200 }))
  const read = page({
    journal: { events: sameTime, afterSeq: -1, nextSeq: 4, hasMore: false },
    steps: [{
      nodeId: "a",
      action: "flow/run/load",
      kind: "ActionCall",
      status: "failed",
      scheduledAtMs: 1200,
      settledAtMs: 1200,
      seq: 3,
      output: value("\"future\""),
      attempts: [{
        attempt: 1,
        state: "failed",
        startedAtMs: 1200,
        finishedAtMs: 1200,
        outcome: null,
        error: "FutureFailure"
      }]
    }]
  })
  const shown = graphOf(read, 2, 1200).steps[0]!
  expect(shown.row.state).toBe("running")
  expect(shown.output).toBeNull()
  expect(shown.attempts[0]).toMatchObject({ state: "running", error: null, finishedAtMs: null })
})

test("native agent cells become nested timeline rows with recorded source and logs", () => {
  const digest = "a".repeat(64)
  const fact = (seq: number, kind: string, payload: unknown) =>
    event(seq, "flows.harness.step-fact.v1", {
      version: 1,
      generation: 0,
      frame: 0,
      ordinal: seq,
      cell: "",
      at: 1000 + seq * 100,
      eventType: kind,
      sourceSequence: seq,
      payload,
      step: { stepId: digest, executionId: "r", action: "flow/run/load", attempt: 1, ask: 0, retry: 1, scope: "scope" }
    })
  const cells = [
    fact(5, "control.agent.turn-opened", { seat: "agent" }),
    fact(6, "control.agent.model-requested", { task: "{\"answer\":42}", messages: [] }),
    fact(7, "control.agent.cell-produced", { text: "console.log(42)", language: "javascript", digest: "c" }),
    fact(8, "control.agent.cell-printed", { cell: "c", text: "42" }),
    fact(9, "control.agent.cell-settled", { outcome: "success" }),
    event(10, "flows.engine.node-settled", {
      nodeId: "a",
      outcome: "built",
      attempts: 1,
      stepKeyDigests: [digest],
      result: { preview: "42", bytes: 2, truncated: false }
    })
  ]
  const live = graphOf(page({}, cells), null, 3000)
  expect(live.timeline.some((step) => step.row.kind === "cell" && step.row.depth > 0)).toBe(true)
  const cell = live.timeline.find((step) => step.row.kind === "cell")!
  expect(cell.input?.text).toBe("console.log(42)")
  expect(cell.logs?.[0]?.text).toBe("42")
  expect(live.steps[0]!.logs?.map((value) => value.text)).toContain("42")
  expect(live.steps[0]!.input?.text).toBe("{\"answer\":42}")
  const active = graphOf(page({ run: { ...run, status: "completed" } }, cells), 7, 3000).timeline.find((step) =>
    step.row.kind === "cell"
  )!
  expect(active.row).toMatchObject({ state: "running", endedAtMs: null })
  expect(active.logs).toEqual([])
  const failed = graphOf(
    page({}, [
      ...cells,
      fact(11, "control.agent.cell-produced", {}),
      fact(12, "control.agent.cell-settled", { outcome: "failure" })
    ]),
    null,
    3000
  ).timeline.filter((step) => step.row.kind === "cell").at(-1)!
  expect(failed.row.state).toBe("failed")
  expect(failed.input).toBeNull()
})

test("replay uses only recorded attempt spans, including completed, failed and open attempts", () => {
  const digests = ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
  const start = (seq: number, key: string, attempt: number) =>
    event(seq, "flows.engine.attempt-started", { runId: "r", stepKeyDigest: key, attempt, tier: "sealed" })
  const finish = (seq: number, key: string, attempt: number, state: string) =>
    event(seq, "flows.engine.attempt-finished", { runId: "r", stepKeyDigest: key, attempt, state })
  const recorded = [
    start(5, digests[0]!, 1),
    finish(6, digests[0]!, 1, "failed"),
    start(7, digests[1]!, 2),
    finish(8, digests[1]!, 2, "succeeded"),
    start(9, digests[2]!, 3),
    event(10, "flows.engine.node-settled", { nodeId: "a", outcome: "deferred", attempts: 3, stepKeyDigests: digests }),
    start(11, "d".repeat(64), 4)
  ]
  const shown = graphOf(page({}, recorded), 11, 3000).steps[0]!
  expect(shown.attempts.map((a) => [a.attempt, a.state, a.error])).toEqual([[1, "failed", "failed"], [
    2,
    "completed",
    null
  ], [3, "running", null]])
  expect(shown.attempts[2]!.finishedAtMs).toBeNull()
  const pending = {
    nodeId: "a",
    action: "load",
    kind: "ActionCall",
    status: "running" as const,
    scheduledAtMs: 1200,
    settledAtMs: null,
    seq: 2,
    output: null,
    attempts: [{ attempt: 1, state: "running", startedAtMs: 1200, finishedAtMs: null, outcome: null, error: null }, {
      attempt: 2,
      state: "running",
      startedAtMs: 5000,
      finishedAtMs: null,
      outcome: null,
      error: null
    }]
  }
  expect(graphOf(page({ steps: [pending] }), null, 2000).steps[0]!.attempts).toHaveLength(2) // Live facts do not depend on a lagging presentation clock.
})

test("attempts with the same digest remain isolated by child execution and generation", () => {
  const digest = "a".repeat(64)
  const child = (id: string, attempt: number): Inspection => ({
    run: { ...run, runId: id, parentRunId: "r" },
    children: [],
    steps: [],
    journal: {
      afterSeq: -1,
      nextSeq: 4,
      hasMore: false,
      events: [
        event(1, "flows.engine.plan-recorded", {
          generation: 0,
          graph: { nodes: [{ id: "a", kind: "ActionCall", tier: "sealed", action: "work", dependsOn: [] }] }
        }),
        event(2, "flows.engine.node-scheduled", { nodeId: "a", kind: "ActionCall", attempt: 1 }),
        event(3, "flows.engine.attempt-started", { runId: id, stepKeyDigest: digest, attempt, tier: "sealed" }),
        event(4, "flows.engine.node-settled", {
          nodeId: "a",
          outcome: "deferred",
          attempts: 1,
          stepKeyDigests: [digest]
        }),
        event(5, "flows.engine.plan-recorded", {
          generation: 1,
          graph: { nodes: [{ id: "other", kind: "ActionCall", tier: "sealed", action: "other", dependsOn: [] }] }
        }),
        event(6, "flows.engine.attempt-started", { runId: id, stepKeyDigest: digest, attempt: 9, tier: "sealed" })
      ]
    }
  })
  const data = { ...page(), descendants: [child("one", 1), child("two", 2)] }
  const replay = graphOf(data, 100, 3000)
  const attempts = replay.steps.filter((step) => step.row.label === "work").map((
    step
  ) => [step.href, step.attempts.map((a) => a.attempt)])
  expect(attempts).toEqual([["/app/runs/one", [1]], ["/app/runs/two", [2]]])
})

test("inspector kinds use product words", () => {
  const data = page({
    steps: [{
      nodeId: "b",
      action: "flow/run/prompt",
      kind: "FlowCall",
      status: "running",
      scheduledAtMs: 1400,
      settledAtMs: null,
      seq: 4,
      output: null,
      attempts: []
    }]
  })
  expect(graphOf(data, null, 3000).steps.map((step) => step.row.kind)).toEqual(["Step", "Flow"])
})

test("complete journal results retain debug fields instead of sealed outcome metadata", () => {
  const sealed = value(JSON.stringify({ _tag: "Success", value: { verdicts: ["yes"] } }))
  const data = page({ steps: [{
    nodeId: "a", action: "flow/run/load", kind: "ActionCall", status: "completed",
    scheduledAtMs: 1200, settledAtMs: 1300, seq: 3, output: sealed, attempts: []
  }] })
  expect(graphOf(data, null, 2000).steps[0]!.output).toEqual(value('{"loaded":true}'))
  expect(graphOf(data, 3, 2000).steps[0]!.output).toEqual(value('{"loaded":true}'))
  const missing = page({ ...data.inspection!, journal: { events: events.map((e) => e.seq === 3
    ? event(3, "flows.engine.node-settled", { nodeId: "a", outcome: "built", attempts: 1 }) : e),
    afterSeq: -1, nextSeq: 4, hasMore: false } })
  expect(graphOf(missing, null, 2000).steps[0]!.output).toEqual(sealed)
  expect(graphOf({ ...missing, inspection: { ...missing.inspection!, steps: [] } }, null, 2000).steps[0]!.output).toBeNull()
})
