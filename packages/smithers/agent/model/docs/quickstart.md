---
title: "Quickstart"
description: "A guided first model call with @smthrs/model: stub stream, real Anthropic route, and the settled message fold."
sidebar:
  order: 2
---

This quickstart takes you from an empty file to a folded assistant message:
first against a stub model that runs anywhere, then against a real provider
route. You need Node.js 26.4.0 or later.

## 1. Get the package

Add `@smthrs/model` as a workspace dependency of your package inside a clone
of the [Smithers repository](https://github.com/smithersai/smithers).
[Installation](./installation.md) has the steps.

## 2. Run a stub model

Every consumer talks to the `Model` service: one method, `stream`, that takes
a `ModelRequest` and returns a stream of `ModelEvent` values. Provide a stub
implementation so the first run needs no credential:

```ts
import { Model, ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Stream } from "effect"

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
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
      { type: "settle", stopReason: "stop" } as const
    )
})

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  const events = yield* Stream.runCollect(model.stream(request))
  return ModelEvent.settledMessage(events)
}).pipe(Effect.provide(stub))

Effect.runPromise(program).then((result) => console.log(result.message.content))
```

Run it and you should see one text part:

```text
[ { type: 'text', text: 'Hello' } ]
```

`settledMessage` folds the event stream back into the one durable assistant
message, plus the usage counters the stream reported. You will use it on real
streams exactly the same way.

## 3. Call a real provider

To send the same request to Anthropic, build a route from your API key and
provide it as the `Model` service. Set `ANTHROPIC_API_KEY` in your
environment first.

```ts
import { Model, ModelEvent, ModelRequest, RequestExecutor, Route } from "@smthrs/model"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

const route = Result.getOrThrow(
  Route.anthropic({ apiKey: Redacted.make(process.env["ANTHROPIC_API_KEY"] ?? "") })
)

const request = ModelRequest.ModelRequest.make({
  modelId: "claude-sonnet-4-5",
  system: [],
  messages: [ModelRequest.Message.user("Say hello in one sentence.")],
  tools: [],
  params: ModelRequest.GenerationParams.make({ maxTokens: 256 })
})

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  const events = yield* Stream.runCollect(model.stream(request))
  return ModelEvent.settledMessage(events)
})

const modelLayer = Route.layer(route).pipe(
  Layer.provide(RequestExecutor.layer),
  Layer.provide(FetchHttpClient.layer)
)

const result = await Effect.runPromise(Effect.provide(program, modelLayer))
```

The layer graph is three deep. `Route.layer(route)` builds the `Model`
implementation from the route. `RequestExecutor.layer` supplies the
bounded-retry executor it runs on. `FetchHttpClient.layer` is the Effect HTTP
client the executor sends through, and any other Effect `HttpClient` layer
substitutes for it. Nothing else is required, so this file runs as written.

A Smithers run composes one more layer here: the kernel's permission
middleware over the same HTTP client, which checks a `model:call` capability
for the target host and model. See the [kernel API](/api/kernel) for that
contract.

The program answers the same fold as step 2: the settled message, its
`stopReason`, and the token usage Anthropic reported.

## 4. Read the result

The folded message carries everything a transcript needs to continue:

```ts
const { message, usage } = result
for (const part of message.content) {
  if (part.type === "text") console.log(part.text)
}
console.log(message.stopReason, usage.totalTokens)
```

A `stopReason` of `"stop"` means the turn completed. `"aborted"` means the
stream ended without a `settle` event; the fold still returns the partial
content so the transcript stays resumable. [Read the stream](./guides/read-the-stream.md)
covers every event and stop reason.

## Where to go next

- To use OpenAI, an OpenAI-compatible server, or the ChatGPT-subscription
  backend, see [Define a route](./guides/define-a-route.md).
- To branch on typed failures, see [Handle failures](./guides/handle-failures.md).
- For the design behind routes and sealed steps, see
  [Schema-first model calls](./concepts/schema-first.md).
