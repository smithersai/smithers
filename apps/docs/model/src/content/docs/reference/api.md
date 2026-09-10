---
title: "API reference"
description: "Every public export of @smthrs/model: the Model service, routes, protocols, streaming events, errors, and the executor."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/api.md"
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
host provides; see the [kernel API](https://kernel.smithers.sh/reference/api/) for that contract.

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

Responses and Chat Completions are different wire shapes, not two names for
one. `api.openai.com` serves Responses. Ollama, Gemini's compatibility layer,
Cerebras, OpenRouter's chat route, and most other self-hosted or third-party
"OpenAI-compatible" servers serve Chat Completions.

## `Model`

The one provider seam: a request in, a stream of events out. A flow, a
harness, or a test swaps the implementation without knowing which protocol,
endpoint, or credential answers the call.

| Export                  | Kind                      | Behavior                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Model`                 | service interface and tag | `stream: (request: ModelRequest) => Stream<ModelEvent, ModelFailure>`. Cancellation is fiber interruption, so there is no abort parameter. Tag id `/model/Model`.                                                                              |
| `ModelFailure`          | type                      | `ModelError \| PermissionRequired \| PermissionDenied \| GrantStoreError`. The permission classes come from `@smthrs/capability`; see the [capability API](https://capability.smithers.sh/reference/api/).                                                                   |
| `make(implementation)`  | constructor               | Builds a `Model` from an implementation of `stream`.                                                                                                                                                                                           |
| `layer(implementation)` | layer                     | Provides `Model` from an implementation of `stream`.                                                                                                                                                                                           |
| `makeNoop(overrides?)`  | constructor               | A `Model` that fails every stream with `ModelError` code `no_route` and message `no model route in this environment`, so an environment with no provider configured reports that rather than hanging. `overrides` replaces individual methods. |
| `layerNoop(overrides?)` | layer                     | Provides `makeNoop`.                                                                                                                                                                                                                           |

## `ModelRequest`

The serializable, credential-free declaration of one model call. All values
are Effect Schema classes or structs, so a request encodes to plain JSON. The
field declaration order of `ModelRequest` is load-bearing: it is the stable
serialization order a sealed model step keys on.

| Export                 | Kind     | Behavior                                                                                                                                                                                                                                                      |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelRequest`         | class    | Fields: `modelId`, `system`, `messages`, `tools`, `params`, optional `toolChoice`. `ModelRequest.make(input)` accepts a plain object.                                                                                                                         |
| `Message`              | union    | `UserMessage \| AssistantMessage \| ToolMessage`, tagged by `role`. Constructors: `Message.user(text \| part \| parts)`, `Message.assistant(content, { stopReason?, responseId?, itemIds? })`, `Message.tool(part \| parts)`.                                 |
| `UserMessage`          | class    | `role: "user"`, `content: TextPart[]`. Text only; tool output enters through a tool message.                                                                                                                                                                  |
| `AssistantMessage`     | class    | `role: "assistant"`, `content: AssistantContentPart[]`, `stopReason`, optional `responseId` and `itemIds` (provider item ids a continuation replays).                                                                                                         |
| `ToolMessage`          | class    | `role: "tool"`, `content: ToolResultPart[]`: the results of the calls the previous assistant message asked for.                                                                                                                                               |
| `TextPart`             | struct   | `{ type: "text", text }`, with `TextPart.make({ text })`.                                                                                                                                                                                                     |
| `ThinkingPart`         | struct   | `{ type: "thinking", text, signature? }`. `signature` is the provider's attestation and must be echoed back unchanged on later requests.                                                                                                                      |
| `ToolCallPart`         | struct   | `{ type: "tool-call", id, name, arguments }`. `arguments` stays JSON text so it survives a round trip byte for byte.                                                                                                                                          |
| `ToolResultPart`       | struct   | `{ type: "tool-result", toolCallId, content, addedToolNames }`. `addedToolNames` names the tools the result made available; it defaults to `[]`.                                                                                                              |
| `SystemPart`           | struct   | One text segment of the system prompt. The prompt is a list so a cache breakpoint can fall between segments.                                                                                                                                                  |
| `ContentPart`          | union    | `TextPart \| ThinkingPart \| ToolCallPart \| ToolResultPart`, tagged by `type`.                                                                                                                                                                               |
| `AssistantContentPart` | union    | `ContentPart` without `ToolResultPart`.                                                                                                                                                                                                                       |
| `StopReason`           | literals | `"stop" \| "length" \| "tool-calls" \| "content-filter" \| "error" \| "aborted" \| "unknown"`. `"aborted"` is this layer's own value for an interrupted stream; no provider reports it.                                                                       |
| `ToolDefinition`       | class    | `{ name, description, parameters, deferred?, loader? }`. `parameters` is a JSON Schema object. A lazy (`deferred`) tool is wire metadata only: it may never add prompt text, because that would change the sealed-step key of every request that declares it. |
| `GenerationParams`     | class    | Optional `maxTokens`, `temperature`, `topP`, `topK`, `stopSequences`, `thinkingBudget`, `reasoningEffort`. An omitted field leaves the provider default in place.                                                                                             |
| `ReasoningEffort`      | literals | `"none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"`. The provider-neutral vocabulary the adapters map onto their own.                                                                                                                             |
| `ToolChoice`           | literal  | Only `"none"`. The built-in encoders express it by omitting `tools` altogether, which is what both provider APIs require.                                                                                                                                     |
| `JsonObject`           | schema   | A plain JSON object. Decoding starts from `Schema.Json`, so class instances such as `Date` and `Map` cannot decode as empty records.                                                                                                                          |

## `ModelEvent`

The normalized events one model call emits. Every protocol lowers its own
wire vocabulary into these, so a consumer reads one stream shape whichever
provider answered.

| Export                                            | Kind       | Behavior                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Usage`                                           | struct     | Optional `inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens`, `cacheWriteTokens`, `totalTokens`. A missing count is not a zero count.                                                                                                                                   |
| `TextStart` / `TextDelta` / `TextEnd`             | structs    | Open, extend, and close a text part. `id` correlates the events of one part.                                                                                                                                                                                                              |
| `ThinkingStart` / `ThinkingDelta` / `ThinkingEnd` | structs    | The same for a reasoning part. `ThinkingStart.signature` carries the provider's attestation.                                                                                                                                                                                              |
| `ToolCallStart` / `ToolCallDelta` / `ToolCallEnd` | structs    | The same for a tool call. `ToolCallEnd.arguments` repeats the complete argument text when the provider sends it.                                                                                                                                                                          |
| `ToolResult`                                      | struct     | `{ type: "tool-result", id, output, isError? }`: a harness report, not part of the settled message.                                                                                                                                                                                       |
| `UsageEvent`                                      | struct     | `Usage` counters as a `type: "usage"` stream event.                                                                                                                                                                                                                                       |
| `Retry`                                           | struct     | `{ type: "retry", attempt, code, delayMillis }`: a bounded model-boundary retry, recorded so run reports can count transport recovery. `delayMillis` defaults to `0`.                                                                                                                     |
| `Settle`                                          | struct     | `{ type: "settle", stopReason, responseId?, itemIds? }`. Ends the stream and states why; a stream without one was interrupted. `itemIds` carries stored provider reasoning items a continuation replays by reference.                                                                     |
| `ModelEvent`                                      | union      | The tagged union of all of the above, with a constructor per member attached (for example `ModelEvent.TextStart({ type: "text-start", id })`) and `settledMessage` attached.                                                                                                              |
| `settledMessage(events)`                          | destructor | Folds an iterable of events into `{ message: AssistantMessage, usage: Usage }`. No `settle` event means interruption, represented as `stopReason: "aborted"` rather than an exception. Partial tool-call argument text is preserved verbatim; validate arguments before executing a tool. |

## `ModelError`

The provider-neutral failure vocabulary. Branch on `code`; provider message
text is not a contract and changes without notice.

`ModelError` is a `Schema.TaggedError` with tag `flows/model/ModelError` and
these fields:

| Field                | Type             | Meaning                                                                                                                                                                                           |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`               | `ModelErrorCode` | The stable serialized field and the public error contract.                                                                                                                                        |
| `message`            | `string`         | Human-readable detail, already scrubbed of credentials.                                                                                                                                           |
| `path`               | `string?`        | A key path only (for example `messages[2].content[0].text`), never a value, because a request member may hold a credential or user content. Present when the package refused to send the request. |
| `retryAfterMillis`   | `number?`        | The wait the provider asked for, when it asked.                                                                                                                                                   |
| `resetAtEpochMillis` | `number?`        | The durable wake instant for a parked run.                                                                                                                                                        |
| `resetSource`        | `string?`        | Which header or body field supplied the reset instant.                                                                                                                                            |
| `providerCode`       | `string?`        | The provider's own error code.                                                                                                                                                                    |
| `requestId`          | `string?`        | The provider's request id, from the usual `x-request-id` family of headers.                                                                                                                       |
| `httpStatus`         | `number?`        | The HTTP status, when a response was received.                                                                                                                                                    |

The failed provider response body is reachable as `error.body`, capped at
16 KiB, with `error.bodyTruncated` set when the cap bites. Both live outside
the error's schema and are non-enumerable, so a journal never copies a
provider body into run state.

The codes and their retryability:

| Code                      | Meaning                                               | Retryable |
| ------------------------- | ----------------------------------------------------- | --------- |
| `invalid_request`         | The request is malformed for this provider.           | no        |
| `context_overflow`        | The request did not fit the model's context window.   | no        |
| `no_route`                | No model is configured.                               | no        |
| `authentication`          | The credential was rejected.                          | no        |
| `rate_limited`            | A transient limit.                                    | yes       |
| `quota_exceeded`          | The account has no usable balance or quota.           | no        |
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

| Export                                     | Kind        | Behavior                                                                                                                                                        |
| ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelErrorCode`                           | schema      | The twelve-literal code vocabulary above.                                                                                                                       |
| `ModelError`                               | error class | As described above.                                                                                                                                             |
| `isContextOverflow(providerCode, message)` | refinement  | Whether a provider's own code and message describe a context overflow. Protocol adapters call it ahead of their generic bad-request branch.                     |
| `isQuotaExhausted(providerCode, message)`  | refinement  | Whether a provider's own code and message describe an exhausted account rather than a transient rate limit, so a durable consumer can park instead of retrying. |

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
| `anthropic({ apiKey })`                                                   | constructor | `Result<Route, ModelError>`. Sends `x-api-key` and `anthropic-version: 2023-06-01`.                                                                                                                                                                                                            |
| `openai({ apiKey })`                                                      | constructor | `Result<Route, ModelError>`. Bearer auth against `api.openai.com`.                                                                                                                                                                                                                             |
| `openaiResponsesCompatible({ id, baseUrl, apiKey, headers? })`            | constructor | A route for a provider that serves the Responses API without OpenAI's native deferred-tool extensions; `supportsDeferred` is forced off. `baseUrl` is the origin and the constructor appends `/v1/responses`, so `https://openrouter.ai/api` becomes `https://openrouter.ai/api/v1/responses`. |
| `openaiChatCompatible({ id, baseUrl, path?, apiKey, structuredOutput? })` | constructor | A route for a Chat Completions provider. `path` defaults to `/v1/chat/completions`. `apiKey` may be a non-empty placeholder for a server that does not check it; `Auth.bearer` only rejects an empty credential.                                                                               |

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
  ladders. When `Auth.refresh` is present, `Route.stream` runs it and retries
  the signed request exactly once, so an access token that expired mid-flight
  costs one recovery.
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

| Export                                | Kind        | Behavior                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Protocol<Body, Frame, Event, State>` | interface   | `{ id, supportsDeferred, body, stream, classifyError }`. `supportsDeferred(modelId)` reports native deferred-tool support. `classifyError(status, body)` maps a failed HTTP response to a `ModelError`.                                                                                     |
| `ProtocolBody<Body>`                  | interface   | `schema`: the validating codec for the provider body. `from(request, { native })`: lowers a `ModelRequest` into that body, failing with `ModelError`.                                                                                                                                       |
| `ProtocolStream<Frame, Event, State>` | interface   | `event`: the framed event codec. `initial(request)`: the state a call starts with. `step(state, event)`: folds one decoded event into `[state, ModelEvent[]]`. Optional `onHalt(state)`: final events when the upstream ends. Optional `terminal(event)`: stop taking events after a match. |
| `make(protocol)`                      | constructor | Returns the protocol value.                                                                                                                                                                                                                                                                 |
| `jsonEvent(schema)`                   | schema      | The JSON-string event codec shared by the SSE protocols.                                                                                                                                                                                                                                    |

## `Endpoint`

The credential-free HTTP target of a model route. An endpoint is public data:
it is part of a sealed step's key material, so nothing secret may appear in
it.

| Export             | Kind        | Behavior                                                                                                                                                  |
| ------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Endpoint`         | interface   | `{ method: "POST", url, query }`.                                                                                                                         |
| `MakeOptions`      | interface   | `{ url, path?, query? }`. `query` accepts pairs or a record.                                                                                              |
| `make(input)`      | constructor | `Result<Endpoint, ModelError>`. Validates and normalizes: query pairs are sorted by name then value, and the path is joined onto the URL's existing path. |
| `render(endpoint)` | formatting  | Renders the exact deterministic URL.                                                                                                                      |

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

| Export                    | Kind        | Behavior                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Auth`                    | interface   | `sign(headers)` returns the headers with the credential applied, failing with `ModelError`. Optional `refresh`: an effect `Route.stream` runs after an `authentication` failure before retrying once. `sign` may hold rotating state, but every dependency is captured at construction; the type has no requirements channel. |
| `Redacted<A>`             | type        | Effect's `Redacted`: a value whose string and JSON representations conceal its contents.                                                                                                                                                                                                                                      |
| `apiKeyHeader(name, key)` | constructor | Adds a redacted API key as an exact HTTP header.                                                                                                                                                                                                                                                                              |
| `bearer(key)`             | constructor | Adds a redacted API key as `Authorization: Bearer <key>`.                                                                                                                                                                                                                                                                     |

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

| Export                | Kind                      | Behavior                                                                                                                                                                                                                                               |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RequestExecutor`     | service interface and tag | `execute(request, options)` answers the response, failing with `RequestError`. It requires a `Scope`: the caller's scope owns the successful response body. Tag id `/model/RequestExecutor`.                                                           |
| `ExecuteOptions`      | interface                 | `{ modelId, classifyError? }`: the per-request policy the composed route supplies. Every request is wrapped in the kernel's `model:call` capability check for this `modelId`.                                                                          |
| `ErrorClassifier`     | type                      | `(status, body) => ModelError`: protocol-specific classification for a failed HTTP response.                                                                                                                                                           |
| `RequestError`        | type                      | `ModelError \| PermissionRequired \| PermissionDenied \| GrantStoreError`. Kernel permission failures keep their original classes across the model boundary.                                                                                           |
| `Transport`           | interface                 | `{ client, rebuild }`: the kernel HTTP client every request goes through, and the host's way of replacing it.                                                                                                                                          |
| `fixed(client)`       | constructor               | A transport whose rebuild answers the same client.                                                                                                                                                                                                     |
| `rebuildAfter`        | constant                  | `3`: how many consecutive transport failures replace the client. A destroyed connection pool is the failure waiting does not repair. Any success, and any non-transport failure, resets the counter, which is shared by every request on the executor. |
| `makeWith(transport)` | constructor               | `Effect<RequestExecutor>` over a transport it may replace.                                                                                                                                                                                             |
| `make`                | constructor               | `Effect<RequestExecutor, never, HttpClient>` around the kernel HTTP client in context.                                                                                                                                                                 |
| `layer`               | layer                     | `Layer<RequestExecutor, never, HttpClient>`: provides the executor, requiring the kernel HTTP client.                                                                                                                                                  |

The retry ladder: one call makes at most three attempts (the first plus two
retries), starting at 500 ms, doubling, jittered, capped at 10 s per wait and
60 s in total. Only a retryable error is retried. A `Retry-After` or
`retry-after-ms` header replaces the computed wait and is bounded by the same
10 s per-wait cap; a provider wait larger than the whole 60 s budget is not
slept at all, and the error surfaces immediately with its `retryAfterMillis`,
`resetAtEpochMillis`, and `resetSource` so the caller can park durably
instead of holding the process.

HTTP status classification maps 401 and 403 to `authentication`; 402 and the
quota vocabulary to `quota_exceeded`; 429 to `rate_limited`; content-policy
wording to `content_policy`; overflow wording to `context_overflow`; 400,
404, 409, 413, and 422 to `invalid_request`; 5xx and the retryable 503, 504,
and 529 to `provider_internal`; anything else to `unknown`. A protocol's
`classifyError` runs first and wins. Reset instants are also read from the
`x-ratelimit-reset-*` and `anthropic-ratelimit-*-reset` header families and
from reset fields in a JSON error body, preferring the exhausted resource's
window so a parked run wakes exactly once.

Diagnostics are scrubbed twice. Values the package knows to be credentials
are removed literally, in raw, URL-encoded, and JSON-escaped form. A JSON
error body is additionally walked and every value under a credential-shaped
key is replaced at any depth. A failed response body stops being read at
64 KiB, so nothing beyond that is held, parsed, classified, or redacted; the
recursive walks stop at depth 12, where a redacted subtree is replaced whole;
and the text kept on the error is capped at 16 KiB, reachable as
`ModelError.body` with `ModelError.bodyTruncated` set when either cap bites.

## `AnthropicMessages`

Anthropic Messages request lowering and streaming event parsing.

| Export     | Kind     | Behavior                                                                                                                                                                         |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Body`     | schema   | The deterministic `POST /v1/messages` body. `max_tokens` is required by the API; the lowering fills it from `params.maxTokens`, defaulting to `4096`. `stream` is always `true`. |
| `protocol` | protocol | Id `anthropic-messages`. SSE framing, supports the native deferred-tool allowlist, and flushes unfinished parts on stream end.                                                   |

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
`"tool-calls"`; `refusal` to `"content-filter"`. Classification recognizes
Anthropic's HTTP 400 "credit balance is too low" wording as
`quota_exceeded`, and `overloaded` and 529 as `rate_limited` so the agent can park durably.

## `OpenAIResponses`

OpenAI Responses request lowering and SSE event handling.

| Export            | Kind      | Behavior                                                                                                                                                                                                  |
| ----------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Body`            | schema    | The Responses request body. `stream` is always `true`.                                                                                                                                                    |
| `ChatGPTBody`     | schema    | The body narrowed to the ChatGPT-subscription surface: `store` must be `false`, `include` is exactly `["reasoning.encrypted_content"]`, and `max_output_tokens` is absent because the backend rejects it. |
| `State`           | interface | What the adapter carries between events: partially assembled tool calls, opened ids, and the response identity a continuation replays.                                                                    |
| `protocol`        | protocol  | Id `openai-responses`. Reasoning continuation by stored item reference.                                                                                                                                   |
| `chatgptProtocol` | protocol  | Id `openai-responses-chatgpt`. The same SSE stream and usage counters, with reasoning continuation carried in `encrypted_content` and deferred tools disabled.                                            |

Lowering specifics: the system prompt joins into `instructions` with
newlines; `reasoningEffort` becomes `reasoning.effort`; an aborted or errored
assistant turn is omitted. Stored reasoning item ids replay as
`item_reference` entries on the API-key protocol, and as whole encrypted
reasoning items on the ChatGPT protocol, where item references would fail.
`response.completed` settles `"stop"` or `"tool-calls"`; `response.incomplete`
settles `"content-filter"` when its reason is `content_filter` and `"length"`
otherwise.

## `OpenAIChatCompletions`

OpenAI Chat Completions request lowering and SSE event handling: the older,
widely cloned OpenAI wire shape that Ollama, Gemini's compatibility layer,
Cerebras, and most other "OpenAI-compatible" servers implement.

| Export                   | Kind        | Behavior                                                                                                                                                                                         |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Body`                   | schema      | The Chat Completions request body. `stream` is always `true` and `stream_options.include_usage` is always set, so usage arrives on the stream.                                                   |
| `ResponseFormat`         | schema      | The `response_format` field that turns on native structured output: a named JSON Schema with a `strict` flag.                                                                                    |
| `StructuredOutput`       | interface   | `{ name, schema, strict? }`. Presence is the toggle: a route built without it leaves schema enforcement to the prompt. `strict` defaults to `true`.                                              |
| `State`                  | interface   | What the adapter carries between chunks: whether the single id-less text part has opened, and the in-flight tool calls keyed by stream position, because a delta only repeats the array `index`. |
| `protocolWith(options?)` | constructor | Builds the protocol, optionally with native structured output. Without the option the lowering is byte-for-byte the historical one, so existing sealed step keys are unchanged.                  |
| `protocol`               | protocol    | `protocolWith()` with structured output off. Id `openai-chat-completions`.                                                                                                                       |

A route configured with `structuredOutput` refuses a request that declares
tools, failing preparation with `invalid_request`, because providers reject
`tools` together with `response_format`. The one exception is
`toolChoice: "none"`: that lowering omits `tools`, so the two fields never
meet on the wire. Finish reasons map `stop`, `length`, `tool_calls`, and
`content_filter` onto the matching stop reasons. A purely numeric provider
code in the HTTP range stands in for a missing status, which is how a gateway
that reports `{"error":{"code":429}}` inside an HTTP 200 stream still
classifies as `rate_limited`.

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

| Export                                  | Kind      | Behavior                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProtocolId`                            | type      | `"anthropic-messages" \| "openai-responses"`.                                                                                                                                                                                                                                                                           |
| `Resolution`                            | interface | `{ immediate, deferred, activatedNames }`: the tool partition derived from a sealed request.                                                                                                                                                                                                                            |
| `supportsDeferred(protocolId, modelId)` | predicate | Answers from explicit per-provider allowlists, matched case-insensitively. An unlisted model, including a family released after this code, answers `false` and receives every tool through the portable lowering, because native deferral changes the wire body and an unverified body must not ship without a release. |
| `resolve(request, native)`              | operation | Derives the partition from declared `deferred` annotations and the chronological transcript only: tool calls made, and `addedToolNames` activations. No process-local state is consulted, so replay produces the identical partition.                                                                                   |

Without native support, deferred tools arrive as ordinary definitions once
activated or once used before their activation. With native support, lazy
tools lower with the provider's defer flag, a `loader` tool stays immediate,
and a partition with no immediate tools collapses to all-immediate.

## `ToolStream`

Pure accumulation of fragmented provider tool-call arguments.

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

## `ModelCatalog`

Static facts about known provider models, read from a model id alone.

| Export                             | Kind     | Behavior                                                                                                                                                                                                              |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextWindowTokensFor(modelId)` | resolver | The context window in tokens, matched case-insensitively against the id. A million-token row is anchored to the bare id, so a cloud-prefixed or suffixed id falls through to the conservative row. Unknown ids answer 128,000, never zero. |

`@smthrs/agent` re-exports this as `SeatResolver.contextWindowTokensFor`, and
the built-in harness calls it for the compaction budget of a seat whose host
supplies no `contextWindowTokensFor` callback of its own.

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
member, or a cycle) is rejected with `TypeError: Value at <path> is not valid
JSON`, because a model request body is sealed-step key material and the key
must describe the bytes sent. Everything both encoders accept they encode
identically, including an own member literally named `__proto__`. The
[`@smthrs/canonical` encoder](https://canonical.smithers.sh/reference/api/) mirrors `JSON.stringify` and is
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
