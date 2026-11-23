import { ModelRequest } from "@smthrs/model/ModelRequest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { describe, test } from "vitest"
import { firstDivergence } from "../src/Divergence.ts"
import type { JournalEntryLike } from "../src/EngineSubject.ts"
import * as Fixture from "../src/Fixture.ts"
import { expectJournal } from "../src/JournalAssertions.ts"
import type { ModelRequestLike } from "../src/ModelLike.ts"
import * as ScriptedModel from "../src/ScriptedModel.ts"

const sampleRequestLike: ModelRequestLike = {
  modelId: "openai:gpt-5-mini",
  system: [{ type: "text", text: "You are a thorough code reviewer checking invariants." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Review PR #4821 across 12 modified files." }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", id: "call-1", name: "read_file", arguments: "{\"path\":\"src/index.ts\"}" }],
      stopReason: "tool-calls"
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-1", content: "export const ok = true", addedToolNames: [] }]
    }
  ],
  tools: [
    {
      name: "read_file",
      description: "Read a workspace file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "write_file",
      description: "Write a workspace file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"]
      }
    }
  ],
  params: { temperature: 0, maxTokens: 2048 }
}

const rawFixture = {
  calls: Array.from({ length: 20 }, (_, index) => ({
    request: {
      ...sampleRequestLike,
      messages: [
        ...sampleRequestLike.messages,
        { role: "user" as const, content: [{ type: "text" as const, text: `Turn ${index}` }] }
      ]
    },
    model: "openai:gpt-5-mini",
    events: [
      { type: "text-start", id: `t-${index}` },
      { type: "text-delta", id: `t-${index}`, text: `Answer for turn ${index}` },
      { type: "text-end", id: `t-${index}` },
      { type: "settle", stopReason: "stop" }
    ]
  }))
}

const scriptedRequest = ModelRequest.make({
  modelId: "m",
  system: [{ type: "text", text: "Bench assistant." }],
  messages: [{ role: "user", content: [{ type: "text", text: "please summarize status" }] }],
  tools: [{ name: "read_file", description: "Read", parameters: {} }],
  params: {}
})

const scriptedModel = ScriptedModel.make({
  script: ScriptedModel.fromTurns([
    {
      name: "summarize",
      when: (req) => ScriptedModel.transcript(req).some((message) => message.content.includes("summarize")),
      reply: () => "All checks are green and latency is within budget."
    }
  ])
})

const journalLeft: ReadonlyArray<JournalEntryLike> = Array.from({ length: 200 }, (_, index) => ({
  index,
  stepKey: `step-${index}`,
  kind: index % 4 === 0 ? "effect" : "step",
  outcome: "completed",
  value: { idempotencyKey: `idem-${index}`, count: index }
}))

const journalRight: ReadonlyArray<JournalEntryLike> = journalLeft.map((entry, index) =>
  index === 190 ? { ...entry, value: { idempotencyKey: "idem-190", count: 999 } } : entry
)

describe("@smthrs/testing", () => {
  test("Fixture.canonicalRequestDigest (multi-turn + tool schemas)", async ({ bench }) => {
    await bench("Fixture.canonicalRequestDigest", () => {
      Fixture.canonicalRequestDigest(sampleRequestLike)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Fixture.decode + Fixture.index (20 recorded calls)", async ({ bench }) => {
    await bench("Fixture.decode + index x20", async () => {
      const decoded = await Effect.runPromise(Fixture.decode(rawFixture))
      Fixture.index(decoded)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("ScriptedModel.stream (turn match + event stream)", async ({ bench }) => {
    const program = Stream.runDrain(scriptedModel.stream(scriptedRequest))
    await bench("ScriptedModel.stream", async () => {
      await Effect.runPromise(program)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("JournalAssertions + Divergence.firstDivergence (200 entries)", async ({ bench }) => {
    const assertion = expectJournal(journalLeft)
    const program = Effect.gen(function*() {
      yield* assertion.executed("step-199")
      yield* assertion.executedInOrder(["step-0", "step-50", "step-100", "step-199"])
      yield* assertion.effect("step-120").idempotencyKey("idem-120")
      return firstDivergence(journalLeft, journalRight)
    })
    await bench("JournalAssertions + firstDivergence 200", async () => {
      await Effect.runPromise(program)
    }).run({ time: 120, warmupTime: 30 })
  })
})
