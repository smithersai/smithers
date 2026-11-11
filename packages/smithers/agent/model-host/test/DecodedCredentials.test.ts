import { Model, ModelError, type ModelEvent } from "@smthrs/model"
import type { NativeAgent } from "@smthrs/rpc"
import { Effect, Stream } from "effect"
import { HttpEffect } from "effect/http"
import { expect, test } from "vitest"
import { durableModelStream } from "../src/DurableModelCall.ts"
import { cutCredentialJson } from "../src/internal/CredentialJson.ts"
import { StreamingCredentialCutter } from "../src/StreamingCredentialCutter.ts"
import {
  createModelTurnHandler,
  fixtureRoute,
  inFlow,
  MODEL_HOST_CONTEXT_SELECT_PATH,
  providerRequest,
  runContextPreflight,
  runModelTurn
} from "./fixtures/durable.ts"

const primary = "sk-fixture-credential-1234"
const fallback = "sk-fallback-credential-5678"
const access = "subscription-access-token"
const account = "subscription-account-id"
const credentials = [primary, fallback, access, account]
const options = {
  modelId: "selector",
  credential: primary,
  fallbacks: [{
    model: Model.make({ stream: () => Stream.die("unused fallback") }),
    route: fixtureRoute,
    modelId: "backup",
    credential: fallback,
    additionalCredentials: [JSON.stringify({ accessToken: access, accountId: account })]
  }]
}
const input = {
  prompt: "Find policy",
  author: "owner",
  branch: "main",
  state: "synced",
  recent: [],
  candidates: [{ item: { kind: "page" as const, label: "Policy", ref: "policy", revision: "1" }, text: "Policy" }],
  tokenBudget: 24000,
  wikiOnly: false
}
const turn: NativeAgent.StartAgentTurnRequest = { runId: "decoded-credentials", instructions: "Answer", messages: [] }
const unicode = (text: string) =>
  Array.from(text, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("")
const chunked = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size))

test.each([1, 3, 10000])(
  "decoded context reasons remove all route credentials before budgeting (chunks %i)",
  async (size) => {
    const reason = "Relevant " + credentials.map(unicode).join(" / ")
    const output = `[{"index":0,"reason":"${reason}"},{"index":0,"reason":"Ignored"}]`
    const model = Model.make({
      stream: () =>
        Stream.fromIterable<ModelEvent.ModelEvent>([
          ...chunked(output, size).map((text) => ({ type: "text-delta" as const, id: "selection", text })),
          { type: "settle", stopReason: "stop" }
        ])
    })
    // Enough for the sanitized reason, too little for any decoded credential.
    const safe = { ...input.candidates[0]!, item: { ...input.candidates[0]!.item, reason: "Relevant  /  /  / " } }
    const tokenBudget = 3 + new TextEncoder().encode(JSON.stringify(safe)).byteLength
    const answer = await Effect.runPromise(runContextPreflight({ ...input, tokenBudget }, model, options))
    expect(answer.selectedContext).toEqual([safe])
    expect(answer.result.context).toEqual([safe.item])
    const request = providerRequest({ ...turn, selectedContext: answer.selectedContext }, { modelId: "answer" })
    for (const secret of credentials) {
      expect(JSON.stringify(answer)).not.toContain(secret)
      expect(JSON.stringify(request)).not.toContain(secret)
    }
  }
)

test("a reason consisting entirely of an escaped credential is refused", async () => {
  const model = Model.make({
    stream: () =>
      Stream.fromIterable<ModelEvent.ModelEvent>([
        { type: "text-delta", id: "selection", text: `[{"index":0,"reason":"${unicode(primary)}"}]` },
        { type: "settle", stopReason: "stop" }
      ])
  })
  const failure = await Effect.runPromise(runContextPreflight(input, model, options).pipe(Effect.flip))
  expect(failure).toMatchObject({ code: "invalid_provider_output" })
  expect(JSON.stringify(failure)).not.toContain(primary)
})

test.each([false, true])(
  "decoded tool arguments are safe in frames, held calls and durable events (replacement %s)",
  async (replacement) => {
    const raw = `{ "${unicode(primary)}": [{"value":"${unicode(fallback)}","access":"${unicode(access)}","account":"${
      unicode(account)
    }","safe":"ok","count":1e2,"nothing":null}] }`
    const expected = { "": [{ value: "", access: "", account: "", safe: "ok", count: 100, nothing: null }] }
    const events: ModelEvent.ModelEvent[] = [
      { type: "tool-call-start", id: "call", name: "inspect" },
      ...chunked(raw, 1).map((arguments_) => ({ type: "tool-call-delta" as const, id: "call", arguments: arguments_ })),
      { type: "tool-call-end", id: "call", ...(replacement ? { arguments: raw } : {}) },
      { type: "settle", stopReason: "tool-calls" }
    ]
    const model = Model.make({ stream: () => Stream.fromIterable(events) })
    const frames: NativeAgent.AgentTurnFrame[] = []
    await Effect.runPromise(runModelTurn(model, turn, options, (frame) =>
      Effect.sync(() => {
        frames.push(frame)
      })))
    const frame = frames.find((value) => value.type === "tool_call")!
    expect(frame.type).toBe("tool_call")
    if (frame.type === "tool_call") expect(JSON.parse(frame.arguments)).toEqual(expected)
    const held = await Effect.runPromise(
      runModelTurn(model, turn, options, () => Effect.die("held call was published"), { usage: undefined })
    )
    expect(JSON.parse(held!.calls[0]!.arguments)).toEqual(expected)
    const recorded = await Effect.runPromise(inFlow(Stream.runCollect(durableModelStream("decoded-tool", {
      model,
      modelId: "selector",
      route: fixtureRoute,
      credential: primary,
      additionalCredentials: [fallback, JSON.stringify({ accessToken: access, accountId: account })]
    }, providerRequest(turn, options)))))
    const end = recorded.find((event) => event.type === "tool-call-end")!
    expect(end.type).toBe("tool-call-end")
    if (end.type === "tool-call-end") {
      const arguments_ = end.arguments ??
        recorded.filter((event) => event.type === "tool-call-delta").map((event) => event.arguments).join("")
      expect(JSON.parse(arguments_)).toEqual(expected)
    }
    expect(JSON.stringify(recorded)).not.toContain(unicode(primary).replaceAll("\\", "\\\\"))
    expect(JSON.stringify(recorded)).not.toContain(unicode(fallback).replaceAll("\\", "\\\\"))
  }
)

