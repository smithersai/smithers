---
title: "API reference"
description: "Every public export of @smthrs/model: the Model service, routes, protocols, streaming events, errors, the executor, and the Jev classifier."
---

A model call is one composition: a `Protocol` owns the wire shape of an API
family, an `Endpoint` owns where to send it, an `Auth` owns the credential,
and a `Framing` owns how bytes become frames. `Route` combines the four, and
`Route.layer` provides the result as the `Model` service.

```ts
import { Model, ModelEvent, ModelRequest, RequestExecutor, Route } from "@smthrs/model"
import { Effect, Layer, Redacted, Result, Stream } from "effect"

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

const modelLayer = Route.layer(route).pipe(Layer.provide(RequestExecutor.layer))
```

The composed layer still requires the kernel `HttpClient` service, which the
host provides; see the [kernel API](/api/kernel) for that contract.

## Built-in routes

| Constructor                       | Protocol                          | URL it builds                                     |
| --------------------------------- | --------------------------------- | ------------------------------------------------- |
| `Route.anthropic`                 | Anthropic Messages                | `https://api.anthropic.com/v1/messages`           |
| `Route.openai`                    | OpenAI Responses                  | `https://api.openai.com/v1/responses`             |
| `Route.openaiResponsesCompatible` | OpenAI Responses                  | `<baseUrl>/v1/responses`                          |
| `Route.openaiChatCompatible`      | OpenAI Chat Completions           | `<baseUrl>/v1/chat/completions`                   |
| `OpenAIChatGPT.make`              | OpenAI Responses, ChatGPT backend | `https://chatgpt.com/backend-api/codex/responses` |

Both compatible constructors take the provider origin as `baseUrl` and append
the rest themselves, so one origin cannot produce two different URLs. A
trailing slash on `baseUrl` is accepted. `Route.openaiChatCompatible` also
accepts a `path` override for providers whose compatible endpoint lives
elsewhere, such as Gemini's `/v1beta/openai/chat/completions`.

A route's `extraBody` (on `Route.make`'s config, and an option of
`Route.openaiChatCompatible`) adds fields to every request body it sends,
beside the protocol's own: a provider's or gateway's extension the protocol
doesn't model. Routing preferences are the usual one: on the Vercel AI Gateway,
`extraBody: { providerOptions: { gateway: { order: ["cerebras"] } } }` sends a
model it serves through several providers to Cerebras first; OpenRouter reads
`{ provider: { order: ["cerebras"] } }`. A field the protocol writes wins, so
`extraBody` never replaces the model, the messages, the output cap or
streaming. It is part of the prepared body a durable step keys on, and absent
the body is byte-for-byte what it was. Credentials never go in it: they go
through `auth`. A configured-model record carries it as `extraBody`
(`ModelExtraBodySchema` in `@smthrs/rpc`: a JSON object of at most 2 KiB with
no field named for a credential).

Responses and Chat Completions are different wire shapes, not two names for
one. `api.openai.com` serves Responses. Ollama, Gemini's compatibility layer,
Cerebras, OpenRouter's chat route, and most other self-hosted or third-party
"OpenAI-compatible" servers serve Chat Completions.

## `Model`

The one provider seam: a request in, a stream of events out. A flow, a
harness, or a test swaps the implementation without knowing which protocol,
endpoint, or credential answers the call.

