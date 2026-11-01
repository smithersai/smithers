# @smthrs/model

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.0` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/model/docs

Schema-first Effect model protocols, routes, and streaming events for flows. It
separates provider-neutral model requests from provider framing,
authentication, endpoint selection, transport execution, and event
normalization.

Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, and any server
speaking one of those wire formats reach your code as the same typed
`ModelEvent` values, through one service with one method:
`model.stream(request)`.

## Install

```bash
npm install @smthrs/model@next effect
```

Requirements and import forms are at https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/model/docs/installation.md.

## Example

```ts
import { Model, ModelEvent, ModelRequest, RequestExecutor, Route } from "@smthrs/model"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"

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

`Route.layer` builds the `Model` service from a configured route,
`RequestExecutor.layer` supplies the bounded-retry executor, and any Effect
`HttpClient` layer carries the bytes. `Model.layer(implementation)` replaces the
whole stack with your own provider or a scripted stub, so tests never reach the
network.

## Proxy a model

A browser must not hold a provider key. `ModelProxy.serve` is an `effect/http`
handler whose `prepare` hook applies the host's policy and chooses the `Model`
that answers each request; it streams the events as NDJSON. `attributes` label
its metrics and `onEnd` hands the host each request's usage for metering.
`ModelProxy.layerClient` is a `Model` that calls it, so a browser keeps calling
`model.stream(request)`. Both record spans, metrics and one log line per
request, joined by one request id and one trace. See
https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/model/docs/guides/proxy-a-model.md.

## Public API

The root entry point exports these namespaces. Each is also importable from
`@smthrs/model/<Namespace>`.

- **`AnthropicMessages`**: Anthropic Messages request lowering and streaming event parsing.
  `Body`, `protocol`
- **`Auth`**: Credential handling for a model route: which field names carry secrets, and how a redacted credential is resolved at request time without ever entering the request's canonical, sealed form.
  `credentialNamePattern`, `isCredentialName`, `Redacted`, `Auth`, `apiKeyHeader`, `bearer`
- **`CanonicalJson`**: Deterministic JSON encoding for model-step inputs.
  `stringify`, `bytes`, `shortHash`
- **`Classifier`**: Typed questions about a JSON state, answered by Jev through an `Evaluator`.
  `ClassifierError`, `Question`, `BooleanQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `Questions`, `boolean`, `choice`, `score`, `BooleanAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `AnswerOf`, `AnswersOf`, `Answer`, `decodeAnswers`, `confidence`, `confident`, `EvaluateAllOptions`, `defaultConcurrency`, `Classifier`, `MakeOptions`, `make`
- **`DeferredTools`**: Replay-safe policy for native deferred provider tool loading.
  `ProtocolId`, `Resolution`, `supportsDeferred`, `resolve`
- **`Endpoint`**: The credential-free HTTP target of a model route, and its validation.
  `Endpoint`, `MakeOptions`, `make`, `render`
