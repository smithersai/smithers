import * as AgentEvents from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import { Option, type Schema } from "effect"
import { expect, it } from "vitest"
import * as Projection from "../src/Projection.ts"
import * as Protocol from "../src/Protocol.ts"

const ctx = { directory: "/repo", now: () => 1000 }
const states = Array.from({ length: 20 }, (_, i) => i + 1)
const open = () =>
  Projection.open(ctx, {
    session: {
      id: "ses_batch",
      slug: "batch",
      projectID: "p",
      directory: "/repo",
      path: "",
      title: "Batch",
      version: "test",
      agent: "smithers",
      model: { id: "demo", providerID: "scripted" },
      cost: 0,
      tokens: Protocol.noTokens,
      time: { created: 1000, updated: 1000 }
    },
    userMessageID: "msg_user",
    userPartID: "prt_user",
    assistantMessageID: "msg_assistant",
    prompt: "Classify twenty states",
    agent: "smithers",
    model: { providerID: "scripted", modelID: "demo" }
  })

const call = (value: Schema.Json) => {
  const identity = new Cell.CallIdentity({
    session: "ses_batch",
    frame: 0,
    cell: "cell",
    ordinal: 0,
    declaration: "d",
    layers: []
  })
  const started = new AgentEvents.CellCallStarted({
    eventType: "flows.harness.cell-call-started.v1",
    call: new Cell.Call({
      flowName: "classify",
      input: { states, questions: { even: { type: "boolean", instructions: "Is it even?" } } },
      capabilities: [],
      effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
      placement: Option.none(),
      identity
    })
  })
  const settled = new AgentEvents.CellCallSettled({
    eventType: "flows.harness.cell-call-settled.v1",
    flowName: "classify",
    identity,
    result: new Cell.CallResult({ outcome: "success", value })
  })
  return { started, settled }
}

it("counts every evaluation in a classify batch exactly once across replay", () => {
  const { started, settled } = call({
    results: states.map((state) => ({
      ok: true,
      state,
      answers: { even: { value: state % 2 === 0, probability: 0.99 } },
      confidence: { even: 0.98 }
    })),
    latencyMs: 400,
    usage: { inputTokens: 10_000, outputTokens: 0 }
  })
  let state = open().state
  for (let replay = 0; replay < 2; replay++) {
    state = Projection.fold(ctx, state, started).state
    state = Projection.fold(ctx, state, settled).state
    expect(state.summary).toMatchObject({ classifyCalls: 1, jevCalls: 20, jevLatencyMs: 400 })
    expect(state.summary.jevCost).toBeCloseTo(0.00042, 8)
  }
})

it.each([
  null,
  { usage: { inputTokens: 10_000 } },
  { usage: { outputTokens: 0 } }
])("renders a legacy classify result with no complete usage receipt: %j", (value) => {
  const { started, settled } = call(value)
  const running = Projection.fold(ctx, open().state, started)
  const projected = Projection.fold(ctx, running.state, settled)
  expect(projected.state.summary.jevCost).toBe(0)
  expect(projected.events[0]?.properties["part"]).toMatchObject({ type: "tool", state: { status: "completed" } })
})