| Export                                  | Kind                      | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Model`                                 | service interface and tag | `stream: (request: ModelRequest) => Stream<ModelEvent, ModelFailure>`. Cancellation is fiber interruption, so there is no abort parameter. Tag id `/model/Model`.                                                                                                                                                                                                                                                                                                                                      |
| `ModelFailure`                          | type                      | `ModelError \| PermissionRequired \| PermissionDenied \| GrantStoreError`. The permission classes come from `@smthrs/capability`; see the [capability API](/api/capability).                                                                                                                                                                                                                                                                                                                           |
| `make(implementation)`                  | constructor               | Builds a `Model` from an implementation of `stream`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `layer(implementation)`                 | layer                     | Provides `Model` from an implementation of `stream`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `makeNoop(overrides?)`                  | constructor               | A `Model` that fails every stream with `ModelError` code `no_route` and message `no model route in this environment`, so an environment with no provider configured reports that rather than hanging. `overrides` replaces individual methods.                                                                                                                                                                                                                                                         |
| `layerNoop(overrides?)`                 | layer                     | Provides `makeNoop`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Liveness`                              | reference                 | `Context.Reference<Effect<void>>`, a no-op by default. A route runs it for every chunk of response bytes, including a keep-alive comment or ping frame that decodes to no event. A caller that bounds silence provides its heartbeat here, as `ModelStep` in `@smthrs/agent` does, so a provider that thinks without streaming but keeps its connection alive is not cut off. `ModelProxy` carries it across HTTP: `serve` writes a blank line for it and the client runs it for every chunk it reads. |
| `withGenAiSpan(request, providerName?)` | tracing                   | Wraps a model stream in an OpenTelemetry GenAI client span named `chat <modelId>`, with `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name` when given, the usage tokens and `gen_ai.usage.cost` as they stream in, and `gen_ai.response.finish_reasons`, `gen_ai.response.id` and the [wire timing](#wire-timing) from the settle event. Prompt and response content never reach it, and a failure reaches it as its tag and code alone; see [Span failures](#span-failures).     |

## `ModelRequest`

The serializable, credential-free declaration of one model call. All values
are Effect Schema classes or structs, so a request encodes to plain JSON. The
field declaration order of `ModelRequest` is load-bearing: it is the stable
serialization order a sealed model step keys on.

| Export                 | Kind     | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelRequest`         | class    | Fields: `modelId`, `system`, `messages`, `tools`, `params`, optional `toolChoice`, optional `cacheKey` (the conversation a provider routes its prefix cache by; OpenAI Responses sends it as `prompt_cache_key`, the ChatGPT backend also as the `session-id` header), optional `cacheBoundary` (how many leading messages the next request repeats unchanged; Anthropic Messages puts its moving cache breakpoint on the last of them, and unset means all of them). `ModelRequest.make(input)` accepts a plain object.                                        |
| `Message`              | union    | `UserMessage \| AssistantMessage \| ToolMessage`, tagged by `role`. Constructors: `Message.user(text \| part \| parts)`, `Message.assistant(content, { stopReason?, responseId?, itemIds? })`, `Message.tool(part \| parts)`.                                                                                                                                                                                                                                                                                                                                   |
| `UserMessage`          | class    | `role: "user"`, `content: TextPart[]`. Text only; tool output enters through a tool message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AssistantMessage`     | class    | `role: "assistant"`, `content: AssistantContentPart[]`, `stopReason`, optional `responseId` and `itemIds` (provider item ids a continuation replays).                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ToolMessage`          | class    | `role: "tool"`, `content: ToolResultPart[]`: the results of the calls the previous assistant message asked for.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TextPart`             | struct   | `{ type: "text", text }`, with `TextPart.make({ text })`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ThinkingPart`         | struct   | `{ type: "thinking", text, signature? }`. `signature` is the provider's attestation and must be echoed back unchanged on later requests.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ToolCallPart`         | struct   | `{ type: "tool-call", id, name, arguments }`. `arguments` stays JSON text so it survives a round trip byte for byte.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ToolResultPart`       | struct   | `{ type: "tool-result", toolCallId, content, addedToolNames }`. `addedToolNames` names the tools the result made available; it defaults to `[]`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SystemPart`           | struct   | One text segment of the system prompt. The prompt is a list so a cache breakpoint can fall between segments.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ContentPart`          | union    | `TextPart \| ThinkingPart \| ToolCallPart \| ToolResultPart`, tagged by `type`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `AssistantContentPart` | union    | `ContentPart` without `ToolResultPart`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `StopReason`           | literals | `"stop" \| "length" \| "tool-calls" \| "content-filter" \| "error" \| "aborted" \| "unknown"`. `"aborted"` is this layer's own value for an interrupted stream; no provider reports it.                                                                                                                                                                                                                                                                                                                                                                         |
| `ToolDefinition`       | class    | `{ name, description, parameters, deferred?, loader? }`. `parameters` is a JSON Schema object. A lazy (`deferred`) tool is wire metadata only: it may never add prompt text, because that would change the sealed-step key of every request that declares it.                                                                                                                                                                                                                                                                                                   |
| `GenerationParams`     | class    | Optional `maxTokens`, `temperature`, `topP`, `topK`, `stopSequences`, `thinkingBudget`, `reasoningEffort`. An omitted field leaves the provider default in place, except that the Anthropic Messages lowering sends the model's output ceiling from `ModelCatalog.maxOutputTokensFor`, or `max_tokens: 4096` for an unknown model, for an omitted `maxTokens`. A knob a protocol has no wire field for is dropped from the body instead. Anthropic lowers `reasoningEffort` to `output_config.effort` for models with effort control and drops it for the rest. |
| `ReasoningEffort`      | literals | `"none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`. The provider-neutral vocabulary the adapters map onto their own.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ToolChoice`           | literal  | Only `"none"`. The built-in encoders express it by omitting `tools` altogether, which is what both provider APIs require.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JsonObject`           | schema   | A plain JSON object. Decoding starts from `Schema.Json`, so class instances such as `Date` and `Map` cannot decode as empty records.                                                                                                                                                                                                                                                                                                                                                                                                                            |

## `ModelEvent`

The normalized events one model call emits. Every protocol lowers its own
wire vocabulary into these, so a consumer reads one stream shape whichever
provider answered.

| Export                                            | Kind       | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Usage`                                           | struct     | Optional `inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens`, `cacheWriteTokens`, `totalTokens`, and `costUsd`, the provider's own USD charge (OpenRouter's `usage.cost`). A missing count is not a zero count.                                                                                                                                                                                                |
| `TextStart` / `TextDelta` / `TextEnd`             | structs    | Open, extend, and close a text part. `id` correlates the events of one part.                                                                                                                                                                                                                                                                                                                                                     |
| `ThinkingStart` / `ThinkingDelta` / `ThinkingEnd` | structs    | The same for a reasoning part. `ThinkingStart.signature` carries the provider's attestation.                                                                                                                                                                                                                                                                                                                                     |
| `ToolCallStart` / `ToolCallDelta` / `ToolCallEnd` | structs    | The same for a tool call. `ToolCallEnd.arguments` repeats the complete argument text when the provider sends it.                                                                                                                                                                                                                                                                                                                 |
| `ToolResult`                                      | struct     | `{ type: "tool-result", id, output, isError? }`: a harness report, not part of the settled message.                                                                                                                                                                                                                                                                                                                              |
| `UsageEvent`                                      | struct     | `Usage` counters as a `type: "usage"` stream event.                                                                                                                                                                                                                                                                                                                                                                              |
| `Retry`                                           | struct     | `{ type: "retry", attempt, code, delayMillis, elapsedMs?, httpStatus? }`: a bounded model-boundary retry, recorded so run reports can count transport recovery. `delayMillis` defaults to `0`. `elapsedMs` is how long the failed attempt ran and `httpStatus` the status that failed it, when the boundary that retried recorded them.                                                                                          |
| `FailedTry`                                       | struct     | `{ sentMs?, failedMs, code, httpStatus? }`: one HTTP try that failed and was tried again inside the call.                                                                                                                                                                                                                                                                                                                        |
| `Timing`                                          | struct     | Where one call's time went on the wire: `startedAt` in epoch milliseconds, then whole milliseconds from that start: `attempts`, `requestBytes`, `preparedMs`, `signedMs`, `sentMs`, `headersMs`, `firstEventMs`, `firstThinkingMs`, `firstOutputMs`, `lastOutputMs`, `completedMs`, `closedMs`, and `failedTries`. Every field is optional: a stage that was not observed is absent, never zero.                                 |
| `Settle`                                          | struct     | `{ type: "settle", stopReason, responseId?, servedTier?, timing?, sessionId?, itemIds? }`. Ends the stream and states why; a stream without one was interrupted. `servedTier` is the service tier the provider says served the call. `timing` is the call's `Timing`. `itemIds` carries stored provider reasoning items a continuation replays by reference; `sessionId` is the vendor session a wrapped CLI seat answered from. |
| `ModelEvent`                                      | union      | The tagged union of all of the above, with a constructor per member attached (for example `ModelEvent.TextStart({ type: "text-start", id })`) and `settledMessage` attached.                                                                                                                                                                                                                                                     |
| `settledMessage(events)`                          | destructor | Folds an iterable of events into `{ message: AssistantMessage, usage: Usage }`. No `settle` event means interruption, represented as `stopReason: "aborted"` rather than an exception. Partial tool-call argument text is preserved verbatim; validate arguments before executing a tool.                                                                                                                                        |

### Wire timing

`Route.toModel` and `Route.layer` time every call and put the reading on its
`settle` event as `timing`. Offsets are whole milliseconds from `startedAt`,
read on Effect's `Clock`, so a `TestClock` controls every value.

| Field             | The moment                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startedAt`       | The call started, in epoch milliseconds. Every offset below counts from here.                                                                               |
| `attempts`        | Not a moment: how many HTTP tries the call made, including the answered one.                                                                                |
| `requestBytes`    | Not a moment: the size of the request body.                                                                                                                 |
| `preparedMs`      | The request was validated and encoded to the bytes that are sent.                                                                                           |
| `signedMs`        | `Auth.sign` answered: the credential was resolved and the request signed. After a refresh, the second signature.                                            |
| `sentMs`          | The answered try's request was handed to the HTTP client. The client does not report the socket write, so the upload lies between this and `headersMs`.     |
| `headersMs`       | The response status and headers arrived.                                                                                                                    |
| `firstEventMs`    | The first framed provider event arrived, of any kind.                                                                                                       |
| `firstThinkingMs` | The first `thinking-start` or `thinking-delta` event. Absent when the call emitted none.                                                                    |
| `firstOutputMs`   | The first `text-delta` or `tool-call-delta` event. Absent when the call emitted none.                                                                       |
| `lastOutputMs`    | The last `text-delta` or `tool-call-delta` event. Absent when the call emitted none.                                                                        |
| `completedMs`     | The protocol settled: `response.completed` or `response.incomplete`, `message_stop`, or a Chat Completions `finish_reason`.                                 |
| `closedMs`        | The route stopped reading the response: at the protocol's terminal event, or at the end of the body. Absent on a settle read before that, see below.        |
| `failedTries`     | Each try that failed before the answered one: `sentMs`, `failedMs`, `code`, and `httpStatus` when a response carried one. Absent when the first try worked. |

A stage that was not observed is absent, never zero. A custom
`RequestExecutor` that does not call `onTry` leaves out `attempts`, `sentMs`,
and `failedTries`. Chat Completions settles on `finish_reason`, one chunk
before the usage chunk that ends the body, so that `settle` has no `closedMs`;
a provider that sends usage on the `finish_reason` chunk has one.

`Settle.servedTier` is the provider's own `service_tier`: the terminal
Response object on OpenAI Responses, the chunk field on Chat Completions, and
`usage.service_tier` on Anthropic Messages. OpenAI documents the response
value as the processing mode actually used, which may differ from the one
requested, so the `response.created` snapshot, sent before any output, is not
read. `servedTier` is absent when the provider names none.

The same reading reaches three other places:

- A call that fails carries it as `error.timing` on its `ModelError`, with the
  failed tries and how far the response got. Like `error.body` it is outside
  the schema and non-enumerable.
- The `flows/model/Route.stream` span ends when the response starts, so it
  carries the request's half as `smithers.model.attempts`,
  `smithers.model.request_bytes`, `smithers.model.prepared_ms`,
  `smithers.model.signed_ms`, `smithers.model.sent_ms`,
  `smithers.model.headers_ms`, and `smithers.model.failed_tries` (the failed
  tries' codes, in order). `Model.withGenAiSpan` puts every stage of the
  settle event's reading on the `chat` span under the same names, with
  `smithers.model.served_tier`.
- An injected `WireTrace.WireTrace` sink receives it (the
  `WireTrace.layerFileSystem(path)` layer appends JSON lines using the host
  filesystem). The default writes no files. The response record includes the reading; see
  [Troubleshooting](./troubleshooting.md#latency).

A `Model` that is not built from a route, such as a wrapped CLI, fills only
the stages it can observe.

## `WireTrace`

`WireTrace.WireTrace` is an optional diagnostic sink captured by `Route.toModel`
and `Route.layer` when the model is built. Its `write(record)` receives paired
request and response records without signed headers or message content. Errors
and defects produce only a content-free debug log. Cooperative writes have a
1,000 ms deadline; `writeTimeoutMs` overrides it with a finite positive budget.
Cancellation keeps the response record and may wait this budget for cleanup.

`WireTrace.layerFileSystem(path)` provides the sink through an injected Effect
`FileSystem`, with serialized JSONL appends. The host supplies that filesystem,
for example `NodeHost.NodeFileSystem.layer` from `@smthrs/platform-node`.
No sink means no files or ambient environment access. `SMITHERS_WIRE_TRACE`
is no longer read implicitly. See [Troubleshooting](./troubleshooting.md#prompt-cache)
for layer composition. Custom sinks must support interruption and must not block
JavaScript synchronously.

## `ModelError`

The provider-neutral failure vocabulary. Branch on `code`; provider message
text is not a contract and changes without notice.

`ModelError` is a `Schema.TaggedError` with tag `flows/model/ModelError` and
these fields:

| Field                | Type                    | Meaning                                                                                                                                                                                           |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`               | `ModelErrorCode`        | The stable serialized field and the public error contract.                                                                                                                                        |
| `message`            | `string`                | Human-readable detail, already scrubbed of credentials.                                                                                                                                           |
| `path`               | `string?`               | A key path only (for example `messages[2].content[0].text`), never a value, because a request member may hold a credential or user content. Present when the package refused to send the request. |
| `retryAfterMillis`   | `number?`               | The wait the provider asked for, when it asked.                                                                                                                                                   |
| `resetAtEpochMillis` | `number?`               | The durable wake instant for a parked run.                                                                                                                                                        |
| `resetSource`        | `string?`               | Which header or body field supplied the reset instant.                                                                                                                                            |
| `quotaScope`         | `"model" \| "account"?` | Optional scope supplied by a protocol classifier. Model scope leaves sibling models eligible; account scope cools every model on the same route.                                                  |
| `providerCode`       | `string?`               | The provider's own error code.                                                                                                                                                                    |
| `requestId`          | `string?`               | The provider's request id, from the usual `x-request-id` family of headers. From a `ModelProxy` client, the request id both sides logged.                                                         |
| `httpStatus`         | `number?`               | The HTTP status, when a response was received.                                                                                                                                                    |

The failed provider response body is reachable as `error.body`, capped at
16 KiB, with `error.bodyTruncated` set when the cap bites. Both live outside
the error's schema and are non-enumerable, so a journal never copies a
provider body into run state. An error a route raised also carries
`error.timing`, the failed call's [wire timing](#wire-timing), the same way.

The codes and their retryability:

| Code                      | Meaning                                               | Retryable |
| ------------------------- | ----------------------------------------------------- | --------- |
| `invalid_request`         | The request is malformed for this provider.           | no        |
| `context_overflow`        | The request did not fit the model's context window.   | no        |
| `no_route`                | No model is configured.                               | no        |
| `authentication`          | The credential was rejected.                          | no        |
| `rate_limited`            | A transient limit.                                    | yes       |
| `quota_exceeded`          | The account has no usable balance or quota.           | no        |
| `out_of_credit`           | Hosted proxy credit is exhausted.                     | no        |
| `content_policy`          | The provider refused on safety grounds.               | no        |
| `provider_internal`       | The provider failed on its own side.                  | yes       |
| `transport`               | The connection failed.                                | yes       |
| `call_timeout`            | The caller's own wall-clock budget expired.           | yes       |
| `invalid_provider_output` | The provider sent something the protocol cannot read. | no        |
| `unknown`                 | Unclassified.                                         | no        |

The `retryable` getter computes from the code and `httpStatus`:
`quota_exceeded` is never retryable; `rate_limited`, `provider_internal`,
`transport`, and `call_timeout` are, as is any error with HTTP status 429 or
5xx. `call_timeout` describes what the caller did, not the provider: the
caller exceeded a wall-clock budget it declared and interrupted the request
itself, so nothing about the request's settlement is known.

| Export                                     | Kind           | Behavior                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ModelErrorCode`                           | schema         | The thirteen-literal code vocabulary above.                                                                                                                                                                                                                                                      |
| `ModelError`                               | error class    | As described above.                                                                                                                                                                                                                                                                              |
| `isContextOverflow(providerCode, message)` | refinement     | Whether a provider's own code and message describe a context overflow. Protocol adapters call it ahead of their generic bad-request branch.                                                                                                                                                      |
| `isQuotaExhausted(providerCode, message)`  | refinement     | Whether a provider's own code and message describe an exhausted account rather than a transient rate limit, so a durable consumer can park instead of retrying.                                                                                                                                  |
| `isTerminalRefusal(error)`                 | classification | Whether the normalized refusal requires intervention rather than a quota cooldown; shared with agent quota policy and failure actions.                                                                                                                                                           |
| `faults`                                   | constant       | The fault class of each code, which `@smthrs/flow`'s `Fault` reads for a `ModelError` and a `ModelProxy.Refusal` alike: limits are `wait`, `authentication`, `out_of_credit` and `content_policy` are `user`, `invalid_request` and `context_overflow` are `factory`, the rest are `dependency`. |

## `FailureCopy`

`describe(error, seat?)` walks wrapped causes for a typed `ModelError` or
`HarnessError` and returns `{ headline, fault, line, actions }`. `fault` is
[`Fault.of(error).class`](/api/flow#fault), one of `user`, `wait`, `infra`,
`dependency`, `bug`, `factory`, and `policy`; actions are `resume`,
`switch-model`, `wait`, and `details`. A model seat supplies the provider name
for a limit, through `provider(seat)`: `OpenAI`, `Anthropic`, `Claude Code`,
`Kimi`, `Gemini`, `OpenRouter`, `Cerebras`, else `Model`. An account out of
quota or credit offers `switch-model` first. Unknown errors have a generic headline. Raw messages and stacks
belong in technical details, never in the headline. A bare string is never
read for a fault: the fault arrives typed. A `SeatUnresolved` anywhere on the
cause chain reads "Model sign-in required" with the host's own sign-in
instruction as the line, bounded to 240 characters. A `SeatUnrouted` (an
`auto` seat the router could not pick) reads "Model could not be chosen" and
offers `switch-model` first; its line says why: nothing to route to, the host's
own `unconfigured` message (bounded the same way), an interruption, or a
router that could not pick one. A cause that names what
happened better than its wrapper wins: frames spent without an answer, the
repeated-failure guard, and a person's rejection or silence on a human task
each read as themselves, not as a model call that failed.

`ModelError` registers its codes with `Fault`: `rate_limited` and
`quota_exceeded` are `wait`; `invalid_request` and
`context_overflow` are `factory`, because the agent built the request;
`authentication`, `content_policy` and `out_of_credit` are `user`; the rest are `dependency`.
`Evaluator.faults` is the same table for Jev's codes, shared by
`EvaluatorError` and `ClassifierError`.

## `ModelProxy`

A `Model` served over HTTP, and a `Model` that reads one served elsewhere. The
host runs `serve`, which owns the provider key and decides, per request, what
the model receives and which `Model` answers; a browser, Worker or CLI
provides `layerClient` and calls `model.stream(request)` as it would locally.
See [Proxy a model](./guides/proxy-a-model.md).

| Export                  | Kind        | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve(options)`        | server      | `Effect<HttpServerResponse, never, HttpServerRequest \| R>`. Reads a `POST` JSON `ModelRequest` body, runs `options.prepare`, calls the `Model` it chose inside `Model.withGenAiSpan`, and streams NDJSON. Answers `405` to another method, `413` past `maxBodyBytes` (counted while reading), `400` to a body that is not a `ModelRequest`, a `Refusal`'s status, and `500` when `prepare` dies. Writes a blank keep-alive line each time the model runs `Model.Liveness`, at most one a second and none within a second of an event.                                                                                                   |
| `ServeOptions<R>`       | interface   | `prepare: (request, admission) => Effect<Prepared, Refusal, R>`, required; `maxBodyBytes?`, default `defaultMaxBodyBytes`; `attributes?`, labels added to every server-side metric and the log line (the proxy's own names win); `onEnd?: (end: End) => Effect<void, never, R>`, run once, uninterrupted, after an admitted request's model stream ends; the terminal line waits for it.                                                                                                                                                                                                                                                 |
| `Prepared`              | interface   | `{ request, model }`: the `ModelRequest` the model receives and the `Model` that answers it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Admission`             | interface   | `{ requestId, invocationId, requestBytes }`, `prepare`'s second argument: the caller's id, the server's id for this call (the one `End` carries, so a host reserves spend under it in `prepare` and settles it in `onEnd`), and the body's size in bytes, at most `maxBodyBytes`.                                                                                                                                                                                                                                                                                                                                                        |
| `End`                   | interface   | `{ requestId, invocationId, outcome, modelId, usage, produced, errorCode?, httpStatus? }`; `invocationId` is the server's own id for the call, minted for every admitted request (key metering on it; the caller chooses `requestId` and may repeat it); `outcome` is `success`, `failed` or `interrupted`, and `usage` is the merged `usage` events (a `retry` starts it over). `produced` is whether the model sent any event but `usage` and `retry`. A `failed` call carries its `ModelError` code (`unknown` for any other failure) and, when its provider answered an HTTP error, that status. Never passed for a refused request. |
| `refusedCleanly(end)`   | function    | `boolean`: the call failed before producing output, `rate_limited` or with a provider 4xx status, so it spent nothing beyond the usage its provider reported. A host that reserved spend settles such a call to that usage, 0 when none. Any other failure, a transport failure or a 5xx included, may have spent tokens nobody reported.                                                                                                                                                                                                                                                                                                |
| `producesOutput(event)` | function    | `boolean`: whether a `ModelEvent` counts as output for `End.produced`, anything but `usage` and `retry`. For a host that runs a model in process and builds its own `End`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `failureOf(cause)`      | function    | `{ errorCode, httpStatus? }`: what a failed stream's cause gives `End`, its `ModelError` code (`unknown` for any other failure) and the provider's HTTP status when it had one.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Refusal`               | error class | Tag `flows/model/ModelProxyRefusal`. `status` (400 to 599) and `message` reach the client as written; `code?` is the client's `ModelError` code, chosen by the status when omitted. `modelErrorCode` is the code the client gets; its `ModelError.faults` class is the refusal's fault, so a `429` waits and a `401` asks the person.                                                                                                                                                                                                                                                                                                    |
| `makeClient(options)`   | client      | `Effect<Model, never, HttpClient>`. `stream` posts the encoded request with a fresh request id and trace context and decodes the lines. Runs `Model.Liveness` for every chunk of the body, a blank keep-alive line included, and decodes no event from a blank line. Interrupting it aborts the request.                                                                                                                                                                                                                                                                                                                                 |
| `layerClient(options)`  | client      | `Layer<Model, never, HttpClient>` from `makeClient`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `prepare(options)`      | client      | `(request) => Effect<Route.PreparedRequest, ModelError>`: the credential-free request `makeClient` sends, the URL and exact body bytes, for a durable step's `route`. `headers` and the request id stay out; a request that does not encode fails `invalid_request`.                                                                                                                                                                                                                                                                                                                                                                     |
| `ClientOptions`         | interface   | `url` (relative URLs resolve against the page), `headers?`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Line`                  | schema      | One NDJSON line: a `ModelEvent`, `EndLine` or `ErrorLine`. A blank line between them is a keep-alive, not a `Line`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EndLine`               | schema      | `{"type":"end"}`, the terminal line of a clean stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ErrorLine`             | schema      | `{"type":"error",code,message,retryAfterMillis?}`, the terminal line of a stream whose model failed after the headers. `message` is the code's fixed `FailureCopy` headline, never provider text.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ErrorBody`             | schema      | `{code,message,requestId}`, the body of every non-`200` answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `requestIdHeader`       | constant    | `x-smithers-request-id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `contentType`           | constant    | `application/x-ndjson`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `defaultMaxBodyBytes`   | constant    | 1 MiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `requests`              | metric      | Counter `smithers_model_proxy_requests` by `side`, `outcome`, `status` (`0` with no response), and on the server the host's `attributes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `duration`              | metric      | Histogram `smithers_model_proxy_duration_ms` by `side`, `outcome`, and on the server the host's `attributes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `firstEvent`            | metric      | Histogram `smithers_model_proxy_first_event_ms` by `side`, and on the server the host's `attributes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tokens`                | metric      | Counter `smithers_model_tokens` by `type` (`input`, `output`), `model` and the host's `attributes`, from the final merged `usage` events; server only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The client fails every stream with a `ModelError` carrying the request id as
`requestId`: an `ErrorLine` as its code, `retryAfterMillis` and message; an
error status as the `ErrorBody`'s code and message (or the status's code and
`The model host answered HTTP <status>.` for a body that is not one) with
`httpStatus`; an unreachable host, a broken body, or a body that ends before
its terminal line as `transport`; an undecodable line as
`invalid_provider_output`; and a request it cannot encode as
`invalid_request`, without sending it.

Each side ends each request with one span (`model.proxy.serve`,
`model.proxy.stream`), the metrics above, and one log line whose message is the
span name: Info for `success` and `interrupted`, Warn for `invalid` and
`refused`, Error for `failed`. The server's log line also carries the host's
`attributes`. The span carries `smithers.model.proxy.request_id`,
`smithers.model.proxy.outcome`, `http.response.status_code`, `error.type`,
`smithers.model.proxy.events`, `smithers.model.proxy.duration_ms` and
`smithers.model.proxy.first_event_ms`, and on the server
`gen_ai.request.model`, `gen_ai.provider.name` and
`smithers.model.proxy.request_bytes`. A failed span ends with a `ModelError`
rebuilt from the code alone. With no HTTP server span in context, the
`model.proxy.serve` span is a `server` span parented on the request's
`traceparent`. Prompt, response and provider text and credentials never reach
a span, metric or log line.

## `Route`

A resolved model route: an endpoint, a protocol, a framing, and the
credentials to authorize with.

| Export                                                                    | Kind        | Behavior                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Route`                                                                   | type        | `Config`: a configured, but not yet authenticated, protocol route.                                                                                                                                                                                                                             |
| `Config`                                                                  | interface   | `{ id, protocol, endpoint, auth, framing, headers? }`.                                                                                                                                                                                                                                         |
| `PreparedRequest`                                                         | interface   | `{ routeId, protocolId, method: "POST", url, publicHeaders, body, bodyText }`: the credential-free sealed-step view. `body` is a fresh `Uint8Array` per preparation; do not mutate it.                                                                                                         |
| `prepare(route, request)`                                                 | constructor | `Effect<PreparedRequest, ModelError>`. Validates the request against `ModelRequest`, lowers and validates the provider body, checks the public headers, and encodes canonical bytes, exactly once per call.                                                                                    |
| `make(config)`                                                            | constructor | Returns the config as a `Route`.                                                                                                                                                                                                                                                               |
| `toModel(config)`                                                         | constructor | `Effect<Model, never, RequestExecutor>`: builds the `Model` implementation from a composed route.                                                                                                                                                                                              |
| `layer(config)`                                                           | layer       | `Layer<Model, never, RequestExecutor>`: provides a configured route as the `Model` service.                                                                                                                                                                                                    |
| `anthropic({ apiKey, baseUrl? })`                                         | constructor | `Result<Route, ModelError>`. Sends `x-api-key` and `anthropic-version: 2023-06-01`. `baseUrl` defaults to `Endpoint.providerOrigins.anthropic`.                                                                                                                                                |
| `openai({ apiKey, baseUrl? })`                                            | constructor | `Result<Route, ModelError>`. Bearer auth against `api.openai.com`, or `baseUrl` when given.                                                                                                                                                                                                    |
| `openaiResponsesCompatible({ id, baseUrl, apiKey, headers? })`            | constructor | A route for a provider that serves the Responses API without OpenAI's native deferred-tool extensions; `supportsDeferred` is forced off. `baseUrl` is the origin and the constructor appends `/v1/responses`, so `https://openrouter.ai/api` becomes `https://openrouter.ai/api/v1/responses`. |
| `openaiChatCompatible({ id, baseUrl, path?, apiKey, structuredOutput?, extraBody? })` | constructor | A route for a Chat Completions provider. `path` defaults to `/v1/chat/completions`. `extraBody` adds fields beneath the protocol's own (see Routes above). `apiKey` may be a non-empty placeholder for a server that does not check it; `Auth.bearer` only rejects an empty credential.                                                                               |

Behavior the composition guarantees:

- **The credential boundary.** Credentials never enter a `PreparedRequest`:
  it carries the endpoint, the public headers, and the canonical body bytes
  that a sealed step keys on, and `Auth.sign` signs a copy of the headers as
  the request leaves. A route header whose name looks like a credential fails
  preparation with `invalid_request` and message `Route header <name> must be
  applied through Auth`.
- **One validation.** `prepare` validates the request once and every later
  step reads that snapshot, so mutating the request object while a call is in
  flight changes nothing about what is sent.
- **One auth refresh.** An `authentication` failure is terminal on both retry
  ladders. `Route.stream` prefers `Auth.refreshRejected(headers)`, passing the
  signed headers of the refused attempt, or falls back to `Auth.refresh`.
  Recovery re-signs and retries exactly once. Request-specific recovery can
  reuse a credential rotated while an older request was in flight; its
  headers stay out of diagnostics.
- **Typed stream failures.** A response stream that dies after the headers,
  and an oversized SSE event, both surface as `transport`. A frame the
  protocol's event schema cannot decode surfaces as `invalid_provider_output`
  with a `path` and no values. When the protocol declares a `terminal`
  predicate, the stream stops at the first matching event. When the upstream
  ends, the protocol's `onHalt` emits its final events, which is how
  unfinished tool calls flush.

Preparation failures are `invalid_request` with one of these messages:
`Model request failed Schema validation`, `<protocol id> produced an invalid
provider request body`, or `Model request could not be encoded as canonical
JSON`. Each carries `path` when the failing member is known.

## `Protocol`

The wire contract of a model API family, split from the deployment that
serves it.

| Export                                | Kind        | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Protocol<Body, Frame, Event, State>` | interface   | `{ id, supportsDeferred, body, stream, classifyError, headers?, affinityHeader? }`. `headers(request)`, when present, returns public headers derived from one request, merged over the route's static headers and sealed into the step key like the body. `affinityHeader`, when present, names a response header whose latest value the route echoes on later requests with the same route, endpoint, signed credential and `cacheKey`, so two accounts that share a `cacheKey` never see each other's value; it is applied at signing and never sealed. `supportsDeferred(modelId)` reports native deferred-tool support. `classifyError(status, body)` maps a failed HTTP response to a `ModelError`. |
| `ProtocolBody<Body>`                  | interface   | `schema`: the validating codec for the provider body. `from(request, { native })`: lowers a `ModelRequest` into that body, failing with `ModelError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ProtocolStream<Frame, Event, State>` | interface   | `event`: the framed event codec. `initial(request)`: the state a call starts with. `step(state, event)`: folds one decoded event into `[state, ModelEvent[]]`. Optional `onHalt(state)`: final events when the upstream ends. Optional `terminal(event)`: stop taking events after a match.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `make(protocol)`                      | constructor | Returns the protocol value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `jsonEvent(schema)`                   | schema      | The JSON-string event codec shared by the SSE protocols.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## `Endpoint`

The credential-free HTTP target of a model route. An endpoint is public data:
it is part of a sealed step's key material, so nothing secret may appear in
it.

| Export                                  | Kind        | Behavior                                                                                                                                                                         |
| --------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Endpoint`                              | interface   | `{ method: "POST", url, query }`.                                                                                                                                                |
| `MakeOptions`                           | interface   | `{ url, path?, query? }`; query is a record or an array of name/value pairs.                                                                                                     |
| `make(input)`                           | constructor | `Result<Endpoint, ModelError>`. Validates and normalizes: query pairs are sorted by name then value, and the path is joined onto the URL's existing path.                        |
| `makeSecure(input)`                     | constructor | Validates through `make`, then requires HTTPS for remote credential-bearing endpoints; loopback HTTP remains available.                                                          |
| `render(endpoint)`                      | formatting  | Renders the exact deterministic URL.                                                                                                                                             |
| `providerOrigins`                       | constant    | Origins of `anthropic`, `openai`, `cerebras`, `openrouter` (`https://openrouter.ai/api`), `vercel` and `chatgpt` (`https://chatgpt.com/backend-api`).                            |
| `ProxiedProvider`                       | type        | A key of `providerOrigins`.                                                                                                                                                      |
| `modelProxyVariable`                    | constant    | `"SMITHERS_MODEL_PROXY_URL"`.                                                                                                                                                    |
| `providerOrigin(provider, environment)` | getter      | `${SMITHERS_MODEL_PROXY_URL}/${provider}` (trailing slash stripped) when the variable is set and non-empty, else `providerOrigins[provider]`. Seat resolution routes through it. |

`Endpoint.makeSecure` validates targets for signed provider requests: remote
endpoints require HTTPS; HTTP is allowed only for localhost, IPv4 loopback
(127/8) and IPv6 loopback (::1). Provider constructors, custom route preparation
and the gateway evaluator use it before signing. `Endpoint.make` validates
public endpoint identity without imposing transport security; `ModelProxy.prepare`
keeps the caller's HTTP, HTTPS or relative URL and the same encoded payload.

`Endpoint.make` rejects, all as `invalid_request`: an unparseable URL, a
non-`http(s)` scheme, embedded URL credentials, a fragment, a
credential-shaped query key (anything `isCredentialName` matches, plus `key`
and `sig`), a path containing a query string or fragment, and a relative path
segment, including the `%2e`-encoded disguises the URL parser would otherwise
collapse.

## `Auth`

Credential handling for a model route. This is the redaction boundary:
credentials never enter the sealed step view, and signing never logs their
values.

| Export                    | Kind        | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Auth`                    | interface   | `sign(headers)` returns the headers with the credential applied, failing with `ModelError`. Optional `refreshRejected(headers)` receives the refused attempt’s signed headers; optional `refresh` is the fallback effect. The route runs one recovery after an `authentication` failure, then re-signs and retries once. `sign` may hold rotating state, but every dependency is captured at construction; the type has no requirements channel. |
| `Redacted<A>`             | type        | Effect's `Redacted`: a value whose string and JSON representations conceal its contents.                                                                                                                                                                                                                                                                                                                                                         |
| `apiKeyHeader(name, key)` | constructor | Adds a redacted API key as an exact HTTP header.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bearer(key)`             | constructor | Adds a redacted API key as `Authorization: Bearer <key>`.                                                                                                                                                                                                                                                                                                                                                                                        |

Both constructors fail signing with `authentication` and message `API key
must not be empty` when the redacted value is empty. `credentialNamePattern`
is the shared matcher for credential-bearing field names across headers,
query parameters, and structured bodies; `isCredentialName(name)` applies it.
`chatgpt-account-id` matches on purpose: it names an account rather than a
secret, but it is an identity the ChatGPT route keeps out of step keys,
journals, and diagnostics. Numeric token-count fields such as `max_tokens`
and `budget_tokens` do not match, so a provider diagnostic quoting them stays
readable.

## `Framing`

Byte-stream framing, chosen independently of the protocol that interprets
the frames.

| Export           | Kind      | Behavior                                                                                                                                                                                                                                                                                                              |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Framing<Frame>` | interface | `{ id, frame(stream) }`: turns a byte stream into frames.                                                                                                                                                                                                                                                             |
| `sse`            | framing   | Incrementally decodes UTF-8 Server-Sent Events over arbitrary byte chunk boundaries. Empty frames, the `[DONE]` sentinel, and incomplete trailing frames are discarded before protocol JSON decoding. SSE retry directives are connection-level metadata and are ignored; request execution owns reconnection policy. |
| `ndjson`         | framing   | One complete JSON document per line; blank lines are discarded. A stream cut mid-line yields that partial line as a frame, where protocol decoding rejects it as `invalid_provider_output`: a truncated record is a failure to report, not a record to silently drop.                                                 |

## `RequestExecutor`

Executes provider requests with bounded retries, quota classification, and
credential-safe diagnostics.

| Export                          | Kind                      | Behavior                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RequestExecutor`               | service interface and tag | `execute(request, options)` answers the response, failing with `RequestError`. It requires a `Scope`: the caller's scope owns the successful response body. Tag id `/model/RequestExecutor`.                                                                                                                                               |
| `ExecuteOptions`                | interface                 | `{ modelId, classifyError?, onTry? }`: the per-request policy the composed route supplies. Every request is wrapped in the kernel's `model:call` capability check for this `modelId`. `onTry` observes each HTTP try and cannot change what is sent or retried.                                                                            |
| `TryEvent`                      | type                      | What `onTry` is told, in epoch milliseconds on the executor's `Clock`: `{ type: "sent", at }` when a try's request is handed to the HTTP client, after any retry wait, and `{ type: "failed", sentAt, at, code, httpStatus? }` when one fails. The answered try reports `sent` alone.                                                      |
| `ErrorClassifier`               | type                      | `(status, body) => ModelError`: protocol-specific classification for a failed HTTP response.                                                                                                                                                                                                                                               |
| `RequestError`                  | type                      | `ModelError \| PermissionRequired \| PermissionDenied \| GrantStoreError`. Kernel permission failures keep their original classes across the model boundary.                                                                                                                                                                               |
| `Transport`                     | interface                 | `{ client, rebuild }`: the kernel HTTP client every request goes through, and the host's way of replacing it.                                                                                                                                                                                                                              |
| `fixed(client)`                 | constructor               | A transport whose rebuild answers the same client.                                                                                                                                                                                                                                                                                         |
| `rebuildAfter`                  | constant                  | `3`: how many consecutive transport failures replace the client. A destroyed connection pool is the failure waiting does not repair. Any success, and any non-transport failure, resets the counter, which is shared by every request on the executor.                                                                                     |
| `MakeOptions`                   | interface                 | `{ maxRetries? }`: retries after the first attempt. Defaults to `2`; `0` makes `execute` a single attempt. A negative count is `0`.                                                                                                                                                                                                        |
| `Retries`                       | reference                 | `Context.Reference<number \| undefined>`: the retries a caller allows each request, overriding the executor's `maxRetries`. `undefined`, the default, keeps the executor's; a negative count is `0`. A caller that decides retries itself provides `0`, as `ModelStep.run` in `@smthrs/agent` does, so one of its attempts is one request. |
| `makeWith(transport, options?)` | constructor               | `Effect<RequestExecutor>` over a transport it may replace, bounded by `MakeOptions`.                                                                                                                                                                                                                                                       |
| `make`                          | constructor               | `Effect<RequestExecutor, never, HttpClient>` around the kernel HTTP client in context.                                                                                                                                                                                                                                                     |
| `layer`                         | layer                     | `Layer<RequestExecutor, never, HttpClient>`: provides the executor, requiring the kernel HTTP client.                                                                                                                                                                                                                                      |

The kernel HTTP boundary returns structural permission data. The executor uses
`@smthrs/capability`’s `decodePermissionError` to reconstruct the yieldable error
class with its capability, request identity and suspension metadata. Callers
receive the existing `RequestError` union; transport payload object identity is
not preserved.

The retry ladder: by default one call makes at most three attempts (the first
plus two retries), starting at 500 ms, doubling, jittered, capped at 10 s per wait and
60 s in total. Only a retryable error is retried. A `Retry-After` or
`retry-after-ms` header replaces the computed wait and is slept in full, so no
retry reaches the provider early; a provider wait larger than the whole 60 s budget is not
slept at all, and the error surfaces immediately with its `retryAfterMillis`,
`resetAtEpochMillis`, and `resetSource` so the caller can park durably
instead of holding the process.

HTTP status classification maps 401 and 403 to `authentication`; 402 and the
quota vocabulary to `quota_exceeded`; 429 to `rate_limited`; content-policy
wording to `content_policy`; overflow wording to `context_overflow`; 400,
404, 409, 413, and 422 to `invalid_request`; 5xx to `provider_internal`;
anything else to `unknown`. The executor and built-in protocols share these
rules, including bare 402 responses and incorrect API key wording. Anthropic
overrides 529 and overload errors to `rate_limited`. A protocol's
`classifyError` code wins when it is more specific than `unknown`; otherwise
the executor keeps the shared classification. Protocol diagnostics are retained.
Reset instants are also read from the
`x-ratelimit-reset-*` and `anthropic-ratelimit-*-reset` header families and
from reset fields in a JSON error body, preferring the exhausted resource's
window so a parked run wakes exactly once.

Diagnostics are scrubbed twice. Values the package knows to be credentials
are removed literally, in raw, URL-encoded, JSON-escaped, and Base64 forms
(including URL-safe Base64). A JSON
error body is additionally walked and every value under a credential-shaped
key is replaced at any depth. A failed response body stops being read at
64 KiB, so nothing beyond that is held, parsed, classified, or redacted; the
recursive walks stop at depth 12, where a redacted subtree is replaced whole;
and the text kept on the error is capped at 16 KiB, reachable as
`ModelError.body` with `ModelError.bodyTruncated` set when either cap bites.

`Auth.credentialHeaders` designates headers added by signing, including custom
names. `apiKeyHeader` and `bearer` set it automatically. Custom Auth values
should list any credential headers outside the shared matcher. `Auth.withRedaction`
adds these names and the shared matcher to `Headers.CurrentRedactedNames` while
preserving the caller's policy. Routes apply it around signing and HTTP execution.

The HTTP client records no request or response header on its span, so a request
trace carries no credential. A host that sets `HttpClient.TracerHeaderFilter` to
record headers gets these headers as `<redacted>`, including
`chatgpt-account-id`.

A route's endpoint cannot carry a credential, but the executor takes any
request. On its HTTP span, a query parameter whose name is a credential reads
`<redacted>` in `url.full` and `url.query`. A span that failed records the
error's tag alone (see [Span failures](#span-failures)), never the HTTP
client's own error, which prints the url as sent. A host's
`HttpClient.SpanNameGenerator` receives the same redacted request.

`RequestExecutor.errorSanitizer(request)` captures the signed request's credential
values and active header policy. Routes retain that sanitizer through response
consumption, including after credential refresh. HTTP 200 protocol failures have
every free-form `ModelError` string field scrubbed and capped at 16 KiB before
reaching callers. Error codes and numeric retry metadata retain their meaning.

## `AnthropicMessages`

Anthropic Messages request lowering and streaming event parsing.

| Export     | Kind     | Behavior                                                                                                                                                                         |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Body`     | schema   | The deterministic `POST /v1/messages` body. `max_tokens` is required by the API; the lowering fills it from `params.maxTokens`, defaulting to `4096`. `stream` is always `true`. |
| `protocol` | protocol | Id `anthropic-messages`. SSE framing, supports the native deferred-tool allowlist, and flushes unfinished parts on stream end.                                                   |

### Prompt caching

Anthropic caches only at explicit `cache_control` breakpoints, and a request
reads an entry only where an earlier request wrote one. The lowering spends
two of the four breakpoints a request allows, both with the default
five-minute TTL:

- The last system block, which also covers the tools rendered before it.
  Without a system prompt, the last immediately loaded tool.
- The last block that can carry one (not a thinking block) in the last of the
  first `cacheBoundary` messages, or the last message when `cacheBoundary` is
  unset. Messages the lowering drops are counted before they are dropped.

A caller that appends a volatile block after its transcript sets
`cacheBoundary` to the transcript length. `CellTurn` does this for its state
section, so each frame's breakpoint lands on bytes the next frame repeats and
moves forward a few blocks per frame, well inside Anthropic's 20-block
lookback. Live on `claude-opus-5` (2026-09-24), a five-frame run with a
4,378-token prefix wrote it once and read it back on every later frame:

```text
frame  cache_write  cache_read  input
0      4378         0           16
1      39           4378        16
2      38           4417        16
3      38           4455        16
4      38           4493        16
```

A prefix shorter than the model's minimum cacheable length (512 to 4,096
tokens depending on the model) is not cached and costs nothing extra.

Lowering specifics: `stopSequences` are sent only when non-empty;
`thinkingBudget` becomes `thinking: { type: "enabled", budget_tokens }`. An
assistant turn with `stopReason` `"aborted"` or `"error"` is omitted from the
next request as a unit, because replaying a provider-interrupted turn can
make the request permanently invalid. Thinking blocks replay only with their
signature; a redacted block round-trips through a `redacted:` signature
prefix. Tool-call argument text that is not a JSON object fails preparation
as `invalid_request`. A non-empty request whose first lowered message is an
assistant message also fails preparation as `invalid_request`, with path
`messages[0].role`, before any network call. Stop reasons map `end_turn`, `stop_sequence`, and
`pause_turn` to `"stop"`; `max_tokens` to `"length"`; `tool_use` to
`"tool-calls"`; `refusal` to `"content-filter"`. `message_stop` is the
`terminal` predicate, so the route stops pulling there. Classification recognizes
Anthropic's HTTP 400 "credit balance is too low" wording as
`quota_exceeded`, and `overloaded` and 529 as `rate_limited` so the agent can park durably.

## `OpenAIResponses`

OpenAI Responses request lowering and SSE event handling.

| Export            | Kind      | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Body`            | schema    | The Responses request body. `stream` is always `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ChatGPTBody`     | schema    | The body narrowed to the ChatGPT-subscription surface: `store` must be `false`, `include` is exactly `["reasoning.encrypted_content"]`, and `max_output_tokens` is absent because the backend rejects it.                                                                                                                                                                                                                                                                                                      |
| `State`           | interface | What the adapter carries between events: partially assembled tool calls, opened ids, and the response identity a continuation replays.                                                                                                                                                                                                                                                                                                                                                                         |
| `protocol`        | protocol  | Id `openai-responses`. Reasoning continuation by stored item reference.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `chatgptProtocol` | protocol  | Id `openai-responses-chatgpt`. The same SSE stream and usage counters, with reasoning continuation carried in `encrypted_content` and a request's `cacheKey` sent as both `prompt_cache_key` and the `session-id` header the backend derives cache affinity from. The route echoes the backend's `x-codex-turn-state` response header on every later request with the same `cacheKey`, outside the sealed request view. Native deferred tools only for the GPT-6 ids probed live on this backend (2026-09-24). |

Lowering specifics: the system prompt joins into `instructions` with
newlines; `reasoningEffort` becomes `reasoning.effort`; an aborted or errored
assistant turn is omitted. Stored reasoning item ids replay as
`item_reference` entries on the API-key protocol, and as whole encrypted
reasoning items on the ChatGPT protocol, where item references would fail.
`response.completed` settles `"stop"` or `"tool-calls"`; `response.incomplete`
settles `"content-filter"` when its reason is `content_filter` and `"length"`
otherwise. Both terminal events carry the response id and its usage counters,
and both are the protocol's `terminal` predicate, so the route stops pulling
there. A function call still open at `response.completed` closes from the
final response `output` through the same strict argument validator a done
event uses; a call the final output does not finish fails the stream as
`invalid_provider_output` instead of settling a tool turn.

## `OpenAIChatCompletions`

OpenAI Chat Completions request lowering and SSE event handling: the older,
widely cloned OpenAI wire shape that Ollama, Gemini's compatibility layer,
Cerebras, and most other "OpenAI-compatible" servers implement.

| Export                   | Kind        | Behavior                                                                                                                                                                                         |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Body`                   | schema      | The Chat Completions request body. `stream` is always `true` and `stream_options.include_usage` is always set, so usage arrives on the stream. `reasoningEffort` becomes `reasoning_effort`.     |
| `ResponseFormat`         | schema      | The `response_format` field that turns on native structured output: a named JSON Schema with a `strict` flag.                                                                                    |
| `StructuredOutput`       | interface   | `{ name, schema, strict? }`. Presence is the toggle: a route built without it leaves schema enforcement to the prompt. `strict` defaults to `true`.                                              |
| `State`                  | interface   | What the adapter carries between chunks: whether the single id-less text part has opened, and the in-flight tool calls keyed by stream position, because a delta only repeats the array `index`. |
| `protocolWith(options?)` | constructor | Builds the protocol, optionally with native structured output. Without the option the lowering is byte-for-byte the historical one, so existing sealed step keys are unchanged.                  |
| `protocol`               | protocol    | `protocolWith()` with structured output off. Id `openai-chat-completions`.                                                                                                                       |

A route configured with `structuredOutput` preserves declared tools alongside
`response_format`. `toolChoice: "none"` omits tools. Finish reasons map `stop`, `length`, `tool_calls`, and
`content_filter` onto the matching stop reasons; only `stop` normalizes to
`"tool-calls"` when a call completed, since Gemini finishes a successful tool
turn that way, while `length` and `content_filter` after a completed call stay
what they are. The final usage chunk is the `terminal` predicate: OpenAI and
Ollama send it separately with no choices; Cerebras includes usage in the
finish chunk. Both end the stream without waiting for HTTP EOF. A finish
without usage still waits for the trailing counters. `[DONE]` never reaches
the protocol. A purely numeric provider
code in the HTTP range stands in for a missing status, which is how a gateway
that reports `{"error":{"code":429}}` inside an HTTP 200 stream still
classifies as `rate_limited`.

`params.reasoningEffort` is sent as `reasoning_effort`, and an unstated effort
leaves the field out so the provider's own default stands. This is a
deliberate change to this route's canonical bytes: a request that states an
effort now keys differently from the same request before it. Cerebras's
`qwen-3.8-27b` reasons at `high` when the body says nothing, so until the
field was sent a stated effort bought nothing and the caller paid for
reasoning it had declined. `topK`, `stopSequences`, and `thinkingBudget` are
still dropped.

## `OpenAIChatGPT`

Route construction for OpenAI's ChatGPT-subscription Responses backend, the
deployment the codex CLI speaks.

| Export                               | Kind        | Behavior                                                                                                                                                                                     |
| ------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultBaseUrl`                     | constant    | `https://chatgpt.com/backend-api`. The Responses call is served at `/codex/responses` under it, with no `/v1` prefix.                                                                        |
| `clientHeaders`                      | constant    | The client identity headers the backend was confirmed against: `accept: text/event-stream`, `openai-beta: responses=experimental`, `originator: codex_cli_rs`, and the codex CLI user agent. |
| `make({ auth, baseUrl?, headers? })` | constructor | `Result<Route, ModelError>` with id `openai-chatgpt`. Extra headers merge over `clientHeaders`.                                                                                              |

The credential is an OAuth access token plus a `chatgpt-account-id` header,
both rotating, so the route takes a composed `Auth` rather than a redacted
key: the host owns the token store and its refresh. The backend rejects
`max_output_tokens` outright and offers no other output cap, so a request
that sets `params.maxTokens` fails in `Route.prepare` as `invalid_request`
with `path: "params.maxTokens"`, before signing and transport, rather than
being sent without the budget the caller asked for. Omit `maxTokens` on this
route; every other route sends it.

## `DeferredTools`

Replay-safe policy for native deferred provider tool loading.

| Export                                  | Kind      | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ProtocolId`                            | type      | `"anthropic-messages" \| "openai-responses" \| "openai-responses-chatgpt"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Resolution`                            | interface | `{ immediate, deferred, activatedNames }`: the tool partition derived from a sealed request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `supportsDeferred(protocolId, modelId)` | predicate | Answers from explicit per-protocol allowlists, matched case-insensitively. GPT-6 Sol, GPT-6 Astra, and GPT-6 Luna answer `true` on both OpenAI protocols, from OpenAI's tool search guide and a live probe recorded 2026-09-24 in `test/fixtures/gpt6-deferred-probe.json`. GPT-6.1 Sol answers `true` on the API-key protocol only, from the guide; it has not been probed on the ChatGPT backend. An unlisted model, including a family released after this code, answers `false` and receives every tool through the portable lowering, because native deferral changes the wire body and an unverified body must not ship without a release. |
| `resolve(request, native)`              | operation | Derives the partition from declared `deferred` annotations and the chronological transcript only: tool calls made, and `addedToolNames` activations. No process-local state is consulted, so replay produces the identical partition.                                                                                                                                                                                                                                                                                                                                                                                                            |

Without native support, deferred tools arrive as ordinary definitions once
activated or once used before their activation. With native support, lazy
tools lower with the provider's defer flag, a `loader` tool stays immediate,
and a partition with no immediate tools collapses to all-immediate.

## `ToolStream`

Pure accumulation of fragmented provider tool-call arguments.

`OpenToolCall.fragments` is an immutable `Chunk<string>` in arrival order.
Deltas share prior chunks without copying all previous fragments; completion
and abort settlement flatten the chunks once. Earlier states remain reusable.
Use `Chunk.toReadonlyArray(call.fragments)` when an array is needed.

| Export                           | Kind        | Behavior                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `State`                          | interface   | `{ open: OpenToolCall[] }`: the accumulator.                                                                                                                                                                                                                                                                                                |
| `OpenToolCall`                   | interface   | `{ callId, name, fragments }`: an unfinished call.                                                                                                                                                                                                                                                                                          |
| `Completed`                      | interface   | `{ callId, name, arguments }`: a finished call with validated argument text.                                                                                                                                                                                                                                                                |
| `EndResult`                      | type        | `{ state, completed } \| ModelError`.                                                                                                                                                                                                                                                                                                       |
| `FlushResult`                    | interface   | `{ state, completed[] }`.                                                                                                                                                                                                                                                                                                                   |
| `initial()`                      | constructor | An empty accumulator.                                                                                                                                                                                                                                                                                                                       |
| `start(state, { callId, name })` | operation   | Opens a call, replacing any stale entry with the same id.                                                                                                                                                                                                                                                                                   |
| `delta(state, callId, fragment)` | operation   | Appends an argument fragment.                                                                                                                                                                                                                                                                                                               |
| `end(state, callId)`             | operation   | Completes a call. Empty fragments complete as `"{}"`. An unknown id fails with `invalid_provider_output` (`Received completion for unknown tool call <id>`), and reassembled text that is not a JSON object fails the same way (`Invalid JSON input for streamed tool call <name>`), because a live stream must not hand a guess to a tool. |
| `flushAborted(state)`            | operation   | Settles every open call after a stream halt, preserving partial text verbatim for the journal. This is the non-executing half of the split: built-in lowerings omit aborted turns from continuations, while a live completion still passes the strict validator.                                                                            |

## `Classifier`

Typed questions about a JSON state, answered by Jev through an `Evaluator`.
A host declares a classifier once and gets typed answers: a choice's option
names become a literal union, a score's rungs become its labels.

```ts
import { Classifier, Evaluator } from "@smthrs/model"
import { Config, Effect, Schema } from "effect"

const Relevance = Classifier.make("triage/relevance", {
  description: "Whether a file must change for the task, and its role.",
  state: Schema.Struct({ task: Schema.String, file: Schema.String, excerpt: Schema.String }),
  questions: {
    relevant: Classifier.boolean({
      instructions: "Does this file need to change for the task?",
      criteria: { true: "the fix or its test lives here", false: "unrelated or only imported" }
    }),
    role: Classifier.choice({
      instructions: "What is this file's role?",
      criteria: {
        implementation: "code under test",
        fixture: "test data or setup",
        unrelated: "nothing to do with the task"
      }
    }),
    risk: Classifier.score({
      instructions: "How risky is editing this file?",
      criteria: ["none", "low", "medium", "high"]
    })
  }
})

const program = Effect.gen(function*() {
  const answer = yield* Relevance.evaluate({ task, file, excerpt })
  const many = yield* Relevance.evaluateAll(states, { concurrency: 8 })
  return Classifier.confident(answer.role, 0.7)
})

const live = Evaluator.layerVercelGateway({ apiKey: Config.Redacted("AI_GATEWAY_API_KEY") })
```

| Export                                        | Kind        | Behavior                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `make(id, { description, state, questions })` | constructor | Returns `{ id, description, state, questions, digest, evaluate, read, evaluateAll }`. `digest` is the SHA-256 of the canonical JSON of `{ id, questions }` with the questions in the wire form `Evaluator.encodeQuestions` writes, so a durable call key that folds it in never replays an answer to a question that has since changed.    |
| `boolean({ instructions, criteria? })`        | constructor | A yes/no question. `criteria` says what each side means.                                                                                                                                                                                                                                                                                   |
| `choice({ instructions, criteria })`          | constructor | One of the named options in `criteria`, 2 to 255 of them. Fewer or more fails the field's schema check, which throws at construction.                                                                                                                                                                                                      |
| `score({ instructions, criteria })`           | constructor | A position along an ordered rubric of at least 2 distinct rungs. Fewer, or a repeated rung, fails the field's schema check, which throws at construction.                                                                                                                                                                                  |
| `evaluate(state)`                             | method      | `Effect<AnswersOf<questions>, ClassifierError, Evaluator>`. Encodes the state through its schema, sends one request, decodes the raw answers against the questions.                                                                                                                                                                        |
| `read(state)`                                 | method      | `Effect<Reading<questions>, ClassifierError, Evaluator>`. Sends exactly the request `evaluate` sends, and answers what the reading cost beside its answers.                                                                                                                                                                                |
| `Reading<Qs>`                                 | interface   | `{ answers: AnswersOf<Qs> }` with every other field of `Evaluator.Response`: `usage?`, `latencyMs`, `timing?`, `confidence?`, `decidedBy?`, `responseId?`, `servedTier?`.                                                                                                                                                                  |
| `evaluateAll(states, { concurrency? })`       | method      | `Effect<ReadonlyArray<Result<AnswersOf<questions>, ClassifierError>>, never, Evaluator>`. One request per state, at most `concurrency` in flight (`defaultConcurrency`, 8), results in the states' order, each state's failure its own.                                                                                                    |
| `BooleanAnswer`                               | interface   | `{ value: boolean; probability: number }`. `value` is `probability >= 0.5`.                                                                                                                                                                                                                                                                |
| `ChoiceAnswer<Key>`                           | interface   | `{ value: Key; probabilities: Record<Key, number>; confidence: number }`. `confidence` is the largest probability in the distribution.                                                                                                                                                                                                     |
| `ScoreAnswer<Label>`                          | interface   | `{ value: number; label: Label; probabilities: Record<string, number>; confidence: number }`. `value` is the score as Jev gave it, interpolated over zero-based rung indexes; `label` is the nearest rung; `probabilities` is keyed by rung label whether the wire keyed it by label or by index; `confidence` is the largest probability. |
| `AnswerOf<Q>`, `AnswersOf<Qs>`                | types       | The answer a question infers, and the answers a question map infers.                                                                                                                                                                                                                                                                       |
| `confidence(answer)`                          | getter      | 0 to 1: a boolean's distance from even odds doubled, `abs(p - 0.5) * 2`; a choice's or score's `confidence`.                                                                                                                                                                                                                               |
| `confident(answer, floor)`                    | getter      | `Option` of the answer's value when `confidence(answer) >= floor`.                                                                                                                                                                                                                                                                         |
| `decodeAnswers(questions, raw)`               | decoding    | `Effect<AnswersOf<questions>, ClassifierError>`. Shared by the typed path and the ad-hoc path.                                                                                                                                                                                                                                             |
| `Question`, `Answer`                          | schemas     | Effect Schemas for the ad-hoc path: a model-authored question is decoded with `Question` (the same value as `Evaluator.Question`, construction limits included) before it reaches the transport, and a decoded answer in any of the three shapes matches `Answer`.                                                                         |
| `ClassifierError`                             | error       | `{ code, status?, resetAtEpochMillis?, message, usage? }` with `code` from `Evaluator.EvaluatorErrorCode`; `usage` is what the reading paid, kept from the transport's failure or from an answer the classifier could not decode. Typed, never thrown.                                                                                     |

Decoding is strict. Every question needs an answer of its own type; a
boolean's probability and every distribution entry lie in `[0, 1]`; a choice
names one of its options; a score lies within the rubric's index range.
Anything else fails as `invalid_answer`, naming the question. A state the
schema does not encode fails as `invalid_question`. A distribution the
transport did not send is one-hot on the chosen option or nearest rung, so
`confidence` reads 1; a caller that has to tell the two apart keeps the raw
`Evaluator.Response`.

A score distribution uses one key format throughout. When every key is a valid
zero-based rung index, decoding uses indexes, including when numeric labels
overlap those indexes. Otherwise every key must be a declared rung label.
Missing entries become zero; a dictionary that fits neither format fails as
`invalid_answer`. This follows Jev's indexed response while accepting
unambiguous label-keyed responses from other evaluators.

`Classifier.make` snapshots and freezes the question map, questions and nested
criteria. Mutating the caller's declaration cannot change the evaluated questions
or answer decoding under the original digest.

Question names, option names and rubric labels are JSON object keys, including
`__proto__`, `constructor` and `toString`. Decoding reads only own properties
and preserves these names in the answer and probability records.

## `Evaluator`

The transport a classifier asks: one JSON state and a map of typed questions
go out, one raw answer per question comes back. Flow hosts use `layerFromSeat`
with their existing subscription resolver and reject malformed verdicts.

`layerVercelGateway` remains an explicit library adapter for consumers of Jev's
HTTP evaluation protocol. It reads no environment configuration and is never
selected by a flow host or used as a subscription fallback.

`EvaluatorBackup.withFallback(primary, backup)` asks the backup only when the
primary is unreachable, times out, or refuses with a 5xx or 429. An
unconfigured primary (for example, no `AI_GATEWAY_API_KEY`) fails with its own
typed `unconfigured` error and never falls back. When both evaluators fail,
the backup's failure is retained. A primary 429 still
takes precedence over a backup transport or configuration failure, while
retaining the backup's actual paid usage. A primary failure carrying paid
usage never calls the backup, avoiding a second paid reading.

`EvaluatorBackup.fromModel(model, modelId)` judges through any `Model` with
`layerFromSeat`, with no tools, at `reasoningEffort: "medium"`. GPT-6 Luna at
`low` spends no reasoning tokens and misread a finished completion as not done
in 10 of 12 readings on 2026-10-13. The prompt tells the seat that a boolean
`probability` is the chance the answer is yes, because a seat told only
"probability" answers its confidence and flips a question asked in the
negative. Its response carries `decidedBy: "seat"`.

A generation seat reads a question's criteria word for word, which is not
always how Jev reads them. A request may therefore carry a `seatNote`: one
paragraph saying how a seat should read the questions' words.
`Classifier.make(id, { ..., seatNote })` puts it on every request the
classifier sends, and `layerFromSeat` appends it to the instructions above.
`layerVercelGateway` never sends it, and `Classifier.digest` does not cover
it, so nothing Jev is sent and no durable key changes.

`layerFromSeat` also reads a verdict the seat wrapped in one Markdown code
fence. Text before or after the JSON still fails `invalid_answer`.

| Export                                                                                                                                                   | Kind                      | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Evaluator`                                                                                                                                              | service interface and tag | `evaluate({ state, questions }) => Effect<{ answers, confidence?, usage?, latencyMs, decidedBy?, timing?, responseId?, servedTier? }, EvaluatorError>`. `confidence` is the provider's own number per question, read from `providerMetadata.typesafe.confidence` and absent when the transport sent none. `usage` is `{ inputTokens, outputTokens, modelId? }`; `modelId` names the model that read, which prices it. `decidedBy` is `seat` when `layerFromSeat` answered, else absent. `timing` is the reading's [wire timing](#wire-timing): `layerFromSeat` copies it, with `responseId` and `servedTier`, from the seat call's `settle` event, and `layerVercelGateway` times its own request (`attempts`, `requestBytes`, `preparedMs`, `signedMs`, `sentMs`, `headersMs`, `closedMs`, `failedTries`; one JSON body has no stream stages). Tag id `/model/Evaluator`. |
| `layerVercelGateway(options)`                                                                                                                            | layer                     | Jev through the Vercel AI Gateway over the kernel `HttpClient`. One request and one deadline per evaluation; refusals and connection failures return to the durable caller for retry scheduling. Options: `apiKey` (a `Redacted` or a `Config` read at construction), `model` (`typesafe-ai/jev`), `timeoutMs` (3000), `attempts` (deprecated; ignored), `zeroDataRetention` (true), `baseUrl` (`https://ai-gateway.vercel.sh/v4/ai/evaluation-model`, validated by `Endpoint.makeSecure` before the key is signed onto it; an invalid one fails `unreachable` without a request). A 200 body is read up to `maxResponseBytes` (1 MiB) and fails `empty` past it. Every request runs as a `model:call` on the model.                                                                                                                                                       |
| `layerScripted(script)`                                                                                                                                  | layer                     | Answers from `(request) => answers` or `(request) => Effect<answers, EvaluatorError>`. A scripted answer may omit its `type`; the layer fills it from the question and decodes the result like a gateway body, so a script answering the wrong shape fails as `invalid_answer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `layerFromSeat(seat, { timeoutMs? })`                                                                                                                    | layer                     | Judges through an existing resolved seat's model and credentials. Accepts `{ modelId, model }`, including subscription seats. No gateway key or alternative auth path. Invalid, missing, out-of-range and truncated verdicts fail closed. Rate and quota limits become `refused` with `status: 429` and the reset time when known; provider diagnostics stay redacted. The default deadline is 120 seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `layerUnavailable()`                                                                                                                                     | layer                     | Fails every request as `unreachable`; a classifier outage fixture, and the binding for a host composed to drive no run, never a completion-capable host's default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Question`, `RawAnswer`, `RawAnswers`                                                                                                                    | schemas                   | The wire shapes. A boolean answer is `{ type: "boolean", probability }`, a choice `{ type: "choice", choice, probabilities? }`, a score `{ type: "score", score, probabilities? }`. The question schema enforces 2 to 255 choice options and at least 2 distinct score rungs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `EvaluatorErrorCode`                                                                                                                                     | schema                    | `unconfigured` (no gateway key and no subscription judge, a policy fault), `unreachable` (no response), `refused` (a status other than 200, 400 or 422, kept in `status`), `empty` (a 200 whose body carried no answers or could not be read), `timeout` (this call's deadline), `invalid_answer`, `invalid_question` (a 400 or 422, or a rejected question).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `EvaluatorError`                                                                                                                                         | error                     | `{ code, status?, resetAtEpochMillis?, message, usage? }`. Evaluation failures, including missing subscriptions, are typed. `usage` is what a reading that failed after it was metered paid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `defaultBaseUrl`, `defaultModel`, `defaultTimeoutMs`, `defaultAttempts`, `retryBackoffMs`, `maxResponseBytes`, `protocolVersion`, `specificationVersion` | constants                 | The gateway defaults, the 1 MiB answer cap, and the protocol versions sent as `ai-gateway-protocol-version` (`0.0.1`) and `ai-evaluation-model-specification-version` (`4`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The wire protocol is the AI SDK gateway provider's own, as recorded on
2026-09-17. Vercel may change it without notice; a changed response surfaces
as `empty` or `invalid_answer`, never as a guessed answer. The request body
is `{ state, questions, providerOptions: { gateway: { zeroDataRetention } } }`
and the gateway key rides in the `authorization` header. Request traces record
no header by default and redact this one when a host records headers.

The encoded state must be a JSON value. Values that JSON would discard or
reshape, including `undefined`, `bigint`, non-finite numbers, cycles and class
instances, fail as `invalid_question` before an HTTP request is sent. A typed
classifier may use a codec with a non-JSON decoded value when its encoded
representation is valid JSON.

The gateway accepts string, array and object states directly. For a number,
boolean or `null`, this transport sends `{ state: originalValue }` and prefixes
each question's instructions to ask about the original value, not the wrapper.
The caller's state and questions are unchanged; batch results retain the
original state.

## `ModelCatalog`

Static facts about known provider models, read from a model id alone.

| Export                              | Kind     | Behavior                                                                                                                                                                                                                                   |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contextWindowTokensFor(modelId)`   | resolver | The context window in tokens, matched case-insensitively against the id. A million-token row is anchored to the bare id, so a cloud-prefixed or suffixed id falls through to the conservative row. Unknown ids answer 128,000, never zero. |
| `knownContextWindowTokens(modelId)` | resolver | The same match, but `undefined` for an id no row names, so a caller that must not show an unmeasured window can omit it.                                                                                                                   |

`@smthrs/agent` re-exports this as `SeatResolver.contextWindowTokensFor`, and
the built-in harness calls it for the compaction budget of a seat whose host
supplies no `contextWindowTokensFor` callback of its own.

## `Pricing`

USD prices per million tokens, from the one rate card in the tree
(`src/internal/prices.generated.ts`). `inputTokens`
includes cache reads and cache writes; each class is charged at its own rate.

| Export                             | Kind     | Behavior                                                                                                                                                                                                    |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `table`                            | constant | Every priced model, keyed by wire model id. Spread it with your own rows to override a model or seat.                                                                                                       |
| `lookup(modelId, { table?, at? })` | resolver | The rate card in effect at `at`: an exact row, else the bare model of a seat (`openai:gpt-5.6-sol`) or gateway id (`anthropic/claude-sonnet-5`), else a dated snapshot's family. `undefined` when unpriced. |
| `weigh(usage, rates)`              | function | The rate-weighted token sum. `NaN` for missing input or output counts, invalid counters, or cache classes larger than the input count.                                                                      |
| `costUsd(usage, price)`            | function | USD for one call. A long-context card prices the whole call from its threshold.                                                                                                                             |
| `cost(usage, modelId, options?)`   | function | `{ costUsd, costSource }`: `"reported"` when the usage carries a valid provider charge, else `"estimated"` from the rate card; `undefined` when neither exists.                                             |

Arithmetic overflow leaves estimated usage unpriced: `weigh` and `costUsd`
return `NaN`, and `cost` returns `undefined`. A valid provider-reported cost
still takes precedence.

`@smthrs/agent`'s `Budget` writes `costUsd` and `costSource` on each usage
record and spend-ledger entry, and takes `prices` rows over `table`.

## `CanonicalJson`

Deterministic JSON encoding for model-step inputs.

| Export             | Kind     | Behavior                                                                                                                            |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `stringify(value)` | encoding | Serializes with recursively sorted object keys; array order is retained.                                                            |
| `bytes(value)`     | encoding | The canonical encoding as UTF-8 bytes.                                                                                              |
| `shortHash(input)` | hashing  | A dependency-free, deterministic two-lane hash, kept so synthetic OpenAI tool-search call ids stay stable across transcript replay. |

`stringify` is stricter than `JSON.stringify` on purpose. A value
`JSON.stringify` would drop or reshape (`undefined`, a function, a symbol, a
non-finite number, a class instance such as `Date` or `Map`, a symbol-keyed
member, a cycle, or an array that is sparse, carries named or symbol-keyed
members (such as a `RegExp` match result), or is an Array subclass or from
another realm) is rejected with `TypeError: Value at <path> is not valid
JSON`, because a model request body is sealed-step key material and the key
must describe the bytes sent. Everything both encoders accept they encode
identically, including an own member literally named `__proto__`. The
[`@smthrs/canonical` encoder](/api/canonical) mirrors `JSON.stringify` and is
the right choice everywhere that is not a provider request body.

Provider framing has two finite budgets. `Framing.sse` and `Framing.ndjson`
accept at most 4 MiB per record and 64 MiB per complete raw response, both
inclusive. `Framing.makeSse` / `makeNdjson` accept `maxRecordBytes` and
`maxResponseBytes` overrides; each must be a positive safe integer.

NDJSON measures record UTF-8 bytes excluding its terminator. SSE measures all
lines of one event, including ignored fields/comments, with CR/CRLF normalized
to LF and excluding the terminating blank line. Response bytes count every raw
byte, including delimiters. Guards run before text decoding/line buffering and
stop pulling the producer when a budget is exceeded. The error is
`invalid_provider_output`, with a limit-only message. A scoped producer is
released on failure or interruption.

The total response budget is the alternative aggregate argument contract:
fragmenting tool arguments across individually valid events cannot bypass it.
It bounds provider text admitted by built-in routes; direct standalone use of
`ToolStream` or a custom `Framing` implementation remains caller-owned.
Framing retains O(record budget) partial text plus the current upstream chunk;
the transport owns chunk allocation. Protocol/transcript state can retain
O(response budget) text, and collection consumers also own their retained output.

UTF-8 decoding retains the existing replacement-character policy for malformed
sequences. SSE drops an incomplete final event; NDJSON emits its partial final
line so JSON decoding can report truncation. Transport failures propagate;
retry directives in SSE do not terminate the response or discard later events.

## Live test gate

The model test suite uses local fixtures by default. Live evaluator, Gemini,
and Cerebras cases require `SMITHERS_LIVE_MODEL_TESTS=1` and their matching
provider key. An ambient key alone does not enable provider traffic.

## Chat span provider

Routes declare `providerName` independently of their route id and protocol.
`Route.anthropic` declares `anthropic`; `Route.openai` and `OpenAIChatGPT.make`
declare `openai`. Custom routes and compatible constructors require an explicit
OpenTelemetry provider name, such as `gcp.gemini` or `openrouter`.
`Route.toModel` carries that name to the agent chat span as `gen_ai.provider.name`.
Custom model implementations can declare `providerName`; provider-neutral test
models omit it. Prompt and response content remain absent from spans.

## Span failures

A span this package opens withholds a failure's text from the exporter. That
covers `chat <modelId>` from `Model.withGenAiSpan` and every span opened under
it, `flows/model/Route.prepare`, `flows/model/Route.stream`, `Auth.sign`,
`RequestExecutor.execute` and the HTTP client span under it, each protocol's
`fromRequest` and `step`, `Evaluator.evaluate` and `Classifier.evaluate(<id>)`.

These spans end through `@smthrs/flow`'s `SpanFailure`. The span's status
message and `exception` event name each failure by its tag, or a defect by its
class name, and give a tagged failure's code, such as a `ModelError`'s, as the
message when the code is a lowercase token: `flows/model/ModelError:
rate_limited` for a refusal, `TypeError: redacted` for a defect. The stack trace is that line
and the source locations Effect recorded for the span. The provider's message,
response body and stack never reach a span. The stream or effect still fails
with the original error, so a caller reads the provider's message and branches
on its code as before.

`retryBackoffMs` is a deprecated compatibility constant. The evaluator performs no retry sleeps.
