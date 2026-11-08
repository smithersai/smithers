import { Model, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { ContextPreflight } from "@smthrs/rpc"
import { Effect, Stream } from "effect"
import { expect, test } from "vitest"
import { runContextPreflight } from "./fixtures/durable.ts"
import { providerRequest } from "./fixtures/durable.ts"

const input: ContextPreflight.ContextPreflightInput = {
  prompt: "where do we retry webhooks?",
  author: "ben",
  branch: "main",
  state: "synced",
  recent: Array.from({ length: 500 }, (_, i) => ({ title: `Shared ${i}`, text: `shared-${i}` })),
  candidates: [
    {
      item: { kind: "file", label: "retry.ts", ref: "src/webhooks/retry.ts", revision: "abc123" },
      text: "export const retry = 3"
    },
    { item: { kind: "page", label: "Retries", ref: "retries", revision: "4" }, text: "Retry webhooks three times" },
    { item: { kind: "todo", label: "T10", ref: "T10", revision: "2" }, text: "Improve webhook retries" },
    { item: { kind: "run", label: "T10 run", ref: "run-10", revision: "1" }, text: "Webhook retry test passed" }
  ],
  tokenBudget: 24000,
  wikiOnly: false
}
const fake = (output: string, requests: ModelRequest.ModelRequest[]) =>
  Model.make({
    stream: (request) => {
      requests.push(request)
      return Stream.fromIterable([
        { type: "text-delta" as const, id: "s", text: output },
        { type: "settle" as const, stopReason: "stop" as const }
      ])
    }
  })

test("one fast call selects pinned data and the production request excludes the other 497 texts", async () => {
  const requests: ModelRequest.ModelRequest[] = []
  // Recall's literal ranking: file, page, run, TODO (ties by key).
  const answer = await Effect.runPromise(
    runContextPreflight(input, fake("[{\"index\":0,\"reason\":\"Retry implementation\"}]", requests), {
      modelId: "owner-fast"
    })
  )
  expect(requests).toHaveLength(1)
  expect(answer.result.context).toEqual([{
    kind: "file",
    label: "retry.ts",
    ref: "src/webhooks/retry.ts",
    revision: "abc123",
    reason: "Retry implementation"
  }])
  expect(answer.result.model).toBe("owner-fast")
  expect(answer.result.durationMs).toBeGreaterThanOrEqual(0)
  expect(answer.messages).toEqual([
    { role: "assistant", content: "shared-497" },
    { role: "assistant", content: "shared-498" },
    { role: "assistant", content: "shared-499" },
    { role: "user", content: "where do we retry webhooks?" }
  ])
  const request = providerRequest({
    runId: "r",
    instructions: "Answer",
    messages: answer.messages,
    selectedContext: answer.selectedContext
  }, { modelId: "coding" })
  expect(request.system[0]?.text).toBe(
    "Answer\n\nSelected context:\n[{\"item\":{\"kind\":\"file\",\"label\":\"retry.ts\",\"ref\":\"src/webhooks/retry.ts\",\"revision\":\"abc123\",\"reason\":\"Retry implementation\"},\"text\":\"export const retry = 3\"}]"
  )
  expect(JSON.stringify(request)).not.toContain("\"shared-496\"")
  expect(JSON.stringify(request)).not.toContain("Retry webhooks three times")
})

test.each([0, 159, 160])("whole-item conservative token budget %i", async (budget) => {
  const candidate = input.candidates[0]!
  const answer = await Effect.runPromise(
    runContextPreflight(
      { ...input, candidates: [candidate], tokenBudget: budget },
      fake("[{\"index\":0,\"reason\":\"Retry implementation\"}]", []),
      { modelId: "coding-fallback" }
    )
  )
  // Independently committed JSON rendering above is 159 UTF-8 bytes plus a conservative separator byte.
  expect(answer.result.context).toHaveLength(budget < 160 ? 0 : 1)
  expect(answer.result.model).toBe("coding-fallback")
})

test("wiki-only recall excludes files, TODOs and runs and pins page revision", async () => {
  const requests: ModelRequest.ModelRequest[] = []
  const answer = await Effect.runPromise(
    runContextPreflight({ ...input, wikiOnly: true }, fake("[{\"index\":0,\"reason\":\"Wiki policy\"}]", requests), {
      modelId: "fast"
    })
  )
  expect(answer.result.context).toEqual([{
    kind: "page",
    label: "Retries",
    ref: "retries",
    revision: "4",
    reason: "Wiki policy"
  }])
  expect(JSON.stringify(requests)).not.toContain("src/webhooks/retry.ts")
  expect(JSON.stringify(requests)).not.toContain("run-10")
})

test.each([
  "[{\"index\":0}]",
  "[{\"index\":99,\"reason\":\"unknown\"}]",
  "not JSON",
  "[{\"index\":0,\"reason\":\"\"}]"
])("invalid selection refuses %s", async (output) => {
  await expect(Effect.runPromise(runContextPreflight(input, fake(output, []), { modelId: "fast" }))).rejects.toThrow()
})

test("usage before and after settlement preserves the selected pinned context", async () => {
  const model = Model.make({
    stream: () =>
      Stream.fromIterable<ModelEvent.ModelEvent>([
        { type: "usage", inputTokens: 7 },
        { type: "text-delta", id: "s", text: "[{\"index\":0,\"reason\":\"Retry implementation\"}]" },
        { type: "settle", stopReason: "stop" },
        { type: "usage", inputTokens: 7, outputTokens: 5 }
      ])
  })
  const answer = await Effect.runPromise(runContextPreflight(input, model, { modelId: "fast" }))
  expect(answer.result.context).toEqual([{
    kind: "file",
    label: "retry.ts",
    ref: "src/webhooks/retry.ts",
    revision: "abc123",
    reason: "Retry implementation"
  }])
  expect(answer.selectedContext[0]?.text).toBe("export const retry = 3")
})

test("new context items require label and reason", () => {
  expect(ContextPreflight.SelectedContextItemSchema.safeParse({ kind: "file", ref: "a.ts", reason: "Read" }).success)
    .toBe(false)
  expect(ContextPreflight.SelectedContextItemSchema.safeParse({ kind: "file", ref: "a.ts", label: "a.ts" }).success)
    .toBe(false)
})

test.each(
  [
    {
      name: "settled before JSON",
      events: [
        { type: "settle", stopReason: "stop" },
        { type: "text-delta", id: "s", text: "[]" }
      ]
    },
    {
      name: "text after settlement",
      events: [
        { type: "text-delta", id: "s", text: "[]" },
        { type: "settle", stopReason: "stop" },
        { type: "text-delta", id: "s", text: " " }
      ]
    },
    {
      name: "tool call hidden beside JSON",
      events: [
        { type: "tool-call-start", id: "tool", name: "shell" },
        { type: "text-delta", id: "s", text: "[]" },
        { type: "settle", stopReason: "stop" }
      ]
    },
    {
      name: "duplicate settlement",
      events: [
        { type: "text-delta", id: "s", text: "[]" },
        { type: "settle", stopReason: "stop" },
        { type: "settle", stopReason: "stop" }
      ]
    },
    { name: "interrupted JSON", events: [{ type: "text-delta", id: "s", text: "[]" }] },
    {
      name: "length limited JSON",
      events: [
        { type: "text-delta", id: "s", text: "[]" },
        { type: "settle", stopReason: "length" }
      ]
    }
  ] as const
)("preflight refuses $name", async ({ events }) => {
  const model = Model.make({ stream: () => Stream.fromIterable<ModelEvent.ModelEvent>(events) })
  const failure = await Effect.runPromise(runContextPreflight(input, model, { modelId: "fast" }).pipe(Effect.flip))
  expect(failure).toMatchObject({ code: "invalid_provider_output" })
})

test("invalid host context refuses before invoking a model", async () => {
  const requests: ModelRequest.ModelRequest[] = []
  await expect(
    Effect.runPromise(runContextPreflight({ ...input, tokenBudget: -1 }, fake("[]", requests), { modelId: "fast" }))
  ).rejects.toThrow()
  expect(requests).toEqual([])
})

test("selector output is bounded and duplicate choices retain their first reason", async () => {
  await expect(Effect.runPromise(runContextPreflight(input, fake(" ".repeat(65536), []), { modelId: "fast" }))).rejects
    .toThrow()
  const answer = await Effect.runPromise(
    runContextPreflight(input, fake("[{\"index\":0,\"reason\":\"First\"},{\"index\":0,\"reason\":\"Other\"}]", []), {
      modelId: "fast"
    })
  )
  expect(answer.selectedContext).toEqual([{
    ...input.candidates[0],
    item: { ...input.candidates[0]!.item, reason: "First" }
  }])
})

test.each([65532, 65533])("selector limit includes a buffered credential-prefix suffix (%i)", async (padding) => {
  // Whitespace is valid after JSON. The cutter retains the potential secret
  // prefix until settle, so the final flush must count toward the limit too.
  const result = await Effect.runPromise(
    runContextPreflight(input, fake("[]" + " ".repeat(padding), []), {
      modelId: "fast",
      credential: " ".repeat(32) + "x"
    }).pipe(Effect.result)
  )
  if (padding === 65532) {
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") expect(result.success.selectedContext).toEqual([])
  } else {
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure).toMatchObject({ code: "invalid_provider_output" })
  }
})

test("subscription fallback selects context without sending an unsupported output-token limit", async () => {
  const requests: ModelRequest.ModelRequest[] = []
  const answer = await Effect.runPromise(
    runContextPreflight(input, fake("[{\"index\":0,\"reason\":\"Retry implementation\"}]", requests), {
      modelId: "subscription-coding",
      outputTokenLimitSupported: false
    })
  )
  expect(requests).toHaveLength(1)
  expect(requests[0]?.params.maxTokens).toBeUndefined()
  expect(answer.result.model).toBe("subscription-coding")
  expect(answer.result.context[0]?.ref).toBe("src/webhooks/retry.ts")
})
