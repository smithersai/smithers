---
title: "@smthrs/model"
description: "One typed streaming interface for Anthropic, OpenAI, and OpenAI-compatible model providers, built on Effect."
---

`@smthrs/model` calls a large language model over HTTP and answers a stream of
typed events. Anthropic Messages, OpenAI Responses, OpenAI Chat Completions,
and any server speaking one of those wire formats reach your code as the same
`ModelEvent` values, through one service with one method:
`model.stream(request)`.

## Why you would use it

Provider SDKs disagree about nearly everything: the request body, the names of
the streaming events, the shape of an error, which token counters exist, and
how a stream says it finished. Code written against two of them carries the
same feature twice. This package puts one interface in front of all of them, so
supporting another provider means building a different route rather than
rewriting the caller.

The second reason is durability. A `ModelRequest` is a plain serializable value
that holds no credentials, and preparing it is deterministic: the same request
encodes to the same bytes on every run. A durable runner can therefore key a
model call on its request, journal it, and replay it. The credential attaches
to a copy of the headers at the transport edge, so it never enters the value
that gets keyed, journaled, or logged. For the reasoning behind that split, see
[Schema-first model calls](./concepts/schema-first.md).

## Install

The package is at 1.0.0-rc.0 and is not on the npm registry yet. It is a
workspace package of the
[Smithers repository](https://github.com/smithersai/smithers), so you use it
from a package in a clone of that repository. It requires Node.js 26.4.0 or later. [Installation](./installation.md) has the steps.

## Call a provider

Build a route from an API key, provide it as the `Model` service, and fold the
event stream into one assistant message:

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

Effect.runPromise(Effect.provide(program, modelLayer)).then(({ message, usage }) => {
  console.log(message.content, usage.totalTokens)
})
```

Three layers stack up. `Route.layer` turns the route into the `Model` service,
`RequestExecutor.layer` gives that service bounded retries and quota
classification, and `FetchHttpClient.layer` carries the bytes; any Effect
`HttpClient` layer fits that last slot. `ModelEvent.settledMessage` returns the
assistant message the turn produced and the token counters the provider
reported. The [quickstart](./quickstart.md) walks the same program one step at
a time.

Anthropic is one of five built-in routes. `Route.openai` targets the OpenAI
Responses API, `Route.openaiResponsesCompatible` and
`Route.openaiChatCompatible` target any server speaking those two wire formats
(Ollama, Gemini's compatibility layer, Cerebras, OpenRouter), and
`OpenAIChatGPT.make` targets the ChatGPT-subscription backend. See
[Define a route](./guides/define-a-route.md).

## Test without a provider

`Model.layer` accepts any implementation, so a test provides a scripted stream
and never reaches the network:

```ts
import { Model } from "@smthrs/model"
import { Stream } from "effect"

const stub = Model.layer({
  stream: () =>
    Stream.make(
      { type: "text-start", id: "text-0" } as const,
      { type: "text-delta", id: "text-0", text: "Hello" } as const,
      { type: "text-end", id: "text-0" } as const,
      { type: "settle", stopReason: "stop" } as const
    )
})
```

`Model.layerNoop()` is the other stub. It fails every call with a typed
`no_route` error, which is what an environment holding no provider
configuration should report instead of hanging.

## How this fits with the rest of Smithers

Smithers runs coding agents as durable flows: a flow is a program whose steps
are journaled, so a run that crashes, pauses for a human, or waits out a quota
window resumes from where it stopped instead of starting over. This package is
the provider layer underneath that.

[`@smthrs/agent`](/api/agent) is the package that composes this one. An agent
step declares a seat, a string such as `anthropic:claude-sonnet-4-5`, and the
agent's `SeatResolver` turns that string into a live `Model` from this package,
along with the context window its compaction budget needs. The agent runs the
loop around that model on a durable engine: it journals the events this package
emits, parks on the quota failures this package classifies, and folds each turn
into a transcript. Reach for `@smthrs/agent` when you want a model-backed step
inside a flow. Reach for this package when you want the provider call itself,
or when you are teaching Smithers to speak to a provider it does not know yet.

Both sit under the `smithers` CLI, [`@smthrs/cli`](/api/cli). The CLI is what
installs the seat resolver that reads provider keys from the environment and
runs flows against them, so a reader who wants the product rather than one
layer of it should start there.

## Namespaces

The root entry point re-exports seventeen namespaces. Each is also importable
on its own subpath, such as `@smthrs/model/Route`.

| Namespace               | What it owns                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `Model`                 | The one provider interface: a request in, a stream of events out.    |
| `ModelRequest`          | The serializable, credential-free declaration of one model call.     |
| `ModelEvent`            | The normalized events one call emits, and the `settledMessage` fold. |
| `ModelError`            | The provider-neutral failure vocabulary.                             |
| `Route`                 | A resolved route: endpoint, protocol, framing, and credentials.      |
| `Protocol`              | The wire contract of a model API family.                             |
| `Endpoint`              | The credential-free HTTP target of a route, and its validation.      |
| `Auth`                  | Credential handling: redacted keys, signing, optional refresh.       |
| `Framing`               | Byte-stream framing: `sse` and `ndjson`.                             |
| `RequestExecutor`       | Bounded retries, quota classification, safe diagnostics.             |
| `AnthropicMessages`     | Anthropic Messages lowering and stream parsing.                      |
| `OpenAIResponses`       | OpenAI Responses lowering and stream parsing.                        |
| `OpenAIChatCompletions` | OpenAI Chat Completions lowering and stream parsing.                 |
| `OpenAIChatGPT`         | Route construction for the ChatGPT-subscription backend.             |
| `DeferredTools`         | Replay-safe policy for native deferred tool loading.                 |
| `ToolStream`            | Pure accumulation of fragmented tool-call arguments.                 |
| `CanonicalJson`         | Deterministic JSON encoding for model-step inputs.                   |

## Where to go next

- To install the package and pick an import form, see
  [installation](./installation.md).
- For a guided first call end to end, see the [quickstart](./quickstart.md).
- To point the package at your provider, see
  [Define a route](./guides/define-a-route.md).
- To consume the event stream, see
  [Read the stream](./guides/read-the-stream.md).
- To branch on failures, see [Handle failures](./guides/handle-failures.md).
- For the mental models, see
  [Schema-first model calls](./concepts/schema-first.md) and
  [Streaming](./concepts/streaming.md).
- For every export and its behavior, see the [API reference](./api.md).
- For concrete failure modes and their fixes, see
  [troubleshooting](./troubleshooting.md).
- For the agent that runs this package on a durable engine, see
  [`@smthrs/agent`](/api/agent). For the CLI both sit under, see
  [`@smthrs/cli`](/api/cli).