test("the context selection HTTP response cuts a partially escaped credential", async () => {
  const model = Model.make({
    stream: () =>
      Stream.fromIterable<ModelEvent.ModelEvent>([
        {
          type: "text-delta",
          id: "selection",
          text: "[{\"index\":0,\"reason\":\"Relevant \\u0073k-fixture-credential-1234\"}]"
        },
        { type: "settle", stopReason: "stop" }
      ])
  })
  const handler = HttpEffect.toWebHandler(createModelTurnHandler({
    authorization: "fixture-host",
    callbackBaseUrl: "http://callback.test",
    resolve: (_grant, selection) =>
      Effect.succeed({
        model,
        options,
        preflight: { model, options, input: selection! }
      })
  }))
  const response = await handler(
    new Request("http://host.test" + MODEL_HOST_CONTEXT_SELECT_PATH, {
      method: "POST",
      headers: { authorization: "Bearer fixture-host", "content-type": "application/json" },
      body: JSON.stringify({ runId: turn.runId, ownerId: 1, instructions: "", messages: [], contextSelection: input })
    })
  )
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.context).toEqual([{ ...input.candidates[0]!.item, reason: "Relevant " }])
  expect(JSON.stringify(result)).not.toContain(primary)
})

test.each([
  [" { \"value\": \"\\u0073ecret\", \"n\": 1e2 } ", " { \"value\": \"\", \"n\": 1e2 } "],
  [
    "{\"\\u0073ecret\":[\"before secret after\",true,null,{\"safe\":\"a\\\\b\\\"c\"}]}",
    "{\"\":[\"before  after\",true,null,{\"safe\":\"a\\\\b\\\"c\"}]}"
  ],
  ["\"sec\\u0072et\"", "\"\""],
  ["{\"value\":\"secsecretret\"}", "{\"value\":\"\"}"],
  ["{\"value\":\"unchanged\\u0021\"}", "{\"value\":\"unchanged\\u0021\"}"],
  ["{\"value\":\"secret\"", "{\"value\":\"\""],
  ["[]", "[]"],
  ["null", "null"]
])("JSON cuts preserve argument structure and validation for %s", (raw, expected) => {
  const cut = (value: string) => {
    const cutter = new StreamingCredentialCutter("secret")
    return cutter.push(value) + cutter.finish()
  }
  expect(cutCredentialJson(raw, cut)).toBe(expected)
})

test("a selected fallback cuts escaped primary and subscription credentials from reasons", async () => {
  const model = Model.make({
    stream: () =>
      Stream.fromIterable<ModelEvent.ModelEvent>([
        {
          type: "text-delta",
          id: "selection",
          text: "[{\"index\":0,\"reason\":\"Relevant " + credentials.map(unicode).join(" / ") + "\"}]"
        },
        { type: "settle", stopReason: "stop" }
      ])
  })
  const primaryModel = Model.make({
    stream: () =>
      Stream.fail(
        new ModelError.ModelError({
          code: "authentication",
          message: "unavailable"
        })
      )
  })
  const answer = await Effect.runPromise(runContextPreflight(input, primaryModel, {
    ...options,
    fallbacks: [{ ...options.fallbacks[0]!, model }]
  }))
  expect(answer.result.context[0]?.reason).toBe("Relevant  /  /  / ")
})

test("credentialless fallback routes preserve the primary credential cuts", async () => {
  const model = Model.make({
    stream: () =>
      Stream.fromIterable<ModelEvent.ModelEvent>([
        {
          type: "text-delta",
          id: "selection",
          text: "[{\"index\":0,\"reason\":\"Relevant " + unicode(primary) + "\"}]"
        },
        { type: "settle", stopReason: "stop" }
      ])
  })
  const fallbacks = [{ model, modelId: "public", route: fixtureRoute }]
  const answer = await Effect.runPromise(runContextPreflight(input, model, { ...options, fallbacks }))
  expect(answer.result.context[0]?.reason).toBe("Relevant ")
  const tool = Model.make({
    stream: () =>
      Stream.fromIterable<ModelEvent.ModelEvent>([
        { type: "tool-call-start", id: "call", name: "inspect" },
        { type: "tool-call-end", id: "call", arguments: "{\"value\":\"" + unicode(primary) + "\"}" },
        { type: "settle", stopReason: "tool-calls" }
      ])
  })
  const held = await Effect.runPromise(
    runModelTurn(tool, turn, { ...options, fallbacks }, () => Effect.void, { usage: undefined })
  )
  expect(JSON.parse(held!.calls[0]!.arguments)).toEqual({ value: "" })
})