- **`Evaluator`**: The transport a classifier asks: one JSON state and a map of typed questions go out, one typed raw answer per question comes back.
  `EvaluatorErrorCode`, `EvaluatorError`, `BooleanQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `Question`, `RawBooleanAnswer`, `RawChoiceAnswer`, `RawScoreAnswer`, `RawAnswer`, `RawAnswers`, `Request`, `Usage`, `Response`, `Evaluator`, `defaultBaseUrl`, `defaultModel`, `defaultTimeoutMs`, `defaultAttempts`, `retryBackoffMs`, `protocolVersion`, `specificationVersion`, `VercelGatewayOptions`, `layerVercelGateway`, `layerFromSeat`, `ScriptedAnswer`, `Script`, `layerScripted`, `layerUnavailable`
- **`EvaluatorBackup`**: Use a model as a validated judge and call it only when the primary judge is unreachable or times out.
  `fromModel`, `withFallback`
- **`Framing`**: Byte-stream framing, chosen independently of the protocol that interprets the frames.
  `Framing`, `sse`, `ndjson`
- **`FailureCopy`**: Safe headlines and actions for typed model and harness failures.
  `Fault`, `Action`, `Description`, `provider`, `describe`
- **`Model`**: The one provider seam: a request in, a stream of typed events out.
  `ModelFailure`, `Model`, `make`, `layer`, `makeNoop`, `layerNoop`
- **`ModelCatalog`**: Static facts about known provider models, read from a model id alone.
  `contextWindowTokensFor`
- **`ModelError`**: The provider-neutral failure vocabulary, and the refinements that recognize a context overflow and an exhausted account in a provider's own wording.
  `ModelErrorCode`, `isContextOverflow`, `isQuotaExhausted`, `isTerminalRefusal`, `ModelError`
- **`ModelEvent`**: The normalized events one model call emits, and the fold that turns them back into a single durable assistant message.
  `Usage`, `TextStart`, `TextDelta`, `TextEnd`, `ThinkingStart`, `ThinkingDelta`, `ThinkingEnd`, `ToolCallStart`, `ToolCallDelta`, `ToolCallEnd`, `ToolResult`, `UsageEvent`, `Retry`, `Settle`, `ModelEvent`, `settledMessage`
- **`ModelProxy`**: A `Model` served over HTTP, and a `Model` that reads one served elsewhere.
  `requestIdHeader`, `contentType`, `defaultMaxBodyBytes`, `EndLine`, `ErrorLine`, `Line`, `ErrorBody`, `Refusal`, `requests`, `duration`, `firstEvent`, `tokens`, `Prepared`, `End`, `ServeOptions`, `serve`, `ClientOptions`, `makeClient`, `layerClient`
- **`ModelRequest`**: The serializable, credential-free declaration of one model call.
  `JsonObject`, `StopReason`, `SystemPart`, `TextPart`, `ThinkingPart`, `ToolCallPart`, `ToolResultPart`, `ContentPart`, `AssistantContentPart`, `UserMessage`, `AssistantMessage`, `ToolMessage`, `Message`, `ToolDefinition`, `ReasoningEffort`, `GenerationParams`, `ToolChoice`, `ModelRequest`
- **`OpenAIChatCompletions`**: OpenAI Chat Completions request lowering and SSE event handling.
  `ResponseFormat`, `StructuredOutput`, `Body`, `State`, `protocolWith`, `protocol`
- **`OpenAIChatGPT`**: Route construction for OpenAI's ChatGPT-subscription Responses backend, the deployment the codex CLI speaks.
  `defaultBaseUrl`, `clientHeaders`, `make`
- **`OpenAIResponses`**: OpenAI Responses request lowering and SSE event handling.
  `Body`, `ChatGPTBody`, `State`, `protocol`, `chatgptProtocol`
- **`Pricing`**: USD rate cards from the backend price table and per-call cost.
  `Rates`, `Price`, `Table`, `table`, `CostSource`, `Cost`, `Options`, `lookup`, `weigh`, `costUsd`, `cost`
- **`Protocol`**: The wire contract of a model API family, split from the deployment that serves it.
  `Protocol`, `ProtocolBody`, `ProtocolStream`, `make`, `jsonEvent`
- **`RequestExecutor`**: Executes provider requests with bounded retries, quota classification, and credential-safe diagnostics.
  `ErrorClassifier`, `ExecuteOptions`, `RequestError`, `rebuildAfter`, `defaultResponseStartMs`, `Transport`, `fixed`, `RequestExecutor`, `makeWith`, `make`, `layer`
- **`Route`**: A resolved model route: an endpoint, a protocol, a framing, and the credentials to authorize with.
  `PreparedRequest`, `Config`, `Route`, `prepare`, `make`, `toModel`, `layer`, `anthropic`, `openai`, `openaiResponsesCompatible`, `openaiChatCompatible`
- **`ToolStream`**: Pure accumulation of fragmented provider tool-call arguments.
  `OpenToolCall`, `State`, `Completed`, `EndResult`, `FlushResult`, `initial`, `start`, `delta`, `end`, `flushAborted`

- **`WireTrace`**: Optional credential-free request and response diagnostics.
  `WireTrace`, `layerFileSystem` (requires the host FileSystem); no file writes by default.

`@smthrs/model/package.json` is also exported. The `internal/*` and nested
`*/index` subpaths are blocked.

## Reference

https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/model/docs/api.md documents every export, the failure
vocabulary and its stable codes, the retry ladder, the redaction rules, and the
declared resource limits.

## Testing

`pnpm --filter @smthrs/model test run` uses local fixtures by default. Merely
having provider credentials in the environment does not enable live calls.

Live integration tests consume provider quota and may incur charges. To run
them intentionally, set `SMITHERS_LIVE_MODEL_TESTS=1` and the relevant
`AI_GATEWAY_API_KEY`, `GEMINI_API_KEY`, or `CEREBRAS_API_KEY`, then run
`pnpm --filter @smthrs/model test run test/GeminiChatCompletions.integration.test.ts --coverage.enabled=false`
or the corresponding Cerebras or evaluator test file. Keep credentials out of command
arguments and test output. The live tier is separate from deterministic coverage.

For required Cerebras and Codex subscription evidence, run
`bash packages/smithers/agent/model/scripts/provider-live.sh` from the repository root with
`CEREBRAS_API_KEY` and the selected home's Codex ChatGPT login available.
The runner fails on missing credentials; it never treats skipped tests as evidence.

Gateway evaluations send one request; transient errors return to the durable
caller for retry scheduling. Signed provider endpoints require HTTPS; HTTP is reserved
for localhost and loopback IPs. Public proxy request identities retain their
HTTP, HTTPS or relative URL. Seat and backup evaluators preserve reported
usage on failures and deadlines, with fresh accounting for each Effect run.
