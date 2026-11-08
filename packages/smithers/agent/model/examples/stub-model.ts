/**
 * Calls a model with no provider account: a stub `Model` layer streams a
 * scripted reply, `settledMessage` folds the events into the assistant
 * message, and `Pricing.cost` prices the usage the stream reported. This is
 * the quickstart's "Run a stub model" step; `test/examples.test.ts` runs it.
 */
import { Model, ModelEvent, ModelRequest, Pricing } from "@smthrs/model"
import { Effect, Stream } from "effect"

const request = ModelRequest.ModelRequest.make({
  modelId: "claude-sonnet-4-5",
  system: [],
  messages: [ModelRequest.Message.user("Say hello.")],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

const stub = Model.layer({
  stream: () =>
    Stream.make(
      { type: "text-start", id: "text-0" } as const,
      { type: "text-delta", id: "text-0", text: "Hello" } as const,
      { type: "text-end", id: "text-0" } as const,
      { type: "usage", inputTokens: 1_000, outputTokens: 200 } as const,
      { type: "settle", stopReason: "stop" } as const
    )
})

/** Streams the request through the stub and returns the reply, its stop reason, and its cost. */
export const runStubModel = () =>
  Effect.gen(function*() {
    const model = yield* Model.Model
    const events = yield* Stream.runCollect(model.stream(request))
    const { message, usage } = ModelEvent.settledMessage(events)
    return {
      content: message.content,
      stopReason: message.stopReason,
      cost: Pricing.cost(usage, request.modelId)
    }
  }).pipe(Effect.provide(stub), Effect.runPromise)
